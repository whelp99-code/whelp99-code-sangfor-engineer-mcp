import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LearningStrategyService,
  signLearningApproval,
  type LearningApprovalPayload,
} from '@sangfor/learning-strategy';
import { syncLearningMirrorToPrisma } from '@sangfor/store';
import { StrategyStoreManager } from '@sangfor/learning-strategy';
import { resolveRepoData } from '@sangfor/shared';

/** Public CLI contract for PR-011.  Keep the numeric values stable. */
export const STRATEGY_EXIT = Object.freeze({ success: 0, input: 2, precondition: 3, security: 4, store: 5, capture: 6, partial: 7 });

type Args = Record<string, string | boolean>;

function parse(argv: string[]): { command: string; args: Args } {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...tail] = normalized;
  if (!command) throw new Error('INPUT: a strategy subcommand is required.');
  const args: Args = {};
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index]!;
    if (!token.startsWith('--')) throw new Error(`INPUT: unexpected argument ${token}.`);
    const key = token.slice(2);
    if (!/^[a-z][a-z0-9-]*$/u.test(key) || Object.prototype.hasOwnProperty.call(args, key)) throw new Error(`INPUT: invalid argument ${token}.`);
    const next = tail[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return { command, args };
}

function only(args: Args, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`INPUT: --${key} is not accepted by this command.`);
}

function required(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`INPUT: --${key} is required.`);
  return value;
}

function optional(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`INPUT: --${key} requires a value.`);
  return value;
}

function jsonFile<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { throw new Error(`INPUT: cannot read valid JSON from ${path}.`); }
}

function jsonValue<T>(args: Args, key: string): T {
  return jsonFile<T>(required(args, key));
}

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function exitFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:INPUT|INVALID_INPUT|INVALID_CURSOR|UNKNOWN_FIELD|SECRET_FIELD_FORBIDDEN)/u.test(message)) return STRATEGY_EXIT.input;
  if (/(?:SECRET|APPROVAL|SIGNATURE|NONCE|EVIDENCE_DIGEST|INVALID_PAYLOAD|INVALID_SECRET)/u.test(message)) return STRATEGY_EXIT.security;
  if (/(?:STORE|MIRROR|DATABASE|PRISMA)/u.test(message)) return STRATEGY_EXIT.store;
  if (/(?:CAPTURE|CDP|TRANSPORT)/u.test(message)) return STRATEGY_EXIT.capture;
  if (/(?:CONFLICT|AMBIGUOUS|PARTIAL|UNAVAILABLE|NO_ELIGIBLE)/u.test(message)) return STRATEGY_EXIT.partial;
  if (/(?:RESOLUTION|REVISION_NOT_FOUND|VALIDATION_FAILED|INVALID_TRANSITION|REQUIRED)/u.test(message)) return STRATEGY_EXIT.precondition;
  return STRATEGY_EXIT.precondition;
}

function listRequest(args: Args) {
  only(args, ['strategy-id', 'vendor', 'product', 'firmware-version', 'status', 'cursor', 'limit', 'root']);
  const limit = optional(args, 'limit');
  return {
    ...(optional(args, 'strategy-id') === undefined ? {} : { strategyId: optional(args, 'strategy-id') }),
    ...(optional(args, 'vendor') === undefined ? {} : { vendor: optional(args, 'vendor') as 'SANGFOR' | 'FORTINET' | 'CISCO' }),
    ...(optional(args, 'product') === undefined ? {} : { product: optional(args, 'product') }),
    ...(optional(args, 'firmware-version') === undefined ? {} : { firmwareVersion: optional(args, 'firmware-version') }),
    ...(optional(args, 'status') === undefined ? {} : { status: optional(args, 'status') as never }),
    ...(optional(args, 'cursor') === undefined ? {} : { cursor: optional(args, 'cursor') }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  };
}

export async function runStrategyCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { command, args } = parse(argv);
    const root = optional(args, 'root') ?? process.env.SANGFOR_LEARNING_STRATEGY_ROOT ?? resolveRepoData('data/runtime/learning-strategies');
    const service = new LearningStrategyService(root);
    if (command === 'list') { print(service.list(listRequest(args))); return STRATEGY_EXIT.success; }
    if (command === 'resolve') {
      only(args, ['scope', 'context', 'root']);
      print(service.resolve(jsonValue(args, 'scope'), jsonValue(args, 'context'))); return STRATEGY_EXIT.success;
    }
    if (command === 'research') { only(args, ['request', 'root']); print(service.research(jsonValue(args, 'request'))); return STRATEGY_EXIT.success; }
    if (command === 'validate') { only(args, ['request', 'root']); print(service.validate(jsonValue(args, 'request'))); return STRATEGY_EXIT.success; }
    if (command === 'approval-payload') {
      only(args, ['input']);
      // Canonicalization and field validation occur again when the signer is invoked.
      print(jsonValue<LearningApprovalPayload>(args, 'input')); return STRATEGY_EXIT.success;
    }
    if (command === 'approval-sign') {
      only(args, ['payload', 'out']);
      const payload = jsonValue<LearningApprovalPayload>(args, 'payload');
      const output = required(args, 'out');
      // The signing secret is deliberately accepted only through the protected env var.
      // Never add an argv flag or a diagnostic containing this value.
      const approvalToken = signLearningApproval(payload);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(output, `${JSON.stringify({ payload, approvalToken })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(output, 0o600);
      return STRATEGY_EXIT.success;
    }
    if (command === 'promote') { only(args, ['request', 'root']); print(service.promote(jsonValue(args, 'request'))); return STRATEGY_EXIT.success; }
    if (command === 'audit') {
      only(args, ['strategy-id', 'root']);
      print(service.list(optional(args, 'strategy-id') ? { strategyId: optional(args, 'strategy-id') } : {})); return STRATEGY_EXIT.success;
    }
    if (command === 'mirror-sync') {
      only(args, ['strategy-id', 'root']);
      const strategyId = required(args, 'strategy-id');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(strategyId)) throw new Error('INPUT: --strategy-id is invalid.');
      print(await syncLearningMirrorToPrisma(new StrategyStoreManager(join(root, `${strategyId}.json`)))); return STRATEGY_EXIT.success;
    }
    throw new Error(`INPUT: unsupported strategy subcommand ${command}.`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return exitFor(error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runStrategyCli().then((code) => { process.exitCode = code; });
