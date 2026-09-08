import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorityStorePersistenceError,
  LOCAL_WRITER_REFS,
  writeLocalSafetyMarker,
} from '../../packages/sangfor-authority/src/index.js';
import {
  explicitLocalPrimaryAuthority,
  type LocalWriteAuthority,
  type LocalWriteFencePort,
} from '../../packages/shared/src/index.js';
import { localWriterRefusalCases } from '../helpers/local-writer-refusal-cases.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function snapshot(root: string): Readonly<Record<string, string>> {
  return Object.fromEntries(readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => statSync(join(root, path)).isFile())
    .map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
}

class UnavailablePostgresFence implements LocalWriteFencePort {
  readonly authorityKind = 'postgres' as const;
  async write<T>(): Promise<T> {
    throw new AuthorityStorePersistenceError('STORE_UNAVAILABLE', { cause: new Error('test database unavailable') });
  }
}

function postgresAuthority(aggregate: string, sourceRoot: string): LocalWriteAuthority {
  mkdirSync(sourceRoot, { recursive: true });
  return {
    tenantId: 'writer-tenant', projectId: 'writer-project', actorId: 'writer-actor',
    aggregate, sourceRoot, epoch: 7, fence: new UnavailablePostgresFence(),
  };
}

describe('Todo 24 exhaustive local writer refusal', () => {
  it('Given PostgreSQL mode with an unavailable database, When all 22 public writer symbols run, Then each returns typed refusal before bytes', async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'writer-postgres-unavailable-'));
    roots.push(root);
    const cases = await localWriterRefusalCases(root, postgresAuthority);
    expect(cases.map(({ reference }) => reference).sort()).toEqual([...LOCAL_WRITER_REFS].sort());
    const before = snapshot(root);

    // When / Then
    for (const writer of cases) {
      let refusal: unknown;
      try { await writer.invoke(); } catch (error) { refusal = error; }
      expect(refusal, writer.reference).toMatchObject({ code: 'STORE_UNAVAILABLE' });
      expect(snapshot(root), writer.reference).toEqual(before);
    }
  });

  it('Given durable FROZEN or POSTGRES_PRIMARY markers, When all 22 public writer symbols run, Then each refuses before bytes', async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'writer-marker-refusal-'));
    roots.push(root);
    const authorities: LocalWriteAuthority[] = [];
    const cases = await localWriterRefusalCases(root, (aggregate, sourceRoot) => {
      mkdirSync(sourceRoot, { recursive: true });
      const authority = explicitLocalPrimaryAuthority({
        tenantId: 'writer-tenant', projectId: 'writer-project', actorId: 'writer-actor', aggregate, sourceRoot,
      });
      authorities.push(authority);
      return authority;
    });
    for (const [index, authority] of [...new Map(authorities.map((item) => [`${item.aggregate}:${item.sourceRoot}`, item])).values()].entries()) {
      writeLocalSafetyMarker({
        ...authority,
        epoch: index % 2 === 0 ? 7 : 8,
        sourceDigest: 'a'.repeat(64), targetDigest: 'a'.repeat(64),
        highWaterMark: index % 2 === 0 ? 'FROZEN' : 'POSTGRES_PRIMARY',
        fencedAt: '2026-08-27T00:00:00.000Z',
      });
    }
    const before = snapshot(root);

    // When / Then
    for (const writer of cases) {
      let refusal: unknown;
      try { await writer.invoke(); } catch (error) { refusal = error; }
      expect(refusal, writer.reference).toMatchObject({ message: 'LOCAL_AUTHORITY_WRITE_FENCED' });
      expect(snapshot(root), writer.reference).toEqual(before);
    }
  });
});
