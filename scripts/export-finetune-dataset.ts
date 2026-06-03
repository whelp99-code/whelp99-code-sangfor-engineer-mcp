import { createFineTuneDataset, createFineTuneJobSpec } from '../packages/sangfor-finetune/src/index.js';

const product = process.argv[2] ?? 'HCI';
const taskType = 'config_planning';
const dataset = createFineTuneDataset({
  product,
  taskType,
  examples: [
    {
      input: 'Create a Sangfor HCI 3-node deployment plan for a VMware migration PoC.',
      expectedOutput: 'Include project summary, precheck, MTU/storage network validation, migration plan, approval gates, rollback plan, and validation plan.',
      source: 'seed-example'
    }
  ]
});
const job = createFineTuneJobSpec({ product, taskType, datasetPath: dataset.path });
console.log(JSON.stringify({ dataset, job }, null, 2));
