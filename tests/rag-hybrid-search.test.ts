import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBm25Scores } from '../packages/sangfor-rag/src/bm25.js';
import { ingestDocument, minMaxNormalizer, ragSearchSync } from '../packages/sangfor-rag/src/index.js';

const dirs: string[] = [];
afterEach(() => {
  delete process.env.SANGFOR_RAG_HYBRID_ALPHA;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'rag-hybrid-')); dirs.push(d); return d; };

describe('computeBm25Scores — exact-term-match ranks above a non-matching doc', () => {
  it('scores a document containing the rare query term above one that does not', () => {
    const docs = [
      { id: 'a', text: 'zookeeper cluster failover replication log compaction node quorum' },
      { id: 'b', text: 'completely unrelated cooking recipe for pasta with tomato sauce' }
    ];
    const scores = computeBm25Scores('zookeeper quorum', docs);
    expect(scores.get('a')!).toBeGreaterThan(scores.get('b')!);
    expect(scores.get('b')).toBe(0);
  });
});

describe('minMaxNormalizer — large candidate sets', () => {
  it('does not crash (RangeError from Math.min/max(...spread)) on a 1e6-element array, and still normalizes correctly', () => {
    const size = 1_000_000;
    const values = new Array<number>(size);
    for (let i = 0; i < size; i += 1) values[i] = i;
    let normalize!: (v: number) => number;
    expect(() => { normalize = minMaxNormalizer(values); }).not.toThrow();
    expect(normalize(0)).toBe(0);
    expect(normalize(size - 1)).toBe(1);
    expect(normalize(values[size / 2])).toBeCloseTo(0.5, 5);
  });
});

describe('ragSearchSync — hybrid (BM25 + cosine) ranking', () => {
  it('a short chunk with an exact rare-term match outranks a longer unrelated chunk, under the default alpha', async () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    try {
      const quorumPath = join(dir, 'quorum.md');
      writeFileSync(quorumPath, '# HCI cluster quorum design note\n\nquorum');
      await ingestDocument({ filePath: quorumPath, product: 'HCI', indexPath, title: 'Quorum note' });

      const unrelatedPath = join(dir, 'unrelated.md');
      writeFileSync(unrelatedPath, '# Completely unrelated document\n\ncooking recipe for pasta with tomato sauce and basil');
      await ingestDocument({ filePath: unrelatedPath, product: 'HCI', indexPath, title: 'Unrelated doc' });
    } finally {
      delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
    }

    const hits = ragSearchSync({ product: 'HCI', query: 'quorum', indexPath });
    expect(hits[0]?.title).toBe('Quorum note');
    expect(hits[0]?.keywordScore).toBeGreaterThan(0);
  });

  it('a chunk that vector-only ranking prefers (repeated shared terms, no rare term) is outranked by hybrid search once BM25 is weighted in', async () => {
    // Empirical case: "Rotation schedule" repeats "rotation policy" 60x, which
    // dominates hashed bag-of-words cosine similarity (repetition inflates the
    // additive hash buckets). "Keyring note" states the query's rare term
    // ("keyring") plus "rotation policy" exactly once each — BM25's IDF
    // weighting (rare term = high IDF) and lack of raw-repetition bias rank it
    // first once BM25 has any real weight in the composite score.
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    try {
      const rarePath = join(dir, 'rare.md');
      writeFileSync(rarePath, '# Keyring policy note\n\nkeyring rotation policy applies to all endpoints');
      await ingestDocument({ filePath: rarePath, product: 'HCI', indexPath, title: 'Keyring note' });

      const dominantPath = join(dir, 'dominant.md');
      const repeated = Array.from({ length: 60 }, () => 'rotation policy').join(' ');
      writeFileSync(dominantPath, `# Rotation policy schedule\n\n${repeated}`);
      await ingestDocument({ filePath: dominantPath, product: 'HCI', indexPath, title: 'Rotation schedule' });
    } finally {
      delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
    }

    const query = 'keyring rotation policy';

    process.env.SANGFOR_RAG_HYBRID_ALPHA = '1'; // cosine-only
    const cosineOnly = ragSearchSync({ product: 'HCI', query, indexPath });
    expect(cosineOnly[0]?.title).toBe('Rotation schedule'); // vector-only mistake, confirmed empirically

    process.env.SANGFOR_RAG_HYBRID_ALPHA = '0'; // bm25-only
    const bm25Only = ragSearchSync({ product: 'HCI', query, indexPath });
    expect(bm25Only[0]?.title).toBe('Keyring note'); // BM25 corrects it

    // Default alpha (0.5) — BM25 already has enough weight to flip the top rank
    // relative to cosine-only, proving the composite score genuinely blends both.
    delete process.env.SANGFOR_RAG_HYBRID_ALPHA;
    const defaultHits = ragSearchSync({ product: 'HCI', query, indexPath });
    expect(defaultHits[0]?.title).toBe('Keyring note');
  });

  it('alpha=1 (cosine-only) reproduces the same ranking order as plain cosine similarity', async () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    try {
      const rarePath = join(dir, 'rare.md');
      writeFileSync(rarePath, '# Keyring policy note\n\nkeyring rotation policy applies to all endpoints');
      await ingestDocument({ filePath: rarePath, product: 'HCI', indexPath, title: 'Keyring note' });

      const dominantPath = join(dir, 'dominant.md');
      const repeated = Array.from({ length: 60 }, () => 'rotation policy').join(' ');
      writeFileSync(dominantPath, `# Rotation policy schedule\n\n${repeated}`);
      await ingestDocument({ filePath: dominantPath, product: 'HCI', indexPath, title: 'Rotation schedule' });
    } finally {
      delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
    }

    process.env.SANGFOR_RAG_HYBRID_ALPHA = '1';
    const hits = ragSearchSync({ product: 'HCI', query: 'keyring rotation policy', indexPath });
    const byCosine = [...hits].sort((a, b) => b.cosineScore - a.cosineScore).map((h) => h.id);
    expect(hits.map((h) => h.id)).toEqual(byCosine);
  });
});
