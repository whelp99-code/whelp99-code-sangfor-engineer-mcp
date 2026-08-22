import { describe, expect, it } from 'vitest';
import { buildFineTuneExample } from '../packages/sangfor-finetune/src/index.js';
import { ingestDocumentsBatch } from '../packages/sangfor-rag/src/index.js';
import {
  extractCommunityForumIds,
  extractCommunityForumPageCount,
  extractCommunityPageCount,
  extractCommunityThreadPageCount,
  extractCommunityThreadIds,
  flattenSupportLeaves,
  inferLearningProduct,
  isDocumentFineTuneEligible,
  isFineTuneEligibleLearningText,
  normalizeLearningText,
  parseSupportProductVersions,
  prepareLearningTextForFineTune,
  parseSupportCasePage,
  parseSupportShowcaseRows,
  deriveFrontierStatus,
  resolveSafeCrawlUserDataDir,
  parseCommunityThreadPage,
  parseRobotsDisallowRules,
  isUrlAllowedByRobots,
  createSiteLearningCheckpoint,
  restoreSiteLearningCheckpoint,
  redactLearningSensitiveData,
  sliceToOptionalLimit,
  selectSupportProductVersions,
  validateSiteLearningReport
} from '../packages/sangfor-collector/src/site-learning-crawler.js';

describe('two-site learning crawler parsers', () => {
  it('parses every Support product and version without fabricating IDs', () => {
    const parsed = parseSupportProductVersions({
      code: 200,
      data: {
        10: {
          id: 10,
          name: 'Hyper Converged Infrastructure (HCI/aSV)',
          version: [
            { id: 1381, name: '6.11.3', product_id: 10 },
            { id: 1150, name: 'All versions', product_id: 10 }
          ]
        }
      }
    });
    expect(parsed).toEqual([
      { productId: 10, productName: 'Hyper Converged Infrastructure (HCI/aSV)', versionId: 1381, versionName: '6.11.3' },
      { productId: 10, productName: 'Hyper Converged Infrastructure (HCI/aSV)', versionId: 1150, versionName: 'All versions' }
    ]);
  });

  it('selects every concrete version and skips aggregate aliases', () => {
    expect(selectSupportProductVersions([
      { productId: 10, productName: 'HCI', versionId: 1381, versionName: '6.11.3' },
      { productId: 10, productName: 'HCI', versionId: 1150, versionName: 'All versions' },
      { productId: 10, productName: 'HCI', versionId: 1370, versionName: '6.11.2' },
      { productId: 11, productName: 'VDI', versionId: 1389, versionName: '5.9.6R1' }
    ])).toEqual([
      { productId: 10, productName: 'HCI', versionId: 1381, versionName: '6.11.3' },
      { productId: 10, productName: 'HCI', versionId: 1370, versionName: '6.11.2' },
      { productId: 11, productName: 'VDI', versionId: 1389, versionName: '5.9.6R1' }
    ]);
  });

  it('treats an omitted collection limit as unlimited', () => {
    expect(sliceToOptionalLimit([1, 2, 3], undefined)).toEqual([1, 2, 3]);
    expect(sliceToOptionalLimit([1, 2, 3], 2)).toEqual([1, 2]);
  });

  it('flattens Support category trees into leaf document URLs', () => {
    expect(flattenSupportLeaves([
      {
        id: 94,
        name: 'User Manual',
        children: [{
          id: 101,
          name: 'Installation',
          children: [{ id: 102, name: 'Power' }, { id: 103, name: 'Wiring' }]
        }]
      }
    ])).toEqual([
      { categoryId: 102, path: ['User Manual', 'Installation', 'Power'] },
      { categoryId: 103, path: ['User Manual', 'Installation', 'Wiring'] }
    ]);
  });

  it('parses Support showcase links and paginated troubleshooting cases', () => {
    expect(parseSupportShowcaseRows({
      code: 0,
      rows: [{
        id: 32,
        code: 'TROUBLESHOOTING_CASES',
        name: 'HCI/aSV',
        linkUrl: '/cases/list?product_id=10&type=1',
        remark: 'Hyper Converged Infrastructure'
      }]
    })).toEqual([{
      id: 32,
      code: 'TROUBLESHOOTING_CASES',
      name: 'HCI/aSV',
      linkUrl: '/cases/list?product_id=10&type=1',
      remark: 'Hyper Converged Infrastructure'
    }]);
    expect(parseSupportCasePage({
      code: 0,
      rows: {
        content: [{
          id: '2:309038',
          title: 'HCI diagnosis tool',
          content: '<p>Run the diagnostic tool and inspect the report.</p>',
          product: '10'
        }],
        totalPages: 11
      }
    })).toEqual({
      totalPages: 11,
      cases: [{
        id: '2:309038',
        title: 'HCI diagnosis tool',
        text: 'Run the diagnostic tool and inspect the report.',
        productId: 10
      }]
    });
  });

  it('discovers every forum and thread ID from Discuz links', () => {
    const html = `
      <a href="forum.php?mod=forumdisplay&amp;fid=156">HCI</a>
      <a href="/forum.php?mod=forumdisplay&fid=167&page=2">IAG</a>
      <a href="forum.php?mod=viewthread&amp;tid=12230">Thread</a>
      <a href="thread-7805-1-1.html">Pretty thread</a>
    `;
    expect(extractCommunityForumIds(html)).toEqual([156, 167]);
    expect(extractCommunityThreadIds(html)).toEqual([7805, 12230]);
  });

  it('extracts all public post bodies from a Community thread page', () => {
    expect(parseCommunityThreadPage(`
      <title>HCI MTU troubleshooting - Sangfor Community</title>
      <td class="t_f" id="postmessage_1"><p>Set the storage MTU to 9000.</p></td>
      <td class="t_f" id="postmessage_2"><p>Verify the setting from every node.</p></td>
    `)).toEqual({
      title: 'HCI MTU troubleshooting - Sangfor Community',
      text: 'Set the storage MTU to 9000.\n\nVerify the setting from every node.'
    });
  });

  it('falls back to the AngularJS postlistData JSON payload when no server-rendered post markup exists', () => {
    // Some Discuz threads (viewthread module) render posts entirely client-side via
    // angular.module('viewthread').value('postlistData', {...}) instead of emitting
    // <td class="t_f" id="postmessage_N"> markup — a static regex on classic markup
    // silently drops these threads even though the real post text is present as an
    // escaped JSON string literal in the page.
    const html = `
      <title>How to Participate in Sangfor Beta Program? - Sangfor Community</title>
      <script>
        angular.module('viewthread').value('postlistData', {"151778":{"pid":"151778","tid":"8304","first":"1","author":"Sangfor Jojo","subject":"Beta","message":"<p>What Is Beta Program<\\/p>\\r\\n<p>Line two.<\\/p>"}});
      </script>
    `;
    expect(parseCommunityThreadPage(html)).toEqual({
      title: 'How to Participate in Sangfor Beta Program? - Sangfor Community',
      text: 'What Is Beta Program Line two.'
    });
  });

  it('returns null when neither server-rendered markup nor postlistData JSON contains a post body', () => {
    expect(parseCommunityThreadPage('<title>Empty</title><div>no posts here</div>')).toBeNull();
  });

  it('enforces fetched robots disallow rules including wildcards', () => {
    const rules = parseRobotsDisallowRules(`
      User-agent: *
      Disallow: /search.php
      Disallow: /*?mod=attachment*
      Disallow: /member.php$
    `);
    expect(isUrlAllowedByRobots('https://community.sangfor.com/forum.php?mod=viewthread&tid=1', rules))
      .toBe(true);
    expect(isUrlAllowedByRobots('https://community.sangfor.com/search.php?q=hci', rules))
      .toBe(false);
    expect(isUrlAllowedByRobots('https://community.sangfor.com/forum.php?mod=attachment&aid=1', rules))
      .toBe(false);
    expect(isUrlAllowedByRobots('https://community.sangfor.com/member.php', rules)).toBe(false);
  });

  it('detects the last Discuz pagination page and defaults to one', () => {
    expect(extractCommunityPageCount(
      '<a href="forum.php?mod=forumdisplay&fid=156&page=2">2</a><a href="forum.php?mod=forumdisplay&fid=156&page=19">19</a>'
    )).toBe(19);
    expect(extractCommunityPageCount('<div>No pagination</div>')).toBe(1);
  });

  it('does not confuse forum and thread pagination links', () => {
    const html = `
      <a href="forum.php?mod=forumdisplay&fid=156&page=9">Forum 9</a>
      <a href="forum.php?mod=viewthread&tid=12230&page=31">Thread 31</a>
      <a href="forum-156-19.html">Pretty forum 19</a>
      <a href="thread-12230-41-1.html">Pretty thread 41</a>
    `;
    expect(extractCommunityForumPageCount(html, 156)).toBe(19);
    expect(extractCommunityThreadPageCount(html, 12230)).toBe(41);
  });

  it('keeps supported products explicit and unsupported products out of HCI', () => {
    expect(inferLearningProduct('Hyper Converged Infrastructure HCI deployment')).toBe('HCI');
    expect(inferLearningProduct('Athena NGFW firewall policy guide')).toBe('NGFW');
    expect(inferLearningProduct('aDesk Virtual Desktop Infrastructure')).toBe('OTHER');
    expect(inferLearningProduct('HCI, IAG, and Endpoint Secure product catalog')).toBe('OTHER');
  });

  it('deduplicates repeated rendered text and masks contact or token-like data', () => {
    expect(normalizeLearningText('Header\nHeader\n\nUseful body\nUseful body')).toBe(
      'Header\n\nUseful body'
    );
    expect(redactLearningSensitiveData(
      'Contact admin@example.com or +60 12 711 7511. Authorization: Bearer abcdefghijklmnopqrstuvwxyz'
    )).toBe('Contact [REDACTED_EMAIL] or [REDACTED_PHONE]. Authorization: Bearer [REDACTED_TOKEN]');
  });

  it('keeps full text in RAG but excludes sensitive-topic pages from fine-tuning', () => {
    expect(isFineTuneEligibleLearningText('Configure the cluster MTU and validate connectivity.')).toBe(true);
    expect(isFineTuneEligibleLearningText('Reset the administrator password and copy the secret.')).toBe(false);
    expect(isFineTuneEligibleLearningText('Privacy Policy for account information')).toBe(false);
  });

  it('matches the fine-tune validator exactly: plural topics are sensitive, innocent substrings are not', () => {
    // The producer filter and validateFineTuneDataset must agree, or a fully collected
    // corpus dies at the last validation step. Plurals used to pass the producer and
    // then trip the validator; "footprint" (which contains "otp") used to be flagged as
    // sensitive by the validator even though no topic word is present.
    expect(isFineTuneEligibleLearningText('Reset the administrator passwords for each node.')).toBe(false);
    expect(isFineTuneEligibleLearningText('Import the license keys before adding a node.')).toBe(false);
    expect(isFineTuneEligibleLearningText('Store any secrets outside the repository.')).toBe(false);
    expect(isFineTuneEligibleLearningText('Reduced data center footprint and lower power draw.')).toBe(true);
  });

  it('keeps safe technical paragraphs for fine-tuning while dropping sensitive paragraphs', () => {
    expect(prepareLearningTextForFineTune([
      'Configure the cluster MTU and validate connectivity before deployment.',
      'Reset the administrator password and copy the secret token.',
      'Verify node health and record the read-back result after the change.'
    ].join('\n\n'))).toBe([
      'Configure the cluster MTU and validate connectivity before deployment.',
      'Verify node health and record the read-back result after the change.'
    ].join('\n\n'));
  });

  it('rejects a document from fine-tuning when its TITLE alone carries a sensitive topic, even if the body is clean', () => {
    // A document body can pass prepareLearningTextForFineTune while its raw title
    // (used verbatim as the fine-tune "input" prompt) still leaks a sensitive topic
    // word (e.g. "Reset Admin Password", "License Key Activation") — the eligibility
    // check must cover the title too, not just the body paragraphs.
    const longSafeBody = 'Configure the cluster MTU and validate connectivity before deployment. '
      + 'Confirm every node reports the same MTU value and that jumbo frames are enabled end to end. '
      + 'Re-run the network validation tool after applying the change to confirm the cluster is healthy.';
    expect(isDocumentFineTuneEligible('How to Reset the Admin Password', longSafeBody)).toBe(false);
    expect(isDocumentFineTuneEligible('HCI Cluster MTU Configuration', longSafeBody)).toBe(true);
    expect(isDocumentFineTuneEligible('HCI Cluster MTU Configuration', 'too short')).toBe(false);
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

  it('allows only explicitly isolated temporary browser profiles', () => {
    expect(resolveSafeCrawlUserDataDir(undefined)).toBeUndefined();
    expect(resolveSafeCrawlUserDataDir('/tmp/sangfor-two-site-profile')).toBe(
      '/tmp/sangfor-two-site-profile'
    );
    expect(() => resolveSafeCrawlUserDataDir('/Users/example/Library/Application Support/Aside'))
      .toThrow('TWO_SITE_PROFILE_NOT_ISOLATED');
    expect(() => resolveSafeCrawlUserDataDir('/home/example/.config/google-chrome'))
      .toThrow('TWO_SITE_PROFILE_NOT_ISOLATED');
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

  it('preserves each learned document product in fine-tuning metadata', () => {
    expect(buildFineTuneExample({
      product: 'OTHER',
      taskType: 'lesson_extraction',
      userInput: 'Athena NGFW case',
      expectedOutput: 'Use the official source.',
      source: 'https://support.sangfor.com/cases/list'
    }).product).toBe('OTHER');
  });

  it('exposes a batch RAG ingest path for full-site learning', () => {
    expect(typeof ingestDocumentsBatch).toBe('function');
  });
});
