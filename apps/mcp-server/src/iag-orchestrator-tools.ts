import { readFileSync } from 'node:fs';
import type { BrowserExecutionPort } from '../../../packages/sangfor-browser-contracts/src/index.js';
import type { ResolveIagMutationActionAuthorityInput } from '../../../packages/sangfor-competency/src/index.js';
import {
  createIagExecutor,
  createIagOrchestrator,
  FileIagOrchestratorStore,
  lookupIagRunStatus,
  type IagOrchestrator,
} from '../../../packages/sangfor-product-adapters/src/apply/index.js';
import { z } from 'zod';

const MAX_REFERENCE_BYTES = 1_048_576;
const pathSchema = z.string().min(1).max(4096);
const authorityReferencesSchema = z.object({
  manifestPath: pathSchema,
  validationContextPath: pathSchema,
  evidenceRoot: pathSchema,
  ledgerPath: pathSchema,
}).strict();
const configSchema = z.object({
  schemaVersion: z.literal('iag-mcp-config.v1'),
  authority: z.object({
    references: authorityReferencesSchema,
    origin: z.string().min(1).max(2048),
    allowedUrlDomains: z.array(z.string().min(1).max(253)).max(100),
    allowedApplicationIds: z.array(z.string().min(1).max(128)).max(100),
    firmwareFreshness: z.object({
      maxAgeMs: z.number().int().positive().safe(),
      maxFutureSkewMs: z.number().int().nonnegative().safe(),
    }).strict(),
  }).strict(),
  orchestrator: z.object({ ledgerPath: pathSchema }).strict(),
}).strict().readonly();
const actionModeSchema = z.object({ dryRun: z.boolean() }).passthrough();
const executionInputSchema = z.object({
  actionPath: pathSchema,
  configPath: pathSchema,
  approvalEnvelopePath: pathSchema.optional(),
}).strict();
const statusInputSchema = z.object({ configPath: pathSchema, runId: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

type IagToolDependencies = {
  readonly executionPort: BrowserExecutionPort;
  readonly readBackPort: BrowserExecutionPort;
  readonly now: () => Date;
};

type LoadedConfig = z.infer<typeof configSchema>;

function readSource(path: string): string {
  const source = readFileSync(path, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > MAX_REFERENCE_BYTES) throw new TypeError('IAG_TOOL_REFERENCE_TOO_LARGE');
  return source;
}

function readReference(path: string): unknown {
  return JSON.parse(readSource(path));
}

function secret(name: 'SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET' | 'SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET'): string {
  const value = process.env[name];
  if (value === undefined || value.length < 32) throw new TypeError(`IAG_TOOL_CONFIG_MISSING:${name}`);
  return value;
}

function authorityRequest(config: LoadedConfig, now: Date): ResolveIagMutationActionAuthorityInput {
  return { ...config.authority, now };
}

export class IagOrchestratorToolService {
  private readonly orchestrators = new Map<string, IagOrchestrator>();
  constructor(private readonly dependencies: IagToolDependencies) {}

  private loadConfig(path: string): LoadedConfig {
    return configSchema.parse(readReference(path));
  }

  private store(config: LoadedConfig, create: boolean): FileIagOrchestratorStore {
    const input = {
      ledgerPath: config.orchestrator.ledgerPath,
      ledgerSecret: secret('SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET'),
      checkpointSecret: secret('SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET'),
      now: this.dependencies.now,
    };
    return create ? FileIagOrchestratorStore.initialize(input) : FileIagOrchestratorStore.open(input);
  }

  private orchestrator(configPath: string, config: LoadedConfig): IagOrchestrator {
    const key = [
      configPath, JSON.stringify(config),
      secret('SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET'),
      secret('SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET'),
    ].join('\0');
    const cached = this.orchestrators.get(key);
    if (cached !== undefined) return cached;
    const orchestrator = createIagOrchestrator({
      executor: createIagExecutor({ ...this.dependencies }),
      store: this.store(config, true),
      now: this.dependencies.now,
    });
    this.orchestrators.set(key, orchestrator);
    return orchestrator;
  }

  async dryRun(input: unknown) {
    const parsed = executionInputSchema.parse(input);
    if (parsed.approvalEnvelopePath !== undefined) throw new TypeError('IAG_DRY_RUN_APPROVAL_REFUSED');
    const actionSource = readSource(parsed.actionPath);
    if (!actionModeSchema.parse(JSON.parse(actionSource)).dryRun) throw new TypeError('IAG_DRY_RUN_ACTION_REQUIRED');
    const config = this.loadConfig(parsed.configPath);
    return this.orchestrator(parsed.configPath, config).execute({
      actionSource,
      authorityRequest: authorityRequest(config, this.dependencies.now()),
    });
  }

  async apply(input: unknown) {
    const parsed = executionInputSchema.required({ approvalEnvelopePath: true }).parse(input);
    const actionSource = readSource(parsed.actionPath);
    if (actionModeSchema.parse(JSON.parse(actionSource)).dryRun) throw new TypeError('IAG_APPLY_NON_DRY_RUN_ACTION_REQUIRED');
    const config = this.loadConfig(parsed.configPath);
    return this.orchestrator(parsed.configPath, config).execute({
      actionSource,
      authorityRequest: authorityRequest(config, this.dependencies.now()),
      approval: readReference(parsed.approvalEnvelopePath),
      ordinaryAuthorityRequired: true,
    });
  }

  status(input: unknown) {
    const parsed = statusInputSchema.parse(input);
    return lookupIagRunStatus(this.store(this.loadConfig(parsed.configPath), false), parsed.runId);
  }
}

let configuredService: IagOrchestratorToolService | undefined;

export function configureIagOrchestratorToolService(service: IagOrchestratorToolService | undefined): void {
  configuredService = service;
}

export function iagOrchestratorToolCatalog(
  requiredPort: () => BrowserExecutionPort,
): Record<string, { readonly description: string; readonly inputSchema: object; readonly handler: (input: unknown) => unknown }> {
  const service = (): IagOrchestratorToolService => {
    if (configuredService !== undefined) return configuredService;
    const port = requiredPort();
    configuredService = new IagOrchestratorToolService({
      executionPort: { execute: (request, options) => port.execute(request, options) },
      readBackPort: { execute: (request, options) => port.execute(request, options) },
      now: () => new Date(),
    });
    return configuredService;
  };
  return {
    sangfor_iag_exception_dry_run: {
      description: 'Read-only preflight for one narrow IAG internet-policy exception through the verified orchestrator. Accepts file references only and never dispatches.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { actionPath: { type: 'string' }, configPath: { type: 'string' } },
        required: ['actionPath', 'configPath'],
      },
      handler: (input) => service().dryRun(input),
    },
    sangfor_iag_exception_apply: {
      description: 'Apply one ordinary-authority, narrow reversible IAG internet-policy exception and report success only after independent read-back.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          actionPath: { type: 'string' }, configPath: { type: 'string' },
          approvalEnvelopePath: { type: 'string' },
        },
        required: ['actionPath', 'configPath', 'approvalEnvelopePath'],
      },
      handler: (input) => service().apply(input),
    },
    sangfor_iag_exception_status: {
      description: 'Read-only authenticated lookup of a verified IAG orchestrator run. Never dispatches, retries, repairs, or consumes approval.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { configPath: { type: 'string' }, runId: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
        required: ['configPath', 'runId'],
      },
      handler: (input) => service().status(input),
    },
  };
}
