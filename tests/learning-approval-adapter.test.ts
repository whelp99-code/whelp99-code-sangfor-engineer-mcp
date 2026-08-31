import { testFileLocalWriteAuthority } from './helpers/local-write-authority.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSingleUseNonceStore } from '@sangfor/approval';
import {
  canonicalizeLearningApprovalPayload, LearningApprovalError, promoteLearningApproval,
  signLearningApproval, verifyLearningApprovalSignature, type LearningApprovalPayload,
} from '../packages/sangfor-learning-strategy/src/approval.js';
import { FUTURE, SECRET, sha256 } from './helpers/approval-primitives-fixture.js';

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
