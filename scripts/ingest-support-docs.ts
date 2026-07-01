/**
 * Ingest the collected Sangfor Support docs (markdown sections + product-manual PDFs)
 * into the local RAG index, tagged by product/version parsed from paths.
 *
 *   pnpm exec tsx scripts/ingest-support-docs.ts
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

const ROOT = process.env.SUPPORT_DOCS_ROOT ?? '/Volumes/My Passport/00. Attached/_SupportDocs';
const INDEX = process.env.SANGFOR_RAG_INDEX ?? 'data/rag/index.json';
const PDF = process.env.INGEST_PDF === '1'; // opt-in: large PDFs are slow to parse

function tagFromName(name: string): { product: string; version: string } {
  const n = name.toLowerCase();
  let product = 'HCI';
  if (/iag|swg/.test(n)) product = 'IAG';
  else if (/epp|endpoint/.test(n)) product = 'ENDPOINT_SECURE';
  else if (/ndr|cyber/.test(n)) product = 'CYBER_COMMAND';
  else if (/xdr/.test(n)) product = 'NDR';
  else if (/ngfw|firewall/.test(n)) product = 'HCI';
  else if (/hci|asv/.test(n)) product = 'HCI';
  const ver = name.match(/(\d+\.\d+\.\d+[A-Za-z0-9]*)/)?.[1] ?? '';
  return { product, version: ver };
}

function mdFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => join(dir, f));
}

async function main() {
  if (!existsSync(ROOT)) { console.error(`ROOT not found: ${ROOT}`); process.exit(1); }
  let docs = 0, chunks = 0, fail = 0;

  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith('.')) continue;
    const full = join(ROOT, entry);
    const st = statSync(full);

    if (st.isDirectory() && entry.endsWith('_content')) {
      const { product, version } = tagFromName(entry);
      const files = mdFiles(full);
      console.error(`[dir] ${entry} → ${product} ${version} (${files.length} md)`);
      for (const f of files) {
        try {
          const r = await ingestDocument({ filePath: f, product, version, sourceType: 'manual', trustLevel: 'official', title: `${product} ${version} — ${basename(f, '.md')}`, indexPath: INDEX });
          docs++; chunks += r.chunkCount;
        } catch (e) { fail++; }
      }
      console.error(`[dir] done ${entry}: ${docs} docs / ${chunks} chunks so far`);
    } else if (st.isFile() && entry.endsWith('.pdf') && !entry.startsWith('._')) {
      if (!PDF) { console.error(`[skip pdf] ${entry} (set INGEST_PDF=1 to include)`); continue; }
      const { product, version } = tagFromName(entry);
      try {
        console.error(`[pdf] ${entry} → ${product} ${version} …`);
        const r = await ingestDocument({ filePath: full, product, version, sourceType: 'manual', trustLevel: 'official', title: `${product} ${version} User Manual`, indexPath: INDEX });
        docs++; chunks += r.chunkCount;
        console.error(`[pdf] ${entry}: ${r.chunkCount} chunks`);
      } catch (e) { fail++; console.error(`[pdf-fail] ${entry}: ${String(e).slice(0, 100)}`); }
    }
  }

  console.error(`\n==== INGEST DONE: ${docs} docs, ${chunks} chunks, ${fail} failed ====`);
  console.error('RAG summary:', JSON.stringify(exportRagIndexSummary(INDEX), null, 2));
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
