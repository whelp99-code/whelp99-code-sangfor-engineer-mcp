import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProductionLocalWriteAuthority } from '@sangfor/shared';
import { signLearningApproval, type LearningApprovalPayload } from '../packages/sangfor-learning-strategy/src/approval.js';
import { LearningStrategyService } from '../packages/sangfor-learning-strategy/src/service.js';
import { listStrategyRevisions } from '../packages/sangfor-learning-strategy/src/strategy-listing.js';
import {
  allStrategyRevisions,
  strategyStoreManager,
  strategyStorePath,
} from '../packages/sangfor-learning-strategy/src/strategy-store-access.js';

/**
 * Manual driver for the split learning-strategy modules. Runs the real
 * research -> validate -> sign -> promote -> replay -> list -> collectFacts flow
 * against a throwaway store root and prints a JSON summary.
 *
 *   pnpm run driver:learning-strategy
 */

const EVIDENCE = '{"verified":true}\n';
const DIGEST = 'a'.repeat(64);

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(`DRIVER_INVARIANT_FAILED: ${message}`);
}

function researchRequest(strategyId: string, firmwareVersion: string) {
  return {
    strategyId, vendor: 'SANGFOR' as const,
    scope: { product: 'ENDPOINT_SECURE', firmwareVersion },
    registryDigest: DIGEST, versionTruthRecord: 'truth-604',
    officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
    captureEvidenceFile: 'approval.json',
  };
}

async function main(): Promise<void> {
  const storeRoot = mkdtempSync(join(tmpdir(), 'learning-strategy-driver-store-'));
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'learning-strategy-driver-evidence-'));
  process.env.SANGFOR_BLRO_AUTHORITY_STORE = 'local';
  process.env.SANGFOR_LEARNING_APPROVAL_SECRET = Buffer.alloc(32, 7).toString('base64');
  process.env.SANGFOR_LEARNING_NONCE_STORE_PATH = join(storeRoot, 'nonces', 'approval-nonces.json');
  writeFileSync(join(evidenceRoot, 'approval.json'), EVIDENCE, { mode: 0o600 });

  try {
    const authority = resolveProductionLocalWriteAuthority({
      tenantId: 'local-primary', projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary', actorId: 'learning-strategy-driver',
      aggregate: 'learning_strategy_lifecycle', sourceRoot: storeRoot,
    });
    const access = { root: storeRoot, authority };
    const service = new LearningStrategyService(storeRoot, authority);

    const created = await service.research(researchRequest('driver-primary', '6.0.4'));
    must(created.revision.state === 'draft', 'research must persist a draft revision');
    must(created.benchmark.captureEvidence, 'capture evidence must be acknowledged');

    const validation = service.validate({ strategyId: 'driver-primary', revisionId: created.revision.revisionId });
    must(validation.valid, 'a draft with capture evidence must validate');
    must(validation.eligibleNextStates.includes('researched'), 'draft -> researched must be offered');

    const payload: LearningApprovalPayload = {
      entityType: 'strategy', entityId: 'driver-primary', revisionId: created.revision.revisionId,
      contentHash: created.revision.contentHash, fromState: 'draft', toState: 'researched',
      evidenceFile: 'approval.json', evidenceDigest: createHash('sha256').update(EVIDENCE).digest('hex'),
      nonce: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const approvalToken = signLearningApproval(payload);
    const storePath = strategyStorePath(storeRoot, 'driver-primary');

    const beforeUnauthorized = readFileSync(storePath, 'utf8');
    let refusal = 'none';
    try {
      await service.promote({
        strategyId: 'driver-primary', revisionId: created.revision.revisionId, toState: 'researched',
        evidenceFile: 'approval.json', evidenceDigest: payload.evidenceDigest,
        approvalPayload: payload, approvalToken: 'f'.repeat(64), evidenceRoot,
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message.split(':')[0] ?? error.message : String(error);
    }
    must(refusal === 'SIGNATURE_MISMATCH', `an unsigned promotion must be refused, got ${refusal}`);
    must(readFileSync(storePath, 'utf8') === beforeUnauthorized, 'a refused promotion must not write to the store');

    const promoted = await service.promote({
      strategyId: 'driver-primary', revisionId: created.revision.revisionId, toState: 'researched',
      evidenceFile: 'approval.json', evidenceDigest: payload.evidenceDigest,
      approvalPayload: payload, approvalToken, evidenceRoot,
    });
    must(promoted.revision.state === 'researched', 'a signed promotion must reach researched');
    must(promoted.revision.derivedFromRevisionId === created.revision.revisionId, 'promotion must record its derivation');

    const persisted = strategyStoreManager(access, 'driver-primary').load();
    must(persisted?.lifecycleEvents.length === 1, 'exactly one approval event must be persisted');

    const afterPromotion = readFileSync(storePath, 'utf8');
    let replay = 'none';
    try {
      await service.promote({
        strategyId: 'driver-primary', revisionId: created.revision.revisionId, toState: 'researched',
        evidenceFile: 'approval.json', evidenceDigest: payload.evidenceDigest,
        approvalPayload: payload, approvalToken, evidenceRoot,
      });
    } catch (error) {
      replay = error instanceof Error ? error.message.split(':')[0] ?? error.message : String(error);
    }
    must(replay === 'NONCE_REPLAY', `a replayed approval must be refused, got ${replay}`);
    must(readFileSync(storePath, 'utf8') === afterPromotion, 'a replayed promotion must not write to the store');

    for (const strategyId of ['driver-second', 'driver-third']) await service.research(researchRequest(strategyId, '6.0.4'));
    const firstPage = service.list({ product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', limit: 2 });
    const secondPage = service.list({ product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', limit: 2, cursor: firstPage.nextCursor });
    const walked = [...firstPage.items, ...secondPage.items].map((item) => item.revisionId);
    must(new Set(walked).size === walked.length, 'the cursor walk must not repeat a revision');
    must(secondPage.nextCursor === undefined, 'the cursor walk must terminate');

    const direct = listStrategyRevisions(access, { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', limit: 2 });
    must(JSON.stringify(direct) === JSON.stringify(firstPage), 'the facade must be a pass-through over the listing module');

    const drifted = service.collectFacts({
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      context: { registryDigest: 'b'.repeat(64), versionTruthRecord: 'truth-604', environment: 'lab' },
      factIds: ['version'],
    });
    must(drifted.resolution === 'blocked', 'a drifted registry digest must block fact collection');
    must(drifted.observations.every((item) => item.value === undefined), 'a blocked resolution must yield no fact value');

    process.stdout.write(`${JSON.stringify({
      ok: true,
      storeRoot,
      revisionsOnRoot: allStrategyRevisions(access).length,
      unauthorizedPromotion: refusal,
      replayedPromotion: replay,
      promotedState: promoted.revision.state,
      lifecycleEvents: persisted?.lifecycleEvents.length ?? 0,
      cursorWalk: walked.length,
      driftedResolution: drifted.resolution,
    }, null, 2)}\n`);
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
