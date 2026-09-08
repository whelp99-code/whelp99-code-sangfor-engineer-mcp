// Shared runtime for the BLRO backup and restore-drill CLIs: argument parsing, credential-free
// connection handling, pg tool invocation, and the scratch-target safety contract.
//
// Credentials live in exactly two places: the parsed URL object held in this frame, and the child
// process environment handed to a pg tool. They are never formatted into a message, a manifest, a
// receipt, or a log line — `redactTarget` is the only permitted rendering of a connection.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const SCRATCH_DATABASE_PREFIX = 'blro_scratch_';
export const BACKUP_VERIFICATION_DATABASE_PREFIX = 'blro_scratch_backup_verify_';
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost']);

export class BlroRuntimeError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BlroRuntimeError';
    this.code = code;
  }
}

/** Strict long-flag parser: unknown flags, duplicates and missing values all refuse. */
export function parseFlags(argv, valueFlags, booleanFlags) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (booleanFlags.includes(argument)) {
      if (flags.has(argument)) throw new BlroRuntimeError('BLRO_CLI_DUPLICATE_ARGUMENT', argument);
      flags.add(argument);
      continue;
    }
    if (valueFlags.includes(argument)) {
      if (values.has(argument)) throw new BlroRuntimeError('BLRO_CLI_DUPLICATE_ARGUMENT', argument);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new BlroRuntimeError('BLRO_CLI_VALUE_REQUIRED', argument);
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new BlroRuntimeError('BLRO_CLI_UNKNOWN_ARGUMENT', argument);
  }
  return { values, flags };
}

/** Parse a PostgreSQL URL into connection parts. The password stays on the object, never in text. */
export function parseConnection(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlroRuntimeError('BLRO_CONNECTION_UNPARSABLE', label);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new BlroRuntimeError('BLRO_CONNECTION_SCHEME_REFUSED', label);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (database === '') throw new BlroRuntimeError('BLRO_CONNECTION_DATABASE_REQUIRED', label);
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? '5432' : parsed.port,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

/** The only permitted rendering of a connection: host, port and database, never user or password. */
export function redactTarget(connection) {
  return `${connection.host}:${connection.port}/${connection.database}`;
}

export function connectionUrl(connection, database = connection.database) {
  const auth = `${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}`;
  return `postgresql://${auth}@${connection.host}:${connection.port}/${encodeURIComponent(database)}`;
}

/**
 * The scratch-target contract. A drill may only ever create and destroy a database whose name
 * carries the reserved prefix, on a loopback host, that is not the source.
 */
export function assertScratchTarget(target, source) {
  if (!LOOPBACK_HOSTS.includes(target.host)) {
    throw new BlroRuntimeError('BLRO_DRILL_TARGET_NOT_LOOPBACK', target.host);
  }
  if (!target.database.startsWith(SCRATCH_DATABASE_PREFIX)) {
    throw new BlroRuntimeError('BLRO_DRILL_TARGET_NOT_SCRATCH', target.database);
  }
  if (target.host === source.host && target.port === source.port && target.database === source.database) {
    throw new BlroRuntimeError('BLRO_DRILL_TARGET_EQUALS_SOURCE', redactTarget(target));
  }
  return target;
}

/** Backup publication gets a narrower namespace and the exact local admin identity that owns it. */
export function assertBackupVerificationTarget(target, source, admin) {
  assertScratchTarget(target, source);
  if (!target.database.startsWith(BACKUP_VERIFICATION_DATABASE_PREFIX)) {
    throw new BlroRuntimeError('BLRO_BACKUP_VERIFICATION_TARGET_NOT_RESERVED', target.database);
  }
  if (!/^[a-zA-Z0-9_]+$/u.test(target.database)) {
    throw new BlroRuntimeError('BLRO_BACKUP_VERIFICATION_TARGET_NAME_REFUSED', target.database);
  }
  const sameAdmin = target.host === admin.host && target.port === admin.port
    && target.user === admin.user && target.password === admin.password;
  if (!sameAdmin || target.database === admin.database) {
    throw new BlroRuntimeError('BLRO_BACKUP_VERIFICATION_ADMIN_MISMATCH');
  }
  return target;
}

/** Reject traversal and symlink escapes for any path the drill reads or writes. */
export function assertContainedPath(candidate, root, label) {
  if (candidate.includes('\0')) throw new BlroRuntimeError('BLRO_PATH_NUL_REFUSED', label);
  const absoluteRoot = realpathSync(root);
  const absolute = isAbsolute(candidate) ? candidate : resolve(absoluteRoot, candidate);
  let real;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new BlroRuntimeError('BLRO_PATH_UNRESOLVABLE', label);
  }
  if (real !== absoluteRoot && !real.startsWith(`${absoluteRoot}/`)) {
    throw new BlroRuntimeError('BLRO_PATH_ESCAPES_ROOT', label);
  }
  return real;
}

/**
 * Invoke a PostgreSQL client tool. The password is passed via PGPASSWORD in the child environment
 * only; the command line carries no credential, so it never reaches ps, logs, or an error message.
 */
export function runPgTool(tool, connection, args, options = {}) {
  const result = spawnSync(tool, [
    '--host', connection.host, '--port', connection.port, '--username', connection.user, ...args,
  ], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: connection.password, PGCONNECT_TIMEOUT: '10' },
    ...options,
  });
  if (result.error) throw new BlroRuntimeError('BLRO_PG_TOOL_UNAVAILABLE', `${tool}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new BlroRuntimeError('BLRO_PG_TOOL_FAILED', `${tool} exit ${result.status}: ${scrub(`${result.stderr}`).trim()}`);
  }
  return result.stdout;
}

/**
 * Read the archive's own table of contents. This is a file operation, not a connection: a dump
 * that pg_restore cannot list is not readable, whatever its bytes claim.
 */
export function listDumpTables(dumpPath) {
  const result = spawnSync('pg_restore', ['--list', dumpPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new BlroRuntimeError('BLRO_PG_TOOL_UNAVAILABLE', `pg_restore: ${result.error.message}`);
  if (result.status !== 0) {
    throw new BlroRuntimeError('BLRO_BACKUP_DUMP_UNREADABLE', scrub(`${result.stderr}`).trim());
  }
  return new Set(result.stdout.split('\n')
    .map((line) => /^\d+;\s+\d+\s+\d+\s+TABLE DATA\s+\S+\s+(\S+)\s/u.exec(line)?.[1])
    .filter((table) => table !== undefined));
}

/** Defence in depth: strip anything password-shaped from tool output before it is surfaced. */
export function scrub(text) {
  return text
    .replaceAll(/postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/giu, 'postgresql://<redacted>@')
    .replaceAll(/password=\S+/giu, 'password=<redacted>');
}

export function monotonicNowMs() {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1000 + nanoseconds / 1e6;
}
