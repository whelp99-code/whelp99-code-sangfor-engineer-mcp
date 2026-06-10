/**
 * Sync all learned data to PostgreSQL database.
 * - Products (EPP, IAG, CC, HCI, NDR)
 * - RAG document metadata
 * - Manual metadata from manifest
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';

loadEnvFile('.env');

const db = new PrismaClient();

interface RagChunk {
  id: string;
  sourceType: string;
  product: string;
  title: string;
  section?: string;
  text: string;
  trustLevel?: string;
  vector?: number[];
}

interface RagIndex {
  version: number;
  chunks: RagChunk[];
}

interface ManifestEntry {
  id: string;
  product: string;
  version?: string;
  title: string;
  sourceType: string;
  sourceUrl?: string;
  filePath?: string;
  trustLevel?: string;
}

async function main() {
  console.log('=== DB 동기화 시작 ===\n');

  // ── 1. Products ──
  console.log('[1] Products 등록...');
  const products = [
    { code: 'EPP', name: 'Athena EPP (Endpoint Protection Platform)', priority: 1 },
    { code: 'CC', name: 'Cyber Command (XDR/SIEM)', priority: 2 },
    { code: 'IAG', name: 'IAG (Internet Access Gateway)', priority: 3 },
    { code: 'HCI', name: 'HCI (Hyper-Converged Infrastructure)', priority: 4 },
    { code: 'NDR', name: 'Athena NDR (Network Detection & Response)', priority: 5 },
    { code: 'ENDPOINT_SECURE', name: 'Endpoint Secure (Legacy)', priority: 6 },
    { code: 'CYBER_COMMAND', name: 'Cyber Command (Legacy)', priority: 7 },
  ];

  for (const p of products) {
    await db.sangforProduct.upsert({
      where: { code: p.code },
      create: p,
      update: { name: p.name, priority: p.priority },
    });
    console.log(`  ✅ ${p.code}: ${p.name}`);
  }

  // ── 2. Manifest → Manuals ──
  console.log('\n[2] Manifest에서 Manual 등록...');
  try {
    const manifest: ManifestEntry[] = JSON.parse(
      readFileSync('data/sources/manifest.json', 'utf8'),
    );
    let manualCount = 0;
    for (const m of manifest) {
      await db.sangforManual.upsert({
        where: { id: m.id },
        create: {
          id: m.id,
          product: m.product,
          version: m.version ?? null,
          title: m.title,
          sourceType: (m as any).sourceType ?? (m as any).source ?? 'knowledge',
          sourceUrl: m.sourceUrl ?? null,
          filePath: m.filePath ?? null,
          trustLevel: m.trustLevel ?? 'needs_review',
        },
        update: {
          title: m.title,
          trustLevel: m.trustLevel ?? 'needs_review',
        },
      });
      manualCount++;
    }
    console.log(`  ✅ ${manualCount}개 Manual 등록`);
  } catch (err) {
    console.log(`  ⚠️ manifest.json 읽기 실패: ${err}`);
  }

  // ── 3. RAG Index → RAG Documents ──
  console.log('\n[3] RAG 인덱스에서 문서 메타데이터 등록...');
  try {
    const ragIndex: RagIndex = JSON.parse(
      readFileSync('data/rag/index.json', 'utf8'),
    );

    // Deduplicate by title+product (chunks share the same document)
    const docMap = new Map<string, { product: string; title: string; sourceType: string; chunkCount: number }>();
    for (const chunk of ragIndex.chunks) {
      const key = `${chunk.product}:${chunk.title}`;
      const existing = docMap.get(key);
      if (existing) {
        existing.chunkCount++;
      } else {
        docMap.set(key, {
          product: chunk.product,
          title: chunk.title,
          sourceType: chunk.sourceType,
          chunkCount: 1,
        });
      }
    }

    let docCount = 0;
    for (const [key, doc] of Array.from(docMap.entries())) {
      const contentHash = `${doc.product}_${doc.title}`.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      await db.sangforRagDocument.upsert({
        where: { contentHash },
        create: {
          productCode: doc.product,
          title: doc.title,
          sourceType: doc.sourceType,
          filePath: `data/rag/index.json`,
          contentHash,
        },
        update: {
          title: doc.title,
        },
      });
      docCount++;
    }
    console.log(`  ✅ ${docCount}개 RAG 문서 등록 (총 ${ragIndex.chunks.length} chunks)`);
  } catch (err) {
    console.log(`  ⚠️ RAG index 읽기 실패: ${err}`);
  }

  // ── 4. Summary ──
  console.log('\n=== DB 동기화 완료 ===');
  const productCount = await db.sangforProduct.count();
  const manualCount = await db.sangforManual.count();
  const ragDocCount = await db.sangforRagDocument.count();
  console.log(`  Products: ${productCount}`);
  console.log(`  Manuals: ${manualCount}`);
  console.log(`  RAG Documents: ${ragDocCount}`);

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error('Error:', err.message);
  await db.$disconnect();
  process.exit(1);
});
