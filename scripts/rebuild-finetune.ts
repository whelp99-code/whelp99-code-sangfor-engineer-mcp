import { readFileSync } from 'node:fs';
import {
  docsToFineTuneExamples,
  loadCollectedManifest,
  type CollectedDocument
} from '../packages/sangfor-collector/src/index.js';
import { createFineTuneDataset, validateFineTuneDataset } from '../packages/sangfor-finetune/src/index.js';

const manifest = loadCollectedManifest('data/sources/manifest.json') as CollectedDocument[];
const examples = docsToFineTuneExamples(manifest);
const dataset = createFineTuneDataset({
  product: 'HCI',
  taskType: 'lesson_extraction',
  outputPath: 'data/finetune/sangfor-sources.jsonl',
  examples
});
const validation = validateFineTuneDataset(dataset.path);
console.log(JSON.stringify({ count: dataset.count, validation }, null, 2));
if (!validation.ok) process.exit(1);
