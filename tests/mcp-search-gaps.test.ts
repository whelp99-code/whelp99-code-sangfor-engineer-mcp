import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let getToolHandler: (name: string) => ((args: unknown) => unknown | Promise<unknown>) | undefined;
let ingestDocument: typeof import('../packages/sangfor-rag/src/index.js').ingestDocument;

let workDir: string;
let indexPath: string;

beforeAll(async () => {
  const mcp = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mcp.getToolHandler as typeof getToolHandler;
  const rag = await import('../packages/sangfor-rag/src/index.js');
  ingestDocument = rag.ingestDocument;

  process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
  workDir = mkdtempSync(join(tmpdir(), 'search-gap-fixture-'));
  indexPath = join(workDir, 'index.json');
  // Three chunks with clearly different topical relevance: rankHybrid's score
  // is min-max normalized ACROSS the candidate pool, so a single-chunk index
  // always normalizes to 0 regardless of relevance. Three well-separated
  // chunks give a genuinely strong top hit (score approx 1) for the
  // "no gap on a strong hit" case, alongside weak ones.
  const hciDoc = join(workDir, 'hci.md');
  writeFileSync(hciDoc, '# HCI\n\nStorage network MTU validation before cluster init. Jumbo frames and MTU 9000 are required for the storage network.');
  await ingestDocument({ filePath: hciDoc, product: 'HCI', indexPath });
  const iagDoc = join(workDir, 'iag.md');
  writeFileSync(iagDoc, '# IAG\n\nUser authentication policy and internet access control rules for web filtering.');
  await ingestDocument({ filePath: iagDoc, product: 'IAG', indexPath });
  const ndrDoc = join(workDir, 'ndr.md');
  writeFileSync(ndrDoc, '# NDR\n\nIncident response playbook and SOC alert triage procedures for security operations.');
  await ingestDocument({ filePath: ndrDoc, product: 'NDR', indexPath });
});

const STRONG_QUERY = 'MTU storage network jumbo frames';

describe('sangfor_rag_search — search-gap capture (W4 C2)', () => {
  // Snapshot INSIDE beforeEach, not at collection time: the module-level
  // beforeAll above sets SANGFOR_EMBEDDING_FORCE_HASH before any test runs,
  // and every test in this suite depends on it staying set. A snapshot taken
  // at describe-body-eval time would predate that and wipe it out after the
  // first afterEach.
  let saved: NodeJS.ProcessEnv;
  let feedbackRoot: string;

  beforeEach(() => {
    saved = { ...process.env };
    feedbackRoot = mkdtempSync(join(tmpdir(), 'search-gap-feedback-'));
    process.env.SANGFOR_FEEDBACK_ROOT = feedbackRoot;
    delete process.env.SANGFOR_SEARCH_GAP_CAPTURE;
    delete process.env.SANGFOR_RAG_WEAK_THRESHOLD;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(feedbackRoot, { recursive: true, force: true });
  });

  function readGapLines(): any[] {
    const path = join(feedbackRoot, 'search-gaps.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('records a no_hits gap when the index has 0 matches', async () => {
    const handler = getToolHandler('sangfor_rag_search')!;
    const emptyIndexPath = join(workDir, 'does-not-exist.json');
    const hits: any = await handler({ query: 'unrelated query xyz', indexPath: emptyIndexPath });
    expect(hits).toEqual([]);

    const gaps = readGapLines();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ query: 'unrelated query xyz', hitCount: 0, reason: 'no_hits' });
    expect(typeof gaps[0].id).toBe('string');
    expect(typeof gaps[0].ts).toBe('string');
  });

  it('records a low_score gap when the top hit is below SANGFOR_RAG_WEAK_THRESHOLD', async () => {
    process.env.SANGFOR_RAG_WEAK_THRESHOLD = '1.1'; // above any possible score — forces low_score
    const handler = getToolHandler('sangfor_rag_search')!;
    const hits: any = await handler({ query: STRONG_QUERY, indexPath, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);

    const gaps = readGapLines();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toBe('low_score');
    expect(gaps[0].hitCount).toBe(hits.length);
    expect(typeof gaps[0].topScore).toBe('number');
  });

  it('does not record a gap for a strong hit under the default threshold', async () => {
    const handler = getToolHandler('sangfor_rag_search')!;
    const hits: any = await handler({ query: STRONG_QUERY, indexPath, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(readGapLines()).toEqual([]);
  });

  it('SANGFOR_SEARCH_GAP_CAPTURE=0 disables capture entirely', async () => {
    process.env.SANGFOR_SEARCH_GAP_CAPTURE = '0';
    const handler = getToolHandler('sangfor_rag_search')!;
    const emptyIndexPath = join(workDir, 'does-not-exist-2.json');
    await handler({ query: 'still no hits', indexPath: emptyIndexPath });
    expect(readGapLines()).toEqual([]);
  });

  it('a capture failure does not fail the search itself (fail-open on the write, not the read)', async () => {
    // Point SANGFOR_FEEDBACK_ROOT at a FILE (not a directory) so the JSONL
    // append's mkdir fails — this must be caught, not surfaced to the caller.
    const blockerFile = join(workDir, 'not-a-directory');
    writeFileSync(blockerFile, 'x');
    process.env.SANGFOR_FEEDBACK_ROOT = blockerFile;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const handler = getToolHandler('sangfor_rag_search')!;
      const emptyIndexPath = join(workDir, 'does-not-exist-3.json');
      const hits: any = await handler({ query: 'query that would gap', indexPath: emptyIndexPath });
      expect(hits).toEqual([]); // search itself succeeded despite the capture failure
      expect(stderrSpy).toHaveBeenCalled();
      expect(String(stderrSpy.mock.calls[0][0])).toContain('[search-gap]');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('sangfor_search_gaps (W4 C2)', () => {
  let saved: NodeJS.ProcessEnv;
  let feedbackRoot: string;

  beforeEach(() => {
    saved = { ...process.env };
    feedbackRoot = mkdtempSync(join(tmpdir(), 'search-gap-list-'));
    process.env.SANGFOR_FEEDBACK_ROOT = feedbackRoot;
    delete process.env.SANGFOR_SEARCH_GAP_CAPTURE;
    delete process.env.SANGFOR_RAG_WEAK_THRESHOLD;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(feedbackRoot, { recursive: true, force: true });
  });

  it('is read-only', async () => {
    const mcp = await import('../apps/mcp-server/src/index.js');
    const tool = mcp.listTools().find((t) => t.name === 'sangfor_search_gaps')!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it('returns an empty list when nothing has been captured yet', () => {
    const handler = getToolHandler('sangfor_search_gaps')!;
    const result: any = handler({});
    expect(result.gaps).toEqual([]);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('with neither cursor nor limit, returns the full list unchanged (W1 pagination convention)', async () => {
    const searchHandler = getToolHandler('sangfor_rag_search')!;
    for (let i = 0; i < 3; i++) {
      await searchHandler({ query: `gap query ${i}`, indexPath: join(workDir, `missing-${i}.json`) });
    }
    const handler = getToolHandler('sangfor_search_gaps')!;
    const result: any = handler({});
    expect(result.gaps).toHaveLength(3);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('pages through the full set with no duplicates or gaps when a limit is supplied', async () => {
    const searchHandler = getToolHandler('sangfor_rag_search')!;
    for (let i = 0; i < 5; i++) {
      await searchHandler({ query: `gap query ${i}`, indexPath: join(workDir, `missing-page-${i}.json`) });
    }
    const handler = getToolHandler('sangfor_search_gaps')!;
    const full: any = handler({});
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page: any = handler({ cursor, limit: 2 });
      expect(page.gaps.length).toBeLessThanOrEqual(2);
      collected.push(...page.gaps.map((g: any) => g.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(collected).toEqual(full.gaps.map((g: any) => g.id));
  });
});
