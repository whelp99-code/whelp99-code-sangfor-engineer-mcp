import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

const [filePath, product, version] = process.argv.slice(2);
if (!filePath || !product) {
  console.error('Usage: npm run ingest:docs -- <filePath> <product> [version]');
  process.exit(1);
}
const result = await ingestDocument({ filePath, product, version });
console.log(JSON.stringify({ result, summary: exportRagIndexSummary() }, null, 2));
