import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyRing, publicKeyDigest } from '../packages/sangfor-jm-agent/src/index.js';
import {
  CURRENT_KEY_ID,
  createJmSigningMaterial,
  readKeyRing,
  type JmSigningMaterial,
} from './helpers/jm-agent-fixture.js';

let root: string;
let signing: JmSigningMaterial;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-'));
  signing = createJmSigningMaterial(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('bounded verification key ring', () => {
  const now = new Date();

  it('resolves the current key and reports its digest', () => {
    const ring = KeyRing.load(readKeyRing(signing.keyRingPath));
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;

    const resolved = ring.ring.resolve(CURRENT_KEY_ID, now);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.digest).toBe(publicKeyDigest(signing.currentPublicKeyPem));
  });

  it('refuses unknown, stale, future and extra keys', () => {
    const ring = KeyRing.load(readKeyRing(signing.keyRingPath));
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;
    expect(ring.ring.resolve('nope', now)).toMatchObject({ reason: 'KEY_RING_KEY_UNKNOWN' });

    const stale = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-stale-')), {
      currentNotBefore: new Date(now.getTime() - 7_200_000),
      currentNotAfter: new Date(now.getTime() - 3_600_000),
    });
    const staleRing = KeyRing.load(readKeyRing(stale.keyRingPath));
    expect(staleRing.ok && staleRing.ring.resolve(CURRENT_KEY_ID, now))
      .toMatchObject({ reason: 'KEY_RING_KEY_STALE' });

    const future = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-future-')), {
      currentNotBefore: new Date(now.getTime() + 3_600_000),
      currentNotAfter: new Date(now.getTime() + 7_200_000),
    });
    const futureRing = KeyRing.load(readKeyRing(future.keyRingPath));
    expect(futureRing.ok && futureRing.ring.resolve(CURRENT_KEY_ID, now))
      .toMatchObject({ reason: 'KEY_RING_KEY_FUTURE' });

    const extra = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-extra-')), {
      includeOverlap: true, extraKeys: 1,
    });
    expect(KeyRing.load(readKeyRing(extra.keyRingPath))).toMatchObject({ ok: false });
  });

  it('permits exactly one overlap key and refuses an overlong overlap', () => {
    const good = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-ok-')), {
      includeOverlap: true,
    });
    expect(KeyRing.load(readKeyRing(good.keyRingPath)).ok).toBe(true);

    const tooLong = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-long-')), {
      includeOverlap: true,
      maxOverlapMs: 1_000,
      overlapNotBefore: new Date(now.getTime() - 3_600_000),
      overlapNotAfter: new Date(now.getTime() + 3_600_000),
    });
    expect(KeyRing.load(readKeyRing(tooLong.keyRingPath)))
      .toMatchObject({ reason: 'KEY_RING_OVERLAP_TOO_LONG' });
  });
});
