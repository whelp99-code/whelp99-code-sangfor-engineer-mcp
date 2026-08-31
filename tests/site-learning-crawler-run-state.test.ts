import { describe, expect, it } from 'vitest';
import {
  createSiteLearningCheckpoint,
  deriveFrontierStatus,
  restoreSiteLearningCheckpoint,
  sliceToOptionalLimit,
  validateSiteLearningReport
} from '../packages/sangfor-collector/src/site-learning-crawler.js';

describe('two-site learning crawler run completion state', () => {
  it('treats an omitted collection limit as unlimited', () => {
    expect(sliceToOptionalLimit([1, 2, 3], undefined)).toEqual([1, 2, 3]);
    expect(sliceToOptionalLimit([1, 2, 3], 2)).toEqual([1, 2]);
  });

  it('fails closed when either source is empty, errored, or unfinished', () => {
    const healthy = {
      startedAt: '2026-08-13T00:00:00.000Z',
      completedAt: '2026-08-13T01:00:00.000Z',
      sourceRoots: [
        'https://support.sangfor.com/',
        'https://community.sangfor.com/plugin.php?id=info:index'
      ],
      support: { discovered: 10, fetched: 10, accepted: 8, rejected: {}, duplicates: 2, errors: 0 },
      community: { discovered: 20, fetched: 20, accepted: 12, rejected: {}, duplicates: 0, errors: 0 },
      documents: 20,
      frontierExhausted: true,
      truncatedByLimit: []
    };
    expect(validateSiteLearningReport(healthy)).toEqual({ ok: true, errors: [] });
    expect(validateSiteLearningReport({
      ...healthy,
      community: { ...healthy.community, accepted: 0, errors: 1 },
      frontierExhausted: false
    })).toEqual({
      ok: false,
      errors: [
        'community accepted no documents',
        'community crawl has 1 errors',
        'crawl frontier was not exhausted',
        'document total does not equal accepted source totals'
      ]
    });
  });

  it('reports capped runs as truncated instead of frontier-exhausted', () => {
    expect(deriveFrontierStatus({
      supportLimitReached: false,
      communityForumLimitApplied: false,
      communityPageLimitApplied: false,
      communityThreadLimitApplied: false
    })).toEqual({ frontierExhausted: true, truncatedByLimit: [] });
    expect(deriveFrontierStatus({
      supportLimitReached: true,
      communityForumLimitApplied: false,
      communityPageLimitApplied: true,
      communityThreadLimitApplied: true
    })).toEqual({
      frontierExhausted: false,
      truncatedByLimit: [
        'maxSupportDocuments',
        'maxCommunityPagesPerForum',
        'maxCommunityThreads'
      ]
    });
  });

  it('round-trips resumable documents, hashes, stats, and limit state', () => {
    const checkpoint = createSiteLearningCheckpoint({
      documents: [{
        id: 'support_1',
        siteId: 'sangfor_support',
        source: 'support_site',
        sourceUrl: 'https://support.sangfor.com/productDocument/read?category_id=1',
        product: 'HCI',
        title: 'HCI setup',
        text: 'Configure the HCI cluster and verify the read-back result.',
        trustLevel: 'official',
        fetchedAt: '2026-08-13T00:00:00.000Z',
        contentHash: 'abc'
      }],
      support: { discovered: 1, fetched: 1, accepted: 1, rejected: {}, duplicates: 0, errors: 0 },
      community: { discovered: 0, fetched: 0, accepted: 0, rejected: {}, duplicates: 0, errors: 0 },
      limitState: {
        supportLimitReached: false,
        communityForumLimitApplied: false,
        communityPageLimitApplied: false,
        communityThreadLimitApplied: false
      },
      completed: false
    });
    expect(restoreSiteLearningCheckpoint(JSON.stringify(checkpoint))).toMatchObject({
      documents: [{ id: 'support_1' }],
      contentHashes: ['abc'],
      completed: false
    });
    expect(() => restoreSiteLearningCheckpoint('{broken')).toThrow('INVALID_TWO_SITE_CHECKPOINT');
  });
});
