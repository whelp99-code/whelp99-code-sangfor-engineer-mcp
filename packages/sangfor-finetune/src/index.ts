import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ProductCode, normalizeProduct, nowId } from '@sangfor/shared';

export type FineTuneTaskType = 'config_planning' | 'risk_classification' | 'lesson_extraction' | 'wiki_update_writing';

export interface FineTuneExample {
  id: string;
  product: ProductCode;
  taskType: FineTuneTaskType;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  metadata: Record<string, unknown>;
}

export interface FineTuneDatasetInput {
  product: string;
  taskType: FineTuneTaskType;
  examples: Array<{ input: string; expectedOutput: string; source?: string }>;
  outputPath?: string;
}

export interface FineTuneJobSpec {
  id: string;
  provider: 'openai' | 'local_lora' | 'manual_review';
  baseModel: string;
  datasetPath: string;
  validationDatasetPath?: string;
  product: ProductCode;
  taskType: FineTuneTaskType;
  status: 'draft' | 'ready_for_review' | 'submitted' | 'completed' | 'rejected';
  safetyNotes: string[];
  createdAt: string;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function buildFineTuneExample(input: { product: string; taskType: FineTuneTaskType; userInput: string; expectedOutput: string; source?: string }): FineTuneExample {
  const product = normalizeProduct(input.product);
  const systemPrompt = [
    'You are a Sangfor senior engineer assistant.',
    'Use only approved manuals, internal wiki, lessons learned, and verified patterns.',
    'Never invent product behavior. Mark unknowns as missing inputs.',
    'Dangerous operations require approval and rollback planning.'
  ].join(' ');
  return {
    id: nowId('ft_example'),
    product,
    taskType: input.taskType,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.userInput },
      { role: 'assistant', content: input.expectedOutput }
    ],
    metadata: { source: input.source ?? 'manual_review_required' }
  };
}

export function createFineTuneDataset(input: FineTuneDatasetInput): { path: string; count: number; examples: FineTuneExample[] } {
  const product = normalizeProduct(input.product);
  const outputPath = input.outputPath ?? `data/finetune/${product.toLowerCase()}-${input.taskType}.jsonl`;
  ensureParent(outputPath);
  const examples = input.examples.map(example => buildFineTuneExample({
    product,
    taskType: input.taskType,
    userInput: example.input,
    expectedOutput: example.expectedOutput,
    source: example.source
  }));
  writeFileSync(outputPath, examples.map(example => JSON.stringify({ messages: example.messages, metadata: { ...example.metadata, product, taskType: input.taskType } })).join('\n') + '\n');
  return { path: outputPath, count: examples.length, examples };
}

export function validateFineTuneDataset(path: string): { ok: boolean; count: number; errors: string[] } {
  if (!existsSync(path)) return { ok: false, count: 0, errors: [`Dataset not found: ${path}`] };
  const lines = readFileSync(path, 'utf8').split(/\n/).filter(Boolean);
  const errors: string[] = [];
  lines.forEach((line, idx) => {
    try {
      const row = JSON.parse(line) as { messages?: unknown };
      if (!Array.isArray(row.messages) || row.messages.length < 3) errors.push(`line ${idx + 1}: messages must include system/user/assistant`);
      const text = JSON.stringify(row).toLowerCase();
      if (/(password|otp|mfa|license key|secret)/i.test(text)) errors.push(`line ${idx + 1}: possible sensitive information`);
    } catch (error) {
      errors.push(`line ${idx + 1}: invalid JSONL`);
    }
  });
  return { ok: errors.length === 0, count: lines.length, errors };
}

export function createFineTuneJobSpec(input: { provider?: FineTuneJobSpec['provider']; baseModel?: string; datasetPath: string; validationDatasetPath?: string; product: string; taskType: FineTuneTaskType }): FineTuneJobSpec {
  const validation = validateFineTuneDataset(input.datasetPath);
  if (!validation.ok) throw new Error(`Fine-tune dataset is not valid: ${validation.errors.join('; ')}`);
  return {
    id: nowId('ft_job'),
    provider: input.provider ?? 'manual_review',
    baseModel: input.baseModel ?? 'review-required-before-selection',
    datasetPath: input.datasetPath,
    validationDatasetPath: input.validationDatasetPath,
    product: normalizeProduct(input.product),
    taskType: input.taskType,
    status: 'ready_for_review',
    safetyNotes: [
      'Fine-tuning data must be scrubbed for customer secrets and license keys.',
      'Fine-tuned model must not be allowed to execute production actions directly.',
      'Use fine-tuned output only as planner/risk-assistant input, not as an approval authority.'
    ],
    createdAt: new Date().toISOString()
  };
}
