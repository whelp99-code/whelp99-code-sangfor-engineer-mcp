import { lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { captureKeyringFromEnv, promoteCapturePayload, readCaptureBundle, readCapturePayload } from '@sangfor/collector';

/** Public CLI contract for PR-011.  Keep the numeric values stable. */
export const OBSERVE_EXIT = Object.freeze({ success: 0, input: 2, precondition: 3, security: 4, store: 5, capture: 6, partial: 7 });
type Args = Record<string, string | boolean>;

function parse(argv: string[]): { command: string; args: Args } {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...tail] = normalized;
  if (!command) throw new Error('INPUT: an observe subcommand is required.');
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
function only(args: Args, allowed: readonly string[]): void { for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`INPUT: --${key} is not accepted by this command.`); }
function required(args: Args, key: string): string { const value = args[key]; if (typeof value !== 'string' || value.length === 0) throw new Error(`INPUT: --${key} is required.`); return value; }
function optional(args: Args, key: string): string | undefined { const value = args[key]; if (value === undefined) return undefined; if (typeof value !== 'string') throw new Error(`INPUT: --${key} requires a value.`); return value; }
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function captureRoot(): string { return resolve(process.env.SANGFOR_CAPTURE_ROOT ?? 'data/captures'); }
function confined(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel !== '' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel); }
function exitFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:INPUT|INVALID)/u.test(message)) return OBSERVE_EXIT.input;
  if (/(?:KEYRING|REDACTION|SECRET|SECURITY)/u.test(message)) return OBSERVE_EXIT.security;
  if (/(?:CAPTURE|CDP|OBSERVER|TRANSPORT)/u.test(message)) return OBSERVE_EXIT.capture;
  if (/(?:PARTIAL|CONFLICT|UNAVAILABLE)/u.test(message)) return OBSERVE_EXIT.partial;
  return OBSERVE_EXIT.precondition;
}

function purgeCandidates(root: string, before: Date): Array<{ path: string; capturedAt: string }> {
  try {
    return readdirSync(root).sort().flatMap((name) => {
      if (!name.endsWith('.enc')) return [];
      const path = resolve(root, name);
      if (!confined(root, path)) return [];
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      const bundle = readCaptureBundle(path);
      if (!bundle || Date.parse(bundle.metadata.capturedAt) >= before.getTime()) return [];
      return [{ path, capturedAt: bundle.metadata.capturedAt }];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function runObserveCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { command, args } = parse(argv);
    if (command === 'capture') {
      only(args, ['fixture', 'device-scope', 'product', 'firmware-version', 'retention-ms']);
      const fixture = required(args, 'fixture');
      let payload: unknown;
      try { payload = JSON.parse(readFileSync(fixture, 'utf8')); } catch { throw new Error(`INPUT: cannot read valid JSON fixture ${fixture}.`); }
      const retention = optional(args, 'retention-ms');
      print(promoteCapturePayload({
        payload,
        deviceScope: required(args, 'device-scope'),
        product: required(args, 'product'),
        ...(optional(args, 'firmware-version') === undefined ? {} : { firmwareVersion: optional(args, 'firmware-version') }),
        capturesDir: captureRoot(),
        stagingRoot: process.env.SANGFOR_CAPTURE_STAGING_ROOT ?? 'data/runtime/learning-captures',
        keyring: captureKeyringFromEnv(),
        ...(retention === undefined ? {} : { retentionMs: Number(retention) }),
      }));
      return OBSERVE_EXIT.success;
    }
    if (command === 'collect') {
      only(args, ['bundle']);
      const bundle = required(args, 'bundle');
      if (!confined(captureRoot(), resolve(bundle))) throw new Error('INPUT: --bundle must be inside the configured capture root.');
      const value = readCapturePayload(bundle, captureKeyringFromEnv());
      print(value); return OBSERVE_EXIT.success;
    }
    if (command === 'purge') {
      only(args, ['execute', 'before']);
      const beforeText = required(args, 'before');
      const before = new Date(beforeText);
      if (!Number.isFinite(before.getTime()) || before.toISOString() !== beforeText) throw new Error('INPUT: --before must be a canonical ISO timestamp.');
      const root = captureRoot();
      const candidates = purgeCandidates(root, before);
      const execute = args.execute === true;
      if (args.execute !== undefined && args.execute !== true) throw new Error('INPUT: --execute does not accept a value.');
      if (execute) {
        for (const candidate of candidates) {
          if (!confined(root, candidate.path) || !statSync(candidate.path).isFile()) throw new Error('CAPTURE_PURGE_REFUSED: candidate is not a regular file under the exact capture root.');
          rmSync(candidate.path, { force: false });
        }
      }
      print({ dryRun: !execute, root, before: before.toISOString(), candidates: candidates.map((candidate) => candidate.path), removed: execute ? candidates.length : 0 });
      return OBSERVE_EXIT.success;
    }
    throw new Error(`INPUT: unsupported observe subcommand ${command}.`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return exitFor(error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runObserveCli().then((code) => { process.exitCode = code; });
