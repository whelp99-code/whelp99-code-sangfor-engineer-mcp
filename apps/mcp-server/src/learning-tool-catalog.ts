import { randomBytes } from 'node:crypto';
import { resolveRepoData } from '../../../packages/shared/src/index.js';
import { captureKeyringFromEnv } from '../../../packages/sangfor-collector/src/capture-bundle.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';
import { currentLearningService, learningArgs, observerManager, pendingLearningCaptures } from './browser-runtime-composition.js';

export const learningToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_list_learning_strategies", {
    description: 'List local learning strategy revisions with exact filters and cursor pagination.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      strategyId: { type: 'string' }, vendor: { type: 'string', enum: ['SANGFOR', 'FORTINET', 'CISCO'] },
      product: { type: 'string' }, firmwareVersion: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'researched', 'lab_verified', 'device_verified', 'strategy_field_verified', 'stale', 'deprecated'] },
      cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } },
    handler: (args: unknown) => currentLearningService().list(learningArgs(args, ['strategyId', 'vendor', 'product', 'firmwareVersion', 'status', 'cursor', 'limit'])),
  }],
  ["sangfor_resolve_learning_strategy", {
    description: 'Resolve one exact eligible learning strategy; returns honest miss, canary, drift, or ambiguity reasons.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['scope', 'context'], properties: {
      scope: { type: 'object', additionalProperties: false, required: ['product', 'firmwareVersion'], properties: { product: { type: 'string' }, firmwareVersion: { type: 'string' }, capability: { type: 'string' }, fact: { type: 'string' } } },
      context: { type: 'object', additionalProperties: false, required: ['registryDigest', 'versionTruthRecord'], properties: { registryDigest: { type: 'string' }, versionTruthRecord: { type: 'string' }, productVariant: { type: 'string' }, deviceScope: { type: 'string' }, environment: { type: 'string', enum: ['lab', 'poc', 'customer', 'production'] } } },
    } },
    handler: (args: unknown) => { const input = learningArgs(args, ['scope', 'context']); return currentLearningService().resolve(input.scope, input.context); },
  }],
  ["sangfor_attach_observation_session", {
    description: 'WRITE: attach to one exact loopback CDP page owned by the observer profile registry.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['product', 'expectedOrigin', 'cdpPort', 'firmwareTruthId'], properties: { product: { type: 'string' }, expectedOrigin: { type: 'string' }, cdpPort: { type: 'integer', minimum: 1, maximum: 65535 }, firmwareTruthId: { type: 'string' } } },
    handler: (args: unknown) => observerManager().attach(learningArgs(args, ['product', 'expectedOrigin', 'cdpPort', 'firmwareTruthId']) as any),
  }],
  ["sangfor_manage_learning_capture", {
    description: 'WRITE: start or stop a passive observation capture; stop promotes one encrypted capture-bundle.v1.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['start', 'stop'] }, sessionHandle: { type: 'string' }, captureId: { type: 'string' }, durationMs: { type: 'integer', minimum: 0, maximum: 30000 }, firmwareVersion: { type: 'string' } } },
    handler: async (args: unknown) => {
      const input = learningArgs(args, ['action', 'sessionHandle', 'captureId', 'durationMs', 'firmwareVersion']);
      if (input.action === 'start') {
        if (typeof input.sessionHandle !== 'string' || !observerManager().get(input.sessionHandle)) throw new Error('OBSERVER_SESSION_UNAVAILABLE: exact sessionHandle is required.');
        const captureId = randomBytes(16).toString('hex');
        pendingLearningCaptures.set(captureId, { sessionHandle: input.sessionHandle, durationMs: input.durationMs, firmwareVersion: input.firmwareVersion });
        return { captureId, status: 'started' };
      }
      if (input.action !== 'stop' || typeof input.captureId !== 'string') throw new Error('INVALID_INPUT: action stop requires captureId.');
      const pending = pendingLearningCaptures.get(input.captureId);
      if (!pending) throw new Error('CAPTURE_NOT_FOUND: captureId is missing or already consumed.');
      const summary = await observerManager().capture({ ...pending, capturesDir: resolveRepoData('data/captures'), stagingRoot: resolveRepoData('data/runtime/learning-captures'), keyring: captureKeyringFromEnv() });
      pendingLearningCaptures.delete(input.captureId);
      return { captureId: input.captureId, status: 'stopped', bundle: summary };
    },
  }],
  ["sangfor_collect_facts", {
    description: 'WRITE: collect requested facts through an exact learning strategy and return complete/partial/conflict/unavailable observations.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['scope', 'context', 'factIds'], properties: {
      scope: { type: 'object', additionalProperties: false, required: ['product', 'firmwareVersion'], properties: { product: { type: 'string' }, firmwareVersion: { type: 'string' }, capability: { type: 'string' }, fact: { type: 'string' } } },
      context: { type: 'object', additionalProperties: false, required: ['registryDigest', 'versionTruthRecord'], properties: { registryDigest: { type: 'string' }, versionTruthRecord: { type: 'string' }, productVariant: { type: 'string' }, deviceScope: { type: 'string' }, environment: { type: 'string', enum: ['lab', 'poc', 'customer', 'production'] } } },
      factIds: { type: 'array', minItems: 1, items: { type: 'string' } }, allowCanary: { type: 'boolean', default: false },
      methodResults: { type: 'array', items: { type: 'object' } },
    } },
    handler: (args: unknown) => currentLearningService().collectFacts(learningArgs(args, ['scope', 'context', 'factIds', 'allowCanary', 'methodResults']) as any),
  }],
  ["sangfor_research_learning_strategy", {
    description: 'WRITE: create an immutable draft from supplied official citation and optional capture evidence.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['strategyId', 'vendor', 'scope', 'registryDigest', 'versionTruthRecord', 'officialCitation', 'pageVerified'], properties: {
      strategyId: { type: 'string' }, vendor: { type: 'string', enum: ['SANGFOR', 'FORTINET', 'CISCO'] },
      scope: { type: 'object', additionalProperties: false, required: ['product', 'firmwareVersion'], properties: { product: { type: 'string' }, firmwareVersion: { type: 'string' }, capability: { type: 'string' }, fact: { type: 'string' } } },
      registryDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, versionTruthRecord: { type: 'string' }, productVariant: { type: 'string' }, officialCitation: { type: 'string' }, pageVerified: { type: 'boolean' }, captureEvidenceFile: { type: 'string' }, methods: { type: 'array', items: { type: 'string', enum: ['LM-01', 'LM-02', 'LM-03', 'LM-04', 'LM-05', 'LM-06', 'LM-07', 'LM-08'] } },
    } },
    handler: (args: unknown) => currentLearningService().research(learningArgs(args, ['strategyId', 'vendor', 'scope', 'registryDigest', 'versionTruthRecord', 'productVariant', 'officialCitation', 'pageVerified', 'captureEvidenceFile', 'methods']) as any),
  }],
  ["sangfor_validate_learning_strategy", {
    description: 'WRITE: validate exact revision evidence and report eligible next states without promotion.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['strategyId', 'revisionId'], properties: { strategyId: { type: 'string' }, revisionId: { type: 'string' }, evidenceFile: { type: 'string' }, evidenceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
    handler: (args: unknown) => currentLearningService().validate(learningArgs(args, ['strategyId', 'revisionId', 'evidenceFile', 'evidenceDigest']) as any),
  }],
  ["sangfor_promote_learning_strategy", {
    description: 'WRITE: promote an immutable revision through a signed, action-bound, single-use lifecycle approval.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['strategyId', 'revisionId', 'toState', 'approvalPayload', 'approvalToken', 'evidenceRoot'], properties: {
      strategyId: { type: 'string' }, revisionId: { type: 'string' }, toState: { type: 'string', enum: ['researched', 'lab_verified', 'device_verified', 'strategy_field_verified', 'stale', 'deprecated'] }, evidenceFile: { type: 'string' }, evidenceDigest: { type: 'string' }, approvalToken: { type: 'string', pattern: '^[a-f0-9]{64}$' }, evidenceRoot: { type: 'string' },
      approvalPayload: { type: 'object', additionalProperties: false, required: ['entityType', 'entityId', 'revisionId', 'contentHash', 'fromState', 'toState', 'evidenceFile', 'evidenceDigest', 'nonce', 'expiresAt'], properties: { entityType: { type: 'string' }, entityId: { type: 'string' }, revisionId: { type: 'string' }, contentHash: { type: 'string' }, fromState: { type: 'string' }, toState: { type: 'string' }, evidenceFile: { type: 'string' }, evidenceDigest: { type: 'string' }, nonce: { type: 'string' }, expiresAt: { type: 'string' } } },
    } },
    handler: (args: unknown) => currentLearningService().promote(learningArgs(args, ['strategyId', 'revisionId', 'toState', 'evidenceFile', 'evidenceDigest', 'approvalPayload', 'approvalToken', 'evidenceRoot']) as any),
  }],
];
