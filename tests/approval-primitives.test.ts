import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalizeApprovalPayload,
  FileSingleUseNonceStore,
  signDomainApproval,
  verifyDomainApprovalSignature,
} from '@sangfor/approval';
import {
  canonicalizeLearningApprovalPayload,
  LearningApprovalError,
  promoteLearningApproval,
  signLearningApproval,
  verifyLearningApprovalSignature,
  type LearningApprovalPayload,
} from '../packages/sangfor-learning-strategy/src/approval.js';

// Simulated low-level write failures. The nonce store must fail closed and
// leave the existing store untouched when fsync or rename cannot complete.
const fsFailure = vi.hoisted(() => ({
  fsync: false,
  fsyncCallToFail: 0,
  fsyncCalls: 0,
  rename: false,
  lockErrorCode: null as string | null,
  lockAttempts: 0,
  renamedTempMode: null as number | null,
  renamedTempPath: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fsyncSync = (...args: Parameters<typeof actual.fsyncSync>): void => {
    fsFailure.fsyncCalls += 1;
    if (fsFailure.fsync || fsFailure.fsyncCalls === fsFailure.fsyncCallToFail) {
      throw new Error('simulated fsync failure');
    }
    actual.fsyncSync(...args);
  };
  const mkdirSync = (...args: Parameters<typeof actual.mkdirSync>): ReturnType<typeof actual.mkdirSync> => {
    if (String(args[0]).endsWith('.lock')) {
      fsFailure.lockAttempts += 1;
      if (fsFailure.lockErrorCode) {
        const error = new Error(`simulated lock ${fsFailure.lockErrorCode}`) as NodeJS.ErrnoException;
        error.code = fsFailure.lockErrorCode;
        throw error;
      }
    }
    return actual.mkdirSync(...args);
  };
  const renameSync = (...args: Parameters<typeof actual.renameSync>): void => {
    if (fsFailure.rename) throw new Error('simulated rename failure');
    fsFailure.renamedTempPath = String(args[0]);
    fsFailure.renamedTempMode = actual.statSync(args[0]).mode & 0o777;
    actual.renameSync(...args);
  };
  return { ...actual, fsyncSync, mkdirSync, renameSync };
});

const SECRET = Buffer.alloc(32, 0x42).toString('base64');
const FUTURE = '2099-01-01T00:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runNonceChild(
  filePath: string,
  sourcePath: string,
  nonce: string,
): Promise<{ code: number | null; output: string }> {
  const script = `import { FileSingleUseNonceStore } from ${JSON.stringify(sourcePath)};
import { explicitLocalPrimaryAuthority } from '@sangfor/shared';
void (async () => {
  const authority = explicitLocalPrimaryAuthority({ tenantId: 'test-tenant', projectId: 'local-primary', actorId: 'test-actor', aggregate: 'approvals_nonces', sourceRoot: ${JSON.stringify(dirname(filePath))} });
  const result = await new FileSingleUseNonceStore(${JSON.stringify(filePath)}, authority).consume(${JSON.stringify(nonce)}, ${JSON.stringify(FUTURE)});
  process.stdout.write(JSON.stringify(result));
})();`;
  const child = spawn(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)), ['-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
  });
  return new Promise((resolve) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('shared approval primitives', () => {
  it('preserves ordered UTF-8 fields without an extra newline and signs bytes deterministically', async () => {
    const canonical = canonicalizeApprovalPayload(['approved', '한글', 'target']);
    expect(canonical).toBe('approved\n한글\ntarget');
    expect(canonical.endsWith('\n')).toBe(false);
    const signature = signDomainApproval('secret', canonical);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(signature).toString('hex')).toBe(
      createHmac('sha256', 'secret').update(canonical, 'utf8').digest('hex'),
    );
    expect(verifyDomainApprovalSignature('secret', canonical, signature)).toEqual({ ok: true });
    expect(verifyDomainApprovalSignature('secret', `${canonical}!`, signature).ok).toBe(false);
    expect(verifyDomainApprovalSignature('secret', canonical, new Uint8Array(4))).toEqual({
      ok: false,
      reason: 'signature length mismatch',
    });
  });

  it('uses a durable lock, atomic 0600 replacement, replay rejection, and corruption fail-closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-primitive-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      expect((await store.consume('n1', FUTURE)).ok).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await store.consume('n1', FUTURE)).toMatchObject({ ok: false, reason: expect.stringContaining('already used') });
      writeFileSync(path, '{not-json');
      const corrupt = await store.consume('n2', FUTURE);
      expect(corrupt.ok).toBe(false);
      expect(corrupt.reason).toBeTruthy();
      expect(corrupt.reason).not.toMatch(/already used/u);
      mkdirSync(`${path}.lock`, { mode: 0o700 });
      const started = Date.now();
      const locked = await new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path)).consume('n3', FUTURE);
      expect(Date.now() - started).toBeLessThan(2_300);
      expect(locked).toMatchObject({ ok: false, reason: expect.stringContaining('NONCE_STORE_LOCK_TIMEOUT') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed records inside valid JSON and leaves the file unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-malformed-'));
    try {
      const path = join(dir, 'nonces.json');
      const malformedDocs = [
        JSON.stringify({ records: [] }),
        JSON.stringify({ consumed: [], extra: true }),
        JSON.stringify({ consumed: [{ nonce: 'n1', expiresAt: FUTURE }] }),
        JSON.stringify({ consumed: [{ nonce: 'n1', expiresAt: FUTURE, consumedAt: '2026-01-01T00:00:00.000Z', extra: true }] }),
        JSON.stringify({ consumed: [{ nonce: 123, expiresAt: FUTURE, consumedAt: '2026-01-01T00:00:00.000Z' }] }),
        JSON.stringify({ consumed: [{ nonce: 'n1', expiresAt: 'not-a-date', consumedAt: '2026-01-01T00:00:00.000Z' }] }),
        JSON.stringify({ consumed: 'not-an-array' }),
      ];
      for (const doc of malformedDocs) {
        writeFileSync(path, doc);
        const result = await new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path)).consume('n2', FUTURE);
        expect(result.ok).toBe(false);
        expect(result.reason).not.toMatch(/already used/u);
        expect(readFileSync(path, 'utf8')).toBe(doc);
      }
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when rename fails and leaves the existing store unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-rename-fail-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      expect((await store.consume('n1', FUTURE)).ok).toBe(true);
      const before = readFileSync(path, 'utf8');
      fsFailure.rename = true;
      try {
        const result = await store.consume('n2', FUTURE);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/simulated rename failure/u);
      } finally {
        fsFailure.rename = false;
      }
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when fsync fails and leaves the existing store unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-fsync-fail-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      expect((await store.consume('n1', FUTURE)).ok).toBe(true);
      const before = readFileSync(path, 'utf8');
      fsFailure.fsync = true;
      try {
        const result = await store.consume('n2', FUTURE);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/simulated fsync failure/u);
      } finally {
        fsFailure.fsync = false;
      }
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on parent-directory fsync failure while retaining the consumed nonce as a replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-parent-fsync-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      expect((await store.consume('n1', FUTURE)).ok).toBe(true);
      fsFailure.fsyncCalls = 0;
      fsFailure.fsyncCallToFail = 2;
      try {
        const result = await store.consume('n2', FUTURE);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('simulated fsync failure') });
      } finally {
        fsFailure.fsyncCallToFail = 0;
      }
      const persisted = JSON.parse(readFileSync(path, 'utf8')) as { consumed: Array<{ nonce: string }> };
      expect(persisted.consumed.map((record) => record.nonce)).toEqual(['n1', 'n2']);
      expect(await store.consume('n2', FUTURE)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('approval nonce already used: n2'),
      });
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      fsFailure.fsyncCallToFail = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a unique 0600 temp file and does not retry non-EEXIST lock errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-lock-error-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      fsFailure.renamedTempMode = null;
      fsFailure.renamedTempPath = null;
      expect(await store.consume('mode-nonce', FUTURE)).toEqual({ ok: true });
      expect(fsFailure.renamedTempMode).toBe(0o600);
      expect(fsFailure.renamedTempPath).toMatch(/nonces\.json\.\d+\.[0-9a-f-]+\.tmp$/u);

      fsFailure.lockAttempts = 0;
      fsFailure.lockErrorCode = 'EACCES';
      try {
        const result = await store.consume('lock-error-nonce', FUTURE);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('simulated lock EACCES') });
        expect(fsFailure.lockAttempts).toBe(1);
      } finally {
        fsFailure.lockErrorCode = null;
      }
    } finally {
      fsFailure.lockErrorCode = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows exactly one success when two child processes consume the same nonce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-race-'));
    try {
      const path = join(dir, 'nonces.json');
      const sourcePath = fileURLToPath(new URL('../packages/sangfor-approval/src/index.ts', import.meta.url));
      const results = await Promise.all([
        await runNonceChild(path, sourcePath, 'same-child-nonce'),
        await runNonceChild(path, sourcePath, 'same-child-nonce'),
      ]);
      const parsed = results.map((result) => JSON.parse(result.output) as { ok: boolean; reason?: string });
      expect(parsed.filter((result) => result.ok)).toHaveLength(1);
      expect(parsed.filter((result) => !result.ok).every((result) => /already used|NONCE_STORE_LOCK_TIMEOUT/u.test(result.reason ?? ''))).toBe(true);
      const finalState = JSON.parse(readFileSync(path, 'utf8')) as { consumed: Array<{ nonce: string }> };
      expect(finalState.consumed).toHaveLength(1);
      expect(finalState.consumed[0].nonce).toBe('same-child-nonce');
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists both records when two child processes consume distinct nonces concurrently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-distinct-'));
    try {
      const path = join(dir, 'nonces.json');
      const sourcePath = fileURLToPath(new URL('../packages/sangfor-approval/src/index.ts', import.meta.url));
      const results = await Promise.all([
        await runNonceChild(path, sourcePath, 'distinct-nonce-a'),
        await runNonceChild(path, sourcePath, 'distinct-nonce-b'),
      ]);
      const parsed = results.map((result) => JSON.parse(result.output) as { ok: boolean; reason?: string });
      expect(parsed.filter((result) => result.ok)).toHaveLength(2);
      const finalState = JSON.parse(readFileSync(path, 'utf8')) as { consumed: Array<{ nonce: string }> };
      expect(finalState.consumed.map((record) => record.nonce).sort()).toEqual(['distinct-nonce-a', 'distinct-nonce-b']);
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('learning-strategy-v1 approval adapter', () => {
  const oldEnv = { ...process.env };
  afterEach(() => { process.env = { ...oldEnv }; });

  function fixture(dir: string, nonce = randomBytes(8).toString('hex')): { payload: LearningApprovalPayload; evidenceRoot: string } {
    const evidenceRoot = join(dir, 'evidence');
    mkdirSync(evidenceRoot, { recursive: true });
    const evidence = '{"fact":"verified"}\n';
    writeFileSync(join(evidenceRoot, 'approval.json'), evidence, { mode: 0o600 });
    return {
      evidenceRoot,
      payload: {
        entityType: 'strategy',
        entityId: 'strategy-1',
        revisionId: 'revision-1',
        contentHash: sha256('strategy-content'),
        fromState: 'draft',
        toState: 'researched',
        evidenceFile: 'approval.json',
        evidenceDigest: sha256(evidence),
        nonce,
        expiresAt: FUTURE,
      },
    };
  }

  it('canonicalizes the fixed domain payload and enforces strict base64 32-byte secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-approval-'));
    try {
      const { payload } = fixture(dir);
      expect(canonicalizeLearningApprovalPayload(payload)).toBe([
        'learning-strategy-v1', payload.entityType, payload.entityId, payload.revisionId,
        payload.contentHash, payload.fromState, payload.toState, payload.evidenceFile,
        payload.evidenceDigest, payload.nonce, payload.expiresAt,
      ].join('\n'));
      expect(signLearningApproval(payload, SECRET)).toMatch(/^[a-f0-9]{64}$/);
      expect(() => signLearningApproval(payload, 'not-base64')).toThrowError(/INVALID_SECRET_ENCODING/);
      expect(() => verifyLearningApprovalSignature({ payload, approvalToken: 'A'.repeat(64), secret: SECRET }))
        .toThrowError(/INVALID_SIGNATURE_ENCODING/);
      expect(() => canonicalizeLearningApprovalPayload({ ...payload, unknown: true }))
        .toThrowError(/INVALID_PAYLOAD/);
      expect(() => canonicalizeLearningApprovalPayload({ ...payload, entityId: 'bad\nentity' }))
        .toThrowError(/INVALID_PAYLOAD/);
      expect(() => canonicalizeLearningApprovalPayload({ ...payload, evidenceFile: '/etc/hosts' }))
        .toThrowError(/INVALID_PAYLOAD/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects CR/LF in any field so distinct payloads cannot collide on the canonical string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-collision-'));
    try {
      const { payload } = fixture(dir);
      expect(() => canonicalizeLearningApprovalPayload({ ...payload, entityId: 'a\nb' })).toThrowError(/INVALID_PAYLOAD/u);
      expect(() => canonicalizeLearningApprovalPayload({ ...payload, entityId: 'a\rb' })).toThrowError(/INVALID_PAYLOAD/u);
      expect(() => canonicalizeLearningApprovalPayload({ ...payload, nonce: 'a\nb' })).toThrowError(/INVALID_PAYLOAD/u);
      expect(() => canonicalizeLearningApprovalPayload({ ...payload, fromState: 'x\ny' })).toThrowError(/INVALID_PAYLOAD/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-strict base64 secrets (whitespace/base64url/padding/length) and accepts exactly 32 bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-base64-'));
    try {
      const { payload } = fixture(dir);
      const valid32 = Buffer.alloc(32, 0x07).toString('base64');
      expect(signLearningApproval(payload, valid32)).toMatch(/^[a-f0-9]{64}$/u);
      const badSecrets = [
        Buffer.alloc(31, 0x07).toString('base64'),
        Buffer.alloc(33, 0x07).toString('base64'),
        `${valid32} `,
        ` ${valid32}`,
        `${valid32}\n`,
        `${'A'.repeat(43)}-`,
        `${'A'.repeat(43)}_`,
        valid32.replace(/=+$/u, ''),
        `${valid32}===`,
        'AAAA',
      ];
      for (const secret of badSecrets) {
        expect(() => signLearningApproval(payload, secret)).toThrowError(/INVALID_SECRET_ENCODING/u);
      }
      expect(() => signLearningApproval(payload, '')).toThrowError(/SECRET_NOT_CONFIGURED/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed learning signatures as INVALID_SIGNATURE_ENCODING and wrong values as SIGNATURE_MISMATCH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-sig-'));
    try {
      const { payload } = fixture(dir);
      const badEncodings = ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ''];
      for (const approvalToken of badEncodings) {
        expect(() => verifyLearningApprovalSignature({ payload, approvalToken, secret: SECRET }))
          .toThrowError(/INVALID_SIGNATURE_ENCODING/u);
      }
      expect(() => verifyLearningApprovalSignature({ payload, approvalToken: '0'.repeat(64), secret: SECRET }))
        .toThrowError(/SIGNATURE_MISMATCH/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats now === expiresAt as valid and +1ms as expired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-expiry-'));
    try {
      const { payload: base } = fixture(dir);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const payload = { ...base, expiresAt };
      const token = signLearningApproval(payload, SECRET);
      const atExpiry = new Date(expiresAt);
      expect(verifyLearningApprovalSignature({ payload, approvalToken: token, now: atExpiry, secret: SECRET }))
        .toMatchObject({ expiresAt });
      expect(() => verifyLearningApprovalSignature({
        payload, approvalToken: token, now: new Date(atExpiry.getTime() + 1), secret: SECRET,
      })).toThrowError(/APPROVAL_EXPIRED/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks state/content/evidence before HMAC, then consumes nonce before appending an event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-promotion-'));
    const noncePath = join(dir, 'learning-nonces.json');
    process.env.SANGFOR_LEARNING_APPROVAL_SECRET = SECRET;
    try {
      const { payload, evidenceRoot } = fixture(dir, 'promotion-nonce');
      const token = signLearningApproval(payload);
      const events: unknown[] = [];
      await expect(async () => await promoteLearningApproval({
        payload,
        approvalToken: token,
        currentState: 'draft',
        currentContentHash: '0'.repeat(64),
        evidenceRoot,
        nonceStore: new FileSingleUseNonceStore(noncePath, testFileLocalWriteAuthority('approvals_nonces', noncePath)),
        appendEvent: (value) => { events.push(value); },
      })).rejects.toThrowError(/INVALID_PAYLOAD/);
      const event = await promoteLearningApproval({
        payload,
        approvalToken: token,
        currentState: 'draft',
        currentContentHash: payload.contentHash,
        evidenceRoot,
        nonceStore: new FileSingleUseNonceStore(noncePath, testFileLocalWriteAuthority('approvals_nonces', noncePath)),
        appendEvent: (value) => { events.push(value); },
      });
      expect(event.type).toBe('learning.lifecycle.approval');
      expect(events).toHaveLength(1);
      expect(JSON.stringify(event)).not.toContain(token);
      await expect(async () => await promoteLearningApproval({
        payload,
        approvalToken: token,
        currentState: 'draft',
        currentContentHash: payload.contentHash,
        evidenceRoot,
        nonceStore: new FileSingleUseNonceStore(noncePath, testFileLocalWriteAuthority('approvals_nonces', noncePath)),
        appendEvent: () => { events.push('unexpected'); },
      })).rejects.toThrowError(/NONCE_REPLAY/);
      expect(events).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps state unchanged and nonce consumed when event append fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-append-failure-'));
    const noncePath = join(dir, 'learning-nonces.json');
    process.env.SANGFOR_LEARNING_APPROVAL_SECRET = SECRET;
    let state = 'draft';
    try {
      const { payload, evidenceRoot } = fixture(dir, 'append-failure-nonce');
      const token = signLearningApproval(payload);
      await expect(async () => await promoteLearningApproval({
        payload,
        approvalToken: token,
        currentState: state,
        currentContentHash: payload.contentHash,
        evidenceRoot,
        nonceStore: new FileSingleUseNonceStore(noncePath, testFileLocalWriteAuthority('approvals_nonces', noncePath)),
        appendEvent: () => { throw new Error('append unavailable'); },
      })).rejects.toThrowError(new LearningApprovalError('EVENT_APPEND_FAILED', 'append unavailable'));
      expect(state).toBe('draft');
      await expect(async () => await promoteLearningApproval({
        payload,
        approvalToken: token,
        currentState: state,
        currentContentHash: payload.contentHash,
        evidenceRoot,
        nonceStore: new FileSingleUseNonceStore(noncePath, testFileLocalWriteAuthority('approvals_nonces', noncePath)),
        appendEvent: () => undefined,
      })).rejects.toThrowError(/NONCE_REPLAY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects accessor, inherited, and non-plain payload fields as INVALID_PAYLOAD', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-proto-'));
    try {
      const { payload } = fixture(dir);
      const withAccessor = { ...payload };
      Object.defineProperty(withAccessor, 'entityId', {
        get: () => payload.entityId,
        enumerable: true,
        configurable: true,
      });
      expect(() => canonicalizeLearningApprovalPayload(withAccessor)).toThrowError(/INVALID_PAYLOAD/u);
      const inherited = Object.create(payload);
      expect(() => canonicalizeLearningApprovalPayload(inherited)).toThrowError(/INVALID_PAYLOAD/u);
      const nonPlain = Object.create({ inheritedExtra: 'x' });
      Object.assign(nonPlain, payload);
      expect(() => canonicalizeLearningApprovalPayload(nonPlain)).toThrowError(/INVALID_PAYLOAD/u);
      const withEmpty = { ...payload, revisionId: '' };
      expect(() => canonicalizeLearningApprovalPayload(withEmpty)).toThrowError(/INVALID_PAYLOAD/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps an unusable learning nonce store to NONCE_STORE_UNAVAILABLE without appending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-store-unavailable-'));
    const noncePath = join(dir, 'learning-nonces.json');
    process.env.SANGFOR_LEARNING_APPROVAL_SECRET = SECRET;
    try {
      const { payload, evidenceRoot } = fixture(dir, 'unavailable-nonce');
      const token = signLearningApproval(payload);
      writeFileSync(noncePath, '{corrupt');
      const events: unknown[] = [];
      await expect(async () => await promoteLearningApproval({
        payload,
        approvalToken: token,
        currentState: 'draft',
        currentContentHash: payload.contentHash,
        evidenceRoot,
        nonceStore: new FileSingleUseNonceStore(noncePath, testFileLocalWriteAuthority('approvals_nonces', noncePath)),
        appendEvent: (value) => { events.push(value); },
      })).rejects.toThrowError(/NONCE_STORE_UNAVAILABLE/u);
      expect(events).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
