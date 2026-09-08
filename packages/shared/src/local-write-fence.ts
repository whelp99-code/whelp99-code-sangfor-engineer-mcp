import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export type LocalWriteScope = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly aggregate: string;
  readonly epoch: number;
  readonly sourceRoot: string;
};
export type LocalWriteIntent = {
  readonly writeId: string;
  readonly operationDigest: string;
  readonly targetPaths: readonly string[];
};
export type LocalWriteIntentInput = {
  readonly operation: string;
  readonly targetPaths: readonly string[];
  readonly writeId?: string;
};
export interface LocalWriteFencePort {
  readonly authorityKind?: 'local' | 'postgres';
  write<T>(scope: LocalWriteScope, intent: LocalWriteIntentInput, writeBytes: () => T | Promise<T>): Promise<T>;
}
export type LocalWriteAuthority = LocalWriteScope & { readonly fence: LocalWriteFencePort };
export type LocalWriteExpectedScope = Omit<LocalWriteScope, 'epoch'>;

const canonicalRoot = (value: string): string => resolve(value);
export const localSafetyMarkerPath = (scope: Pick<LocalWriteScope, 'sourceRoot'>): string =>
  resolve(scope.sourceRoot, '.blro-authority', 'owner.frozen.json');

export function localSourceRootIdentity(sourceRoot: string): { sourceRoot: string; sourceDevice: string; sourceInode: string } {
  const root = realpathSync(sourceRoot); const stat = statSync(root, { bigint: true });
  if (!stat.isDirectory()) throw new Error('LOCAL_SOURCE_ROOT_INVALID');
  return { sourceRoot: root, sourceDevice: String(stat.dev), sourceInode: String(stat.ino) };
}

export function assertNoLocalSafetyMarker(scope: LocalWriteScope): void {
  const marker = localSafetyMarkerPath(scope);
  if (!existsSync(marker)) return;
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('LOCAL_AUTHORITY_MARKER_INVALID');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(marker, 'utf8')); } catch { throw new Error('LOCAL_AUTHORITY_MARKER_INVALID'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('LOCAL_AUTHORITY_MARKER_INVALID');
  const value = raw as Readonly<Record<string, unknown>>;
  const identity = localSourceRootIdentity(scope.sourceRoot);
  if (value['tenantId'] !== scope.tenantId || value['projectId'] !== scope.projectId
    || value['aggregate'] !== scope.aggregate || value['sourceRoot'] !== identity.sourceRoot
    || value['sourceDevice'] !== identity.sourceDevice || value['sourceInode'] !== identity.sourceInode) {
    throw new Error('LOCAL_AUTHORITY_MARKER_INVALID');
  }
  throw new Error('LOCAL_AUTHORITY_WRITE_FENCED');
}

export function normalizeLocalWriteIntent(scope: LocalWriteScope, input: LocalWriteIntentInput): LocalWriteIntent {
  if (!input.operation.trim() || input.targetPaths.length === 0) throw new Error('LOCAL_WRITE_INTENT_INVALID');
  const root = canonicalRoot(scope.sourceRoot);
  const targets = [...new Set(input.targetPaths.map((path) => resolve(path)))].sort();
  for (const target of targets) {
    const within = relative(root, target);
    if (within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) {
      throw new Error('LOCAL_WRITE_TARGET_OUTSIDE_SOURCE_ROOT');
    }
  }
  const operationDigest = createHash('sha256').update(JSON.stringify({
    tenantId: scope.tenantId, projectId: scope.projectId, actorId: scope.actorId,
    aggregate: scope.aggregate, epoch: scope.epoch, sourceRoot: root,
    operation: input.operation, targetPaths: targets,
  })).digest('hex');
  return { writeId: input.writeId ?? randomUUID(), operationDigest, targetPaths: targets };
}

class ExplicitLocalPrimaryFence implements LocalWriteFencePort {
  readonly authorityKind = 'local' as const;
  async write<T>(scope: LocalWriteScope, intent: LocalWriteIntentInput, writeBytes: () => T | Promise<T>): Promise<T> {
    assertNoLocalSafetyMarker(scope);
    normalizeLocalWriteIntent(scope, intent);
    return writeBytes();
  }
}

export function explicitLocalPrimaryAuthority(scope: Omit<LocalWriteScope, 'epoch'>): LocalWriteAuthority {
  return { ...scope, sourceRoot: canonicalRoot(scope.sourceRoot), epoch: 0, fence: new ExplicitLocalPrimaryFence() };
}

export function resolveProductionLocalWriteAuthority(
  scope: Omit<LocalWriteScope, 'epoch'>, injected?: LocalWriteAuthority,
  selector: string | undefined = process.env.SANGFOR_BLRO_AUTHORITY_STORE,
): LocalWriteAuthority {
  if (selector === 'local') return injected ?? explicitLocalPrimaryAuthority(scope);
  if (selector === 'postgres' && injected?.fence.authorityKind === 'postgres') return injected;
  throw new Error(selector === 'postgres' ? 'POSTGRES_AUTHORITY_FENCE_REQUIRED' : 'LOCAL_AUTHORITY_MODE_REQUIRED');
}

export function expectedLocalWriteScope(
  authority: LocalWriteAuthority | undefined,
  projectId: string,
  aggregate: string,
  sourceRoot: string,
): LocalWriteExpectedScope {
  if (!authority) throw new Error('LOCAL_AUTHORITY_FENCE_REQUIRED');
  return {
    tenantId: authority.tenantId, projectId, actorId: authority.actorId,
    aggregate, sourceRoot,
  };
}

export function requireLocalWriteAuthority(
  authority: LocalWriteAuthority | undefined,
  expected: LocalWriteExpectedScope,
): LocalWriteAuthority {
  if (!authority) throw new Error('LOCAL_AUTHORITY_FENCE_REQUIRED');
  const actualRoot = canonicalRoot(authority.sourceRoot); const expectedRoot = canonicalRoot(expected.sourceRoot);
  if (authority.tenantId !== expected.tenantId || authority.projectId !== expected.projectId
    || authority.actorId !== expected.actorId || authority.aggregate !== expected.aggregate || actualRoot !== expectedRoot) {
    throw new Error('LOCAL_AUTHORITY_SCOPE_MISMATCH');
  }
  assertNoLocalSafetyMarker({ ...authority, sourceRoot: actualRoot });
  return { ...authority, sourceRoot: actualRoot };
}
