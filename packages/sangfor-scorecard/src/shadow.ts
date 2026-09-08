/**
 * Shadow mode (design 002, block G2).
 *
 * A new automation runs silently: it records what it *would* have done, humans
 * keep doing the work, and only a measured agreement rate over a large enough
 * sample earns activation. Two append-only JSONL ledgers (automated / human)
 * keep the comparison reconstructible after the fact.
 *
 * The agreement predicate is injected — this package never guesses what "the
 * same action" means for a given automation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, nowId } from '@sangfor/shared';
import type { NamedRuntimeCodec } from '../../shared/src/runtime-schema.js';
import {
  humanActionCodec,
  parseBoundaryShadowLedgerLineV1,
  shadowRunCodec,
} from './runtime-boundaries.js';

export type ShadowAction = Record<string, unknown>;

export interface RecordShadowRunInput {
  automationId: string;
  findingId: string;
  automatedAction: ShadowAction;
  at: string;
}

export interface RecordHumanActionInput {
  automationId: string;
  findingId: string;
  humanAction: ShadowAction;
  at: string;
}

export interface ShadowRunEntry {
  id: string;
  kind: 'shadow-run';
  automationId: string;
  findingId: string;
  automatedAction: ShadowAction;
  at: string;
}

export interface HumanActionEntry {
  id: string;
  kind: 'human-action';
  automationId: string;
  findingId: string;
  humanAction: ShadowAction;
  at: string;
}

export interface ShadowDisagreement {
  findingId: string;
  automatedAction: ShadowAction;
  humanAction: ShadowAction;
}

export interface ShadowAgreementResult {
  automationId: string;
  /** Findings where BOTH a shadow run and a human action exist. */
  compared: number;
  agreed: number;
  /** agreed / compared, or 0 when nothing was comparable. */
  agreementRate: number;
  disagreements: ShadowDisagreement[];
}

export interface ActivationPolicy {
  minCompared: number;
  minRate: number;
}

/** Decides whether an automated action matches what the human actually did. */
export type ShadowMatcher = (automated: ShadowAction, human: ShadowAction) => boolean;

const SHADOW_RUNS_FILE = 'shadow-runs.jsonl';
const HUMAN_ACTIONS_FILE = 'human-actions.jsonl';

function readEntries<T>(path: string, codec: NamedRuntimeCodec<T>): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    entries.push(parseBoundaryShadowLedgerLineV1(trimmed, codec));
  }
  return entries;
}

/** Record what the automation would have done, without doing it. */
export function recordShadowRun(ledgerDir: string, input: RecordShadowRunInput): ShadowRunEntry {
  const entry: ShadowRunEntry = { id: nowId('shadow'), kind: 'shadow-run', ...input };
  appendJsonl(join(ledgerDir, SHADOW_RUNS_FILE), entry);
  return entry;
}

/** Record what a human actually did for the same finding. */
export function recordHumanAction(ledgerDir: string, input: RecordHumanActionInput): HumanActionEntry {
  const entry: HumanActionEntry = { id: nowId('human'), kind: 'human-action', ...input };
  appendJsonl(join(ledgerDir, HUMAN_ACTIONS_FILE), entry);
  return entry;
}

/**
 * Compare the two ledgers for one automation. Only findings present in both
 * count: a shadow run nobody adjudicated is not evidence of agreement, and a
 * human action the automation never saw is not evidence of a miss. When either
 * side acted more than once for a finding, the latest record wins.
 */
export function shadowAgreement(
  ledgerDir: string,
  automationId: string,
  matcher: ShadowMatcher,
): ShadowAgreementResult {
  const runs = readEntries(join(ledgerDir, SHADOW_RUNS_FILE), shadowRunCodec).filter(
    (entry) => entry.automationId === automationId,
  );
  const humans = readEntries(join(ledgerDir, HUMAN_ACTIONS_FILE), humanActionCodec).filter(
    (entry) => entry.automationId === automationId,
  );

  const latestHuman = new Map<string, HumanActionEntry>();
  for (const entry of humans) {
    const seen = latestHuman.get(entry.findingId);
    if (!seen || entry.at >= seen.at) latestHuman.set(entry.findingId, entry);
  }
  const latestRun = new Map<string, ShadowRunEntry>();
  for (const entry of runs) {
    const seen = latestRun.get(entry.findingId);
    if (!seen || entry.at >= seen.at) latestRun.set(entry.findingId, entry);
  }

  let compared = 0;
  let agreed = 0;
  const disagreements: ShadowDisagreement[] = [];
  for (const [findingId, run] of latestRun) {
    const human = latestHuman.get(findingId);
    if (!human) continue;
    compared += 1;
    if (matcher(run.automatedAction, human.humanAction)) {
      agreed += 1;
    } else {
      disagreements.push({
        findingId,
        automatedAction: run.automatedAction,
        humanAction: human.humanAction,
      });
    }
  }

  return {
    automationId,
    compared,
    agreed,
    agreementRate: compared === 0 ? 0 : agreed / compared,
    disagreements,
  };
}

/**
 * Activation gate. Sample size is checked first and unconditionally: three
 * lucky matches are not evidence, so anything below `minCompared` stays in
 * shadow no matter how perfect its rate looks.
 */
export function activationDecision(
  agreement: ShadowAgreementResult,
  policy: ActivationPolicy,
): 'activate' | 'keep-shadow' {
  if (agreement.compared < policy.minCompared || agreement.compared === 0) return 'keep-shadow';
  return agreement.agreementRate >= policy.minRate ? 'activate' : 'keep-shadow';
}
