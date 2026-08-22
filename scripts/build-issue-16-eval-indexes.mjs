#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const inputs = [
  process.argv[2] ?? 'data/rag/index.json',
  process.argv[3] ?? 'data/evals/issue-14/e5-single-profile-index.json'
];
const outputs = [
  process.argv[4] ?? 'data/evals/issue-16/baseline-reconciled-index.json',
  process.argv[5] ?? 'data/evals/issue-16/e5-reconciled-index.json'
];

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function classifyProduct(chunk) {
  const title = chunk.title ?? '';
  if (/\b(?:Athena )?NGFW\b|Next-Generation Firewall|\bNGAF\b/i.test(title)) return 'NGFW';
  if (/Sangfor Data Center Cloud|\bSCC\b/i.test(title)) return 'SCC';
  return chunk.product;
}

export function titleVersion(title) {
  const prefix = String(title ?? '').split(' - ', 1)[0];
  const match = prefix.match(/\b(\d+\.\d+(?:\.\d+)?(?:R\d+)?)\b/i);
  if (match?.[0].split('.').length === 3 && /\b\d+\.\d+\.\d+\.\d+(?:\/\d+)?\b/.test(prefix)) return undefined;
  return match?.[1];
}

export function reconcileChunks(chunks, pathExists = existsSync) {
  const kept = [];
  let orphanChunksRemoved = 0, productCorrections = 0, versionCorrections = 0;
  for (const chunk of chunks) {
    if (!pathExists(chunk.filePath)) { orphanChunksRemoved += 1; continue; }
    const product = classifyProduct(chunk);
    const version = chunk.version ?? titleVersion(chunk.title);
    if (product !== chunk.product) productCorrections += 1;
    if (version !== chunk.version) versionCorrections += 1;
    kept.push({ ...chunk, product, ...(version ? { version } : {}) });
  }
  return { chunks: kept, orphanChunksRemoved, productCorrections, versionCorrections };
}

function main() {
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), indexes: [] };
for (let i = 0; i < inputs.length; i += 1) {
  const inputPath = inputs[i];
  const outputPath = outputs[i];
  const index = JSON.parse(readFileSync(inputPath, 'utf8'));
  const reconciled = reconcileChunks(index.chunks, (path) => existsSync(resolve(import.meta.dirname, '..', path)));
  const output = { ...index, chunks: reconciled.chunks };
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output));
  report.indexes.push({ inputPath, inputSha256: sha256(inputPath), inputBytes: statSync(inputPath).size, inputChunks: index.chunks.length, outputPath, outputSha256: sha256(outputPath), outputBytes: statSync(outputPath).size, outputChunks: reconciled.chunks.length, orphanChunksRemoved: reconciled.orphanChunksRemoved, productCorrections: reconciled.productCorrections, versionCorrections: reconciled.versionCorrections });
}
writeFileSync('data/evals/issue-16/index-reconciliation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
