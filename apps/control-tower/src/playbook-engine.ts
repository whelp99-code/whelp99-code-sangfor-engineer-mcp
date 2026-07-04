import type { RunRecord, RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import type { Playbook, PlaybookRevision } from './playbook-store.js';

export type PlaybookRunStatus = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'partial';

export class TemplateError extends Error {
  constructor(public readonly template: string) { super(`템플릿 해석 실패: ${template}`); }
}

// {{blocks.<id>.result<.dot.path>}} — id/path는 [A-Za-z0-9_-]
const TEMPLATE_G = /\{\{\s*blocks\.([A-Za-z0-9_-]+)\.result((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const TEMPLATE_EXACT = /^\{\{\s*blocks\.([A-Za-z0-9_-]+)\.result((?:\.[A-Za-z0-9_-]+)*)\s*\}\}$/;

type Lookup = (blockId: string) => RunRecord | undefined;

function resolvePath(root: unknown, dotPath: string): unknown {
  if (!dotPath) return root; // '.result' 전체
  let cur = root;
  for (const key of dotPath.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') throw new TemplateError(`{{...result${dotPath}}}`);
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) throw new TemplateError(`{{...result${dotPath}}}`);
  }
  return cur;
}

function resolveOne(blockId: string, dotPath: string, lookup: Lookup): unknown {
  const rec = lookup(blockId);
  if (!rec || rec.status !== 'succeeded' || rec.resultJson === undefined) {
    throw new TemplateError(`{{blocks.${blockId}.result${dotPath}}}`);
  }
  return resolvePath(rec.resultJson, dotPath);
}

function resolveString(str: string, lookup: Lookup): unknown {
  const exact = str.match(TEMPLATE_EXACT);
  if (exact) return resolveOne(exact[1], exact[2], lookup); // 타입 보존
  return str.replace(TEMPLATE_G, (_m, id: string, path: string) => String(resolveOne(id, path, lookup)));
}

// 실패 시 TemplateError throw. 자기 playbookRun 내 블록만 lookup으로 넘어온다(§7.3 격리는 호출자 책임).
export function resolveTemplates(args: Record<string, unknown>, lookup: Lookup): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return resolveString(value, lookup);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(args) as Record<string, unknown>;
}

// 접근법 B: 리비전 블록 목록 + 블록 run 태그에서 상태를 유도 (별도 상태 레코드 없음).
export function derivePlaybookRunStatus(
  revision: PlaybookRevision,
  blockRuns: RunRecord[],
): { status: PlaybookRunStatus; blocks: Array<{ blockId: string; runId?: string; status?: RunStatus }> } {
  const byBlock = new Map<string, RunRecord>();
  for (const r of blockRuns) {
    if (!r.blockId) continue;
    const prev = byBlock.get(r.blockId);
    if (!prev || r.requestedAt > prev.requestedAt) byBlock.set(r.blockId, r);
  }
  const blocks = revision.blocks.map((b) => {
    const r = byBlock.get(b.id);
    return { blockId: b.id, runId: r?.runId, status: r?.status };
  });
  const statuses = blocks.map((b) => b.status);
  const reportBlock = revision.blocks.find((b) => b.type === 'report');
  const reportRun = reportBlock ? byBlock.get(reportBlock.id) : undefined;

  if (statuses.includes('pending_approval')) return { status: 'waiting_approval', blocks };
  if (statuses.includes('running')) return { status: 'running', blocks };
  if (statuses.some((s) => s === 'failed' || s === 'rejected')) {
    return { status: reportRun?.status === 'succeeded' ? 'partial' : 'failed', blocks };
  }
  if (statuses.every((s) => s === 'succeeded')) return { status: 'succeeded', blocks };
  return { status: 'running', blocks }; // 실패·대기·진행 없고 아직 시작 안 한 블록 남음
}

// v1 summarize의 EvaluationResult 판정과 동형 — 직접 | .evaluation | .evaluations[] 래핑 지원.
interface EvalItem { verdict: string; label: string; observed?: unknown; expected?: unknown; reason: string }
function evalItemsOf(resultJson: unknown): EvalItem[] {
  const pull = (e: unknown): EvalItem[] => {
    const items = (e as { items?: unknown })?.items;
    return Array.isArray(items)
      ? items.filter((i): i is EvalItem => !!i && typeof (i as EvalItem).verdict === 'string' && typeof (i as EvalItem).label === 'string')
      : [];
  };
  if (!resultJson || typeof resultJson !== 'object') return [];
  const r = resultJson as { items?: unknown; evaluation?: unknown; evaluations?: unknown[] };
  if (Array.isArray(r.items)) return pull(r);
  if (r.evaluation) return pull(r.evaluation);
  if (Array.isArray(r.evaluations)) return r.evaluations.flatMap(pull);
  return [];
}

// 결정적(LLM 없음). report 블록 이전의 블록 run들을 마크다운으로 집계.
export function renderReport(playbook: Playbook, rev: number, playbookRunId: string, blockRuns: RunRecord[]): string {
  const revision = playbook.revisions.find((r) => r.rev === rev);
  const byBlock = new Map<string, RunRecord>();
  for (const r of blockRuns) if (r.blockId) byBlock.set(r.blockId, r);
  const L: string[] = [];
  L.push(`# 플레이북 종합 리포트: ${playbook.name}`);
  L.push('');
  L.push(`- 목표: ${playbook.goal}`);
  L.push(`- 리비전: rev ${rev} · 실행 ID: ${playbookRunId}`);
  L.push('');

  const fails: Array<{ label: string; observed: string; expected: string; reason: string }> = [];
  const toolBlocks = (revision?.blocks ?? []).filter((b) => b.type === 'tool');
  for (const block of toolBlocks) {
    const r = byBlock.get(block.id);
    if (!r) continue; // 앞선 블록만 집계 (미실행은 생략)
    L.push(`## ${block.title ?? block.id} (${block.toolId})`);
    if (block.deviceId) L.push(`- 장비: ${block.deviceId}`);
    L.push(`- 상태: ${r.status}${r.resultSummary ? ` · ${r.resultSummary}` : ''}`);
    L.push(`- runId: ${r.runId}`);
    for (const item of evalItemsOf(r.resultJson)) {
      if (item.verdict === 'FAIL') {
        fails.push({ label: item.label, observed: String(item.observed ?? '-'), expected: String(item.expected ?? '-'), reason: item.reason });
      }
    }
    L.push('');
  }

  if (fails.length) {
    L.push('## FAIL 항목');
    L.push('');
    L.push('| 항목 | 관측 | 기대 | 사유 |');
    L.push('|---|---|---|---|');
    for (const f of fails) L.push(`| ${f.label} | ${f.observed} | ${f.expected} | ${f.reason} |`);
    L.push('');
    L.push('## 개선권고');
    for (const f of fails) L.push(`- **${f.label}**: ${f.reason}`);
    L.push('');
  } else {
    L.push('## FAIL 항목');
    L.push('');
    L.push('없음 (집계 대상 블록에서 FAIL 미검출).');
    L.push('');
  }

  L.push('---');
  L.push('> 이 보고서는 기계 집계입니다. AI 분석은 별도 아티팩트로 제출됩니다.');
  L.push('');
  return L.join('\n');
}
