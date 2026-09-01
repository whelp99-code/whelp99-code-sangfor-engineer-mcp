import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { BrowserExecutionPort } from '../../../packages/sangfor-browser-contracts/src/index.js';
import type { JsonSchemaObject } from './mcp-contracts.js';
import type { ResolveIagMutationActionAuthorityInput } from '../../../packages/sangfor-competency/src/index.js';
import {
  createIagExecutor,
  createIagOrchestrator,
  dryRunIagMutation,
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
type LoadedToolConfig = { readonly config: LoadedConfig; readonly root: string };

function confinedPath(root: string, path: string, kind: 'file' | 'directory'): string {
  const absolute = resolve(path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError('IAG_TOOL_PATH_REFUSED');
  }
  const lexical = lstatSync(absolute);
  if (lexical.isSymbolicLink() || (kind === 'file' ? !lexical.isFile() : !lexical.isDirectory())
    || realpathSync(absolute) !== absolute) throw new TypeError('IAG_TOOL_PATH_REFUSED');
  return absolute;
}

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
  private readonly executor;

  constructor(private readonly dependencies: IagToolDependencies) {
    this.executor = createIagExecutor(dependencies);
  }

  private loadConfig(path: string): LoadedToolConfig {
    const requestedConfigPath = resolve(path);
    const requestedConfigStat = lstatSync(requestedConfigPath);
    if (!requestedConfigStat.isFile() || requestedConfigStat.isSymbolicLink()) {
      throw new TypeError('IAG_TOOL_PATH_REFUSED');
    }
    const configPath = realpathSync(requestedConfigPath);
    const root = dirname(configPath);
    const config = configSchema.parse(readReference(configPath));
    const references = config.authority.references;
    confinedPath(root, references.manifestPath, 'file');
    confinedPath(root, references.validationContextPath, 'file');
    confinedPath(root, references.evidenceRoot, 'directory');
    confinedPath(root, references.ledgerPath, 'file');
    return { config, root };
  }

  private store(loaded: LoadedToolConfig): FileIagOrchestratorStore {
    const ledgerPath = confinedPath(loaded.root, loaded.config.orchestrator.ledgerPath, 'file');
    return FileIagOrchestratorStore.open({
      ledgerPath,
      ledgerSecret: secret('SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET'),
      checkpointSecret: secret('SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET'),
      now: this.dependencies.now,
    });
  }

  private orchestrator(configPath: string, loaded: LoadedToolConfig): IagOrchestrator {
    const config = loaded.config;
    const key = [
      configPath, JSON.stringify(config),
      secret('SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET'),
      secret('SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET'),
    ].join('\0');
    const cached = this.orchestrators.get(key);
    if (cached !== undefined) return cached;
    const orchestrator = createIagOrchestrator({
      executor: this.executor,
      store: this.store(loaded),
      now: this.dependencies.now,
    });
    this.orchestrators.set(key, orchestrator);
    return orchestrator;
  }

  async dryRun(input: unknown) {
    const parsed = executionInputSchema.parse(input);
    if (parsed.approvalEnvelopePath !== undefined) throw new TypeError('IAG_DRY_RUN_APPROVAL_REFUSED');
    const loaded = this.loadConfig(parsed.configPath);
    const actionSource = readSource(confinedPath(loaded.root, parsed.actionPath, 'file'));
    if (!actionModeSchema.parse(JSON.parse(actionSource)).dryRun) throw new TypeError('IAG_DRY_RUN_ACTION_REQUIRED');
    return dryRunIagMutation({
      executor: this.executor,
      request: {
        actionSource,
        authorityRequest: authorityRequest(loaded.config, this.dependencies.now()),
      },
    });
  }

  async apply(input: unknown) {
    const parsed = executionInputSchema.required({ approvalEnvelopePath: true }).parse(input);
    const loaded = this.loadConfig(parsed.configPath);
    const actionSource = readSource(confinedPath(loaded.root, parsed.actionPath, 'file'));
    if (actionModeSchema.parse(JSON.parse(actionSource)).dryRun) throw new TypeError('IAG_APPLY_NON_DRY_RUN_ACTION_REQUIRED');
    return this.orchestrator(parsed.configPath, loaded).execute({
      actionSource,
      authorityRequest: authorityRequest(loaded.config, this.dependencies.now()),
      approval: readReference(confinedPath(loaded.root, parsed.approvalEnvelopePath, 'file')),
      ordinaryAuthorityRequired: true,
    });
  }

  status(input: unknown) {
    const parsed = statusInputSchema.parse(input);
    return lookupIagRunStatus(this.store(this.loadConfig(parsed.configPath)), parsed.runId);
  }
}

let configuredService: IagOrchestratorToolService | undefined;

export function configureIagOrchestratorToolService(service: IagOrchestratorToolService | undefined): void {
  configuredService = service;
}

export function iagOrchestratorToolCatalog(
  requiredPorts: () => {
    readonly executionPort: BrowserExecutionPort;
    readonly readBackPort: BrowserExecutionPort;
  },
): Record<string, { readonly description: string; readonly inputSchema: JsonSchemaObject; readonly handler: (input: unknown) => unknown }> {
  const service = (): IagOrchestratorToolService => {
    if (configuredService !== undefined) return configuredService;
    const ports = requiredPorts();
    configuredService = new IagOrchestratorToolService({
      ...ports,
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
