import type { EngineerRequirement } from '../../shared/src/engineer-case-contract.js';
import { isExternalFileReference } from './engineer-requirement-guard.js';
import type {
  EngineerRequirementIngestInput,
  EngineerRequirementQuestion,
  EngineerRequirementQuestionKind,
} from './engineer-requirement-ingest.js';
import type { ExcelRequirementRow } from './types.js';

const DIRECTIVE_RE = /(?:\b(?:curl|wget|ssh|chmod|sudo|pnpm|npm|bash|sh)\b|\bsangfor_[a-z0-9_]+\b|run (?:the )?(?:tool|command)|execute (?:tool|command)|extract (?:the )?(?:password|secret|token)|도구를 실행|비밀번호를 추출)/iu;
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(GiB|TiB|MiB|KiB|GB|TB|MB|KB|percent|%|기가|G)\b/giu;
const SECRET_RE = /(?:password|secret|token|authorization|cookie|비밀번호|패스워드|토큰)\s*[:=]\s*\S+/giu;

export type MappedRequirementSource = {
  readonly requirements: EngineerRequirement[];
  readonly sourceTexts: Map<string, string>;
};

function sanitizeId(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
  return cleaned.length > 0 ? cleaned : fallback;
}

function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, (match) => `${match.split(/[:=]/u)[0]}=***`);
}

function hasSecretShape(text: string): boolean {
  return /(?:password|secret|token|authorization|cookie|비밀번호|패스워드|토큰)\s*[:=]\s*\S+/iu.test(text);
}

function constraintIsInferred(sourceText: string, rawConstraint: string, redactedConstraint: string): boolean {
  if (sourceText.includes(rawConstraint)) return false;
  return !redactSecrets(sourceText).includes(redactedConstraint);
}

function unitIssue(text: string): string | undefined {
  const matches = [...text.matchAll(UNIT_RE)].map((item) => item[2]?.toLowerCase() ?? '');
  if (matches.some((unit) => unit === 'g' || unit === '기가')) return 'ambiguous bare G/기가 unit';
  const binary = matches.some((unit) => ['gib', 'tib', 'mib', 'kib'].includes(unit));
  const decimal = matches.some((unit) => ['gb', 'tb', 'mb', 'kb'].includes(unit));
  if (binary && decimal) return 'mixed GB/GiB family units';
  return undefined;
}

function question(
  kind: EngineerRequirementQuestionKind,
  requirementIds: readonly string[],
  sourceRefs: readonly string[],
  message: string,
  index: number,
): EngineerRequirementQuestion {
  return { id: `q-${kind}-${index + 1}`, kind, requirementIds, sourceRefs, message };
}

function mappedRequirement(input: {
  readonly id: string;
  readonly sourceRef: string;
  readonly sourceText: string;
  readonly target?: string;
  readonly constraint?: string;
  readonly priority: EngineerRequirement['priority'];
  readonly confirmationState: EngineerRequirement['confirmationState'];
  readonly acceptanceCriterion: string;
  readonly revision: string;
  readonly caseId: string;
  readonly projectId: string;
}): EngineerRequirement {
  const rawConstraint = input.constraint?.trim() || undefined;
  const constraint = rawConstraint ? redactSecrets(rawConstraint) : undefined;
  const target = input.target?.trim() ? redactSecrets(input.target) : undefined;
  const inferred = Boolean(constraint && rawConstraint && constraintIsInferred(input.sourceText, rawConstraint, constraint));
  const sourceKind = !constraint && !target ? 'unknown' : inferred ? 'proposed' : 'provided';
  return {
    id: input.id,
    caseId: input.caseId,
    projectId: input.projectId,
    sourceKind,
    sourceRef: input.sourceRef,
    ...(target ? { target } : {}),
    ...(constraint ? { constraint } : {}),
    priority: input.priority,
    confirmationState: inferred ? 'unconfirmed' : input.confirmationState,
    acceptanceCriterion: redactSecrets(input.acceptanceCriterion),
    revision: input.revision,
  };
}

export function collectRequirementQuestions(
  requirements: readonly EngineerRequirement[],
  sourceTexts: ReadonlyMap<string, string>,
  allowedRoot: string | undefined,
): EngineerRequirementQuestion[] {
  const questions: EngineerRequirementQuestion[] = [];
  const byItem = new Map<string, EngineerRequirement[]>();
  const byText = new Map<string, EngineerRequirement[]>();

  for (const requirement of requirements) {
    const itemKey = (requirement.target ?? requirement.sourceRef).trim().toLowerCase();
    byItem.set(itemKey, [...(byItem.get(itemKey) ?? []), requirement]);
    const textKey = `${requirement.constraint ?? ''} ${requirement.acceptanceCriterion}`.trim().toLowerCase();
    byText.set(textKey, [...(byText.get(textKey) ?? []), requirement]);
    const source = sourceTexts.get(requirement.id) ?? '';
    if (!requirement.constraint && !requirement.target) {
      questions.push(question('missing', [requirement.id], [requirement.sourceRef], 'Target/constraint is missing and was not defaulted', questions.length));
    }
    const unit = unitIssue(`${requirement.constraint ?? ''} ${requirement.acceptanceCriterion} ${source}`);
    if (unit) questions.push(question('ambiguous_unit', [requirement.id], [requirement.sourceRef], unit, questions.length));
    if (DIRECTIVE_RE.test(source)) {
      questions.push(question('document_directive', [requirement.id], [requirement.sourceRef], 'Document instruction treated as data; not executed', questions.length));
    }
    if (hasSecretShape(source) || hasSecretShape(requirement.constraint ?? '') || hasSecretShape(requirement.acceptanceCriterion)) {
      questions.push(question('secret_redacted', [requirement.id], [requirement.sourceRef], 'Secret-shaped text was redacted and not extracted', questions.length));
    }
    if (allowedRoot && isExternalFileReference(source, allowedRoot)) {
      questions.push(question('cross_customer_file', [requirement.id], [requirement.sourceRef], 'External customer file reference was not followed', questions.length));
    }
    if (requirement.sourceKind === 'proposed') {
      questions.push(question('unconfirmed_inference', [requirement.id], [requirement.sourceRef], 'Inferred constraint kept as proposed until confirmed', questions.length));
    }
  }

  for (const group of byItem.values()) {
    const constraints = new Set(group.map((item) => item.constraint ?? ''));
    if (group.length > 1 && constraints.size > 1) {
      questions.push(question('conflict', group.map((item) => item.id), group.map((item) => item.sourceRef), 'Conflicting targets were not auto-selected', questions.length));
    }
  }
  for (const group of byText.values()) {
    if (group.length > 1) {
      questions.push(question('duplicate', group.map((item) => item.id), group.map((item) => item.sourceRef), 'Duplicate requirement text kept without merge', questions.length));
    }
  }
  return questions;
}

export function mapExcelRowsToRequirements(
  rows: readonly ExcelRequirementRow[],
  input: EngineerRequirementIngestInput,
  sheetName: string,
): MappedRequirementSource {
  const used = new Set<string>();
  const requirements: EngineerRequirement[] = [];
  const sourceTexts = new Map<string, string>();
  for (const row of rows) {
    const base = sanitizeId(`req-${row.no ?? row.rowId}`, `req-row-${row.rowNumber}`);
    const id = used.has(base) ? sanitizeId(`${base}-${row.rowNumber}`, `req-row-${row.rowNumber}`) : base;
    used.add(id);
    const sourceText = [row.requirement, row.targetControl, row.currentGap, row.remark, row.assessmentCriteria].filter(Boolean).join(' | ');
    const confirmationState = /\bconfirmed\b/iu.test(row.remark ?? '') ? 'confirmed' : 'unconfirmed';
    requirements.push(mappedRequirement({
      id,
      sourceRef: `excel:${sheetName}:row:${row.rowNumber}`,
      sourceText,
      target: row.item || row.solution,
      constraint: row.assessmentCriteria || row.targetControl || undefined,
      priority: row.priority,
      confirmationState,
      acceptanceCriterion: row.assessmentCriteria || row.targetControl || 'unspecified; do not default',
      revision: input.revision,
      caseId: input.caseId,
      projectId: input.projectId,
    }));
    sourceTexts.set(id, sourceText);
  }
  return { requirements, sourceTexts };
}

export function mapTextsToRequirements(
  texts: readonly string[],
  input: EngineerRequirementIngestInput,
): MappedRequirementSource {
  const requirements: EngineerRequirement[] = [];
  const sourceTexts = new Map<string, string>();
  texts.forEach((text, index) => {
    const id = `req-t-${index + 1}`;
    const trimmed = text.trim();
    requirements.push(mappedRequirement({
      id,
      sourceRef: `text:${index + 1}`,
      sourceText: trimmed,
      target: trimmed.split(/\s+/u).slice(0, 8).join(' ') || undefined,
      constraint: trimmed || undefined,
      priority: 'medium',
      confirmationState: 'unconfirmed',
      acceptanceCriterion: trimmed || 'unspecified; do not default',
      revision: input.revision,
      caseId: input.caseId,
      projectId: input.projectId,
    }));
    sourceTexts.set(id, trimmed);
  });
  return { requirements, sourceTexts };
}

export function applyUnconfirmedInferences(
  requirements: readonly EngineerRequirement[],
  sourceTexts: ReadonlyMap<string, string>,
  inferences: EngineerRequirementIngestInput['unconfirmedInferences'],
): EngineerRequirement[] {
  if (!inferences?.length) return [...requirements];
  return requirements.map((requirement) => {
    const source = sourceTexts.get(requirement.id) ?? '';
    const match = inferences.find((item) => source.toLowerCase().includes(item.text.toLowerCase()));
    if (!match) return requirement;
    return {
      ...requirement,
      sourceKind: 'proposed',
      constraint: redactSecrets(match.constraint),
      confirmationState: 'unconfirmed',
    };
  });
}
