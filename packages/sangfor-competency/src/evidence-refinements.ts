import { z } from 'zod';

type Result = 'pass' | 'fail' | 'indeterminate';
type Identity = { readonly actorId: string };
type Artifact = {
  readonly id: string;
  readonly kind: 'run' | 'readback' | 'restore' | 'negative' | 'audit';
  readonly createdAt: string;
};
type NegativeCase = {
  readonly id: string;
  readonly caseCode: string;
  readonly expectedRefusalCode: string;
  readonly observedRefusalCode: string;
  readonly result: Result;
  readonly artifactIds: readonly string[];
  readonly testedAt: string;
};
type Run = {
  readonly id: string;
  readonly result: Result;
  readonly executor: Identity;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly independentReadBack: {
    readonly verifier: Identity;
    readonly result: Result;
    readonly artifactId: string;
    readonly observedAt: string;
  };
  readonly postRunState:
    | { readonly mode: 'restored'; readonly result: Result; readonly readBackArtifactId: string }
    | { readonly mode: 'retained'; readonly result: Result };
  readonly mutationAttempted: boolean;
  readonly mutationCount: number;
  readonly retryCount: number;
  readonly collateralMutationCount: number;
  readonly artifactIds: readonly string[];
  readonly negativeCaseIds: readonly string[];
};
type Counters = Readonly<Record<(typeof O5_COUNTER_KEYS)[number], number>>;
type Manifest = {
  readonly generatedAt: string;
  readonly firmwareTruth: { readonly observedAt: string };
  readonly runs: readonly Run[];
  readonly artifacts: readonly Artifact[];
  readonly negativeCases: readonly NegativeCase[];
  readonly o5Counters: Counters;
};

export function refineNegativeCase(negativeCase: NegativeCase, context: z.RefinementCtx): void {
  if (negativeCase.result === 'pass' && negativeCase.observedRefusalCode !== negativeCase.expectedRefusalCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'pass requires the expected refusal code' });
  }
}

export function refineCapabilityEvidenceRun(run: Run, context: z.RefinementCtx): void {
  if (Date.parse(run.completedAt) < Date.parse(run.startedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'must not precede startedAt' });
  }
  if (Date.parse(run.independentReadBack.observedAt) < Date.parse(run.completedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['independentReadBack', 'observedAt'], message: 'must not precede completion' });
  }
  if (run.result === 'pass' && (run.postRunState.result !== 'pass' || run.independentReadBack.result !== 'pass')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'pass requires post-run and read-back pass' });
  }
  if (run.result === 'pass' && run.mutationAttempted
    && (run.mutationCount !== 1 || run.retryCount !== 0 || run.collateralMutationCount !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mutationCount'], message: 'mutation pass requires one dispatch and no retry or collateral mutation' });
  }
  if (run.mutationAttempted !== (run.mutationCount > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mutationAttempted'], message: 'must agree with mutationCount' });
  }
  if (run.executor.actorId === run.independentReadBack.verifier.actorId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['independentReadBack', 'verifier'], message: 'read-back verifier must be independent' });
  }
}

const O5_COUNTER_KEYS = [
  'runCount', 'passCount', 'failCount', 'indeterminateCount', 'independentReadBackPassCount',
  'negativeCasePassCount', 'restoredCount', 'retainedCount', 'mutationCount', 'retryCount',
  'collateralMutationCount',
] as const;

export function refineCapabilityEvidenceManifest(manifest: Manifest, context: z.RefinementCtx): void {
  const collections = [
    ['runs', manifest.runs.map(({ id }) => id)],
    ['artifacts', manifest.artifacts.map(({ id }) => id)],
    ['negativeCases', manifest.negativeCases.map(({ id }) => id)],
  ] as const;
  for (const [name, ids] of collections) {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [name, index, 'id'], message: 'duplicate id' });
      seen.add(id);
    });
  }
  const artifactsById = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const negativeCasesById = new Map(manifest.negativeCases.map((item) => [item.id, item]));
  const artifactOwnerCounts = new Map<string, number>();
  const negativeOwnerCounts = new Map<string, number>();
  const negativeOwnerById = new Map<string, Run>();
  const negativeArtifactCounts = new Map<string, number>();
  const executorIds = new Set(manifest.runs.map(({ executor }) => executor.actorId));
  if (manifest.runs.some(({ independentReadBack }) => executorIds.has(independentReadBack.verifier.actorId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['runs'], message: 'executor and reader roles must be disjoint' });
  }
  manifest.runs.forEach((run, index) => {
    const refs = [...run.artifactIds, run.independentReadBack.artifactId];
    switch (run.postRunState.mode) {
      case 'restored':
        refs.push(run.postRunState.readBackArtifactId);
        if (artifactsById.get(run.postRunState.readBackArtifactId)?.kind !== 'restore') {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['runs', index, 'postRunState'], message: 'restore requires dedicated evidence' });
        }
        break;
      case 'retained': break;
      default: run.postRunState satisfies never;
    }
    refs.forEach((id) => {
      if (!artifactsById.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['runs', index, 'artifactIds'], message: 'unknown artifact reference' });
    });
    new Set(refs).forEach((id) => artifactOwnerCounts.set(id, (artifactOwnerCounts.get(id) ?? 0) + 1));
    const readBackArtifact = artifactsById.get(run.independentReadBack.artifactId);
    if (readBackArtifact?.kind !== 'readback' || !run.artifactIds.some((id) => artifactsById.get(id)?.kind === 'run')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['runs', index, 'independentReadBack', 'artifactId'], message: 'read-back requires a dedicated artifact distinct from run evidence' });
    }
    run.artifactIds.forEach((id) => {
      const artifact = artifactsById.get(id);
      const lower = artifact?.kind === 'run' ? run.startedAt : run.completedAt;
      const upper = artifact?.kind === 'run' ? run.completedAt : run.independentReadBack.observedAt;
      if (artifact !== undefined && (Date.parse(artifact.createdAt) < Date.parse(lower)
        || Date.parse(artifact.createdAt) > Date.parse(upper))) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['runs', index, 'artifactIds'], message: 'artifact is outside run bounds' });
      }
    });
    run.negativeCaseIds.forEach((id) => {
      const negative = negativeCasesById.get(id);
      const ownerCount = (negativeOwnerCounts.get(id) ?? 0) + 1;
      negativeOwnerCounts.set(id, ownerCount);
      if (ownerCount === 1) negativeOwnerById.set(id, run);
      if (negative === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['runs', index, 'negativeCaseIds'], message: 'unknown negative-case reference' });
      else if (Date.parse(negative.testedAt) < Date.parse(run.startedAt) || Date.parse(negative.testedAt) > Date.parse(run.completedAt)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['runs', index, 'negativeCaseIds'], message: 'negative case is outside run bounds' });
      }
    });
    if (Date.parse(run.independentReadBack.observedAt) > Date.parse(manifest.generatedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['generatedAt'], message: 'must follow every run observation' });
    }
  });
  manifest.artifacts.forEach((artifact, index) => {
    if (artifact.kind !== 'negative' && artifact.kind !== 'audit' && artifactOwnerCounts.get(artifact.id) !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts', index, 'id'], message: 'artifact must belong to exactly one run' });
    }
  });
  if (Date.parse(manifest.firmwareTruth.observedAt) > Math.min(...manifest.runs.map(({ startedAt }) => Date.parse(startedAt)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['firmwareTruth', 'observedAt'], message: 'firmware truth must precede every run' });
  }
  const seenCaseCodes = new Set<string>();
  manifest.negativeCases.forEach((item, index) => {
    if (seenCaseCodes.has(item.caseCode)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['negativeCases', index, 'caseCode'], message: 'duplicate negative case code' });
    seenCaseCodes.add(item.caseCode);
    const owner = negativeOwnerById.get(item.id);
    if (negativeOwnerCounts.get(item.id) !== 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ['negativeCases', index, 'id'], message: 'negative case must belong to exactly one run' });
    item.artifactIds.forEach((id) => {
      negativeArtifactCounts.set(id, (negativeArtifactCounts.get(id) ?? 0) + 1);
      const artifact = artifactsById.get(id);
      if (artifact === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['negativeCases', index, 'artifactIds'], message: 'unknown artifact reference' });
      else if (artifact.kind !== 'negative' || owner === undefined || Date.parse(artifact.createdAt) < Date.parse(owner.startedAt)
        || Date.parse(artifact.createdAt) > Date.parse(item.testedAt)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['negativeCases', index, 'artifactIds'], message: 'negative artifact is outside event bounds' });
      }
    });
  });
  manifest.artifacts.forEach((artifact, index) => {
    if (artifact.kind === 'negative' && negativeArtifactCounts.get(artifact.id) !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts', index, 'id'], message: 'negative artifact must belong to exactly one case and run' });
    }
    if (Date.parse(artifact.createdAt) > Date.parse(manifest.generatedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts', index, 'createdAt'], message: 'artifact postdates manifest generation' });
    }
  });
  const actualCounters = {
    runCount: manifest.runs.length,
    passCount: manifest.runs.filter(({ result }) => result === 'pass').length,
    failCount: manifest.runs.filter(({ result }) => result === 'fail').length,
    indeterminateCount: manifest.runs.filter(({ result }) => result === 'indeterminate').length,
    independentReadBackPassCount: manifest.runs.filter(({ independentReadBack }) => independentReadBack.result === 'pass').length,
    negativeCasePassCount: manifest.negativeCases.filter(({ result }) => result === 'pass').length,
    restoredCount: manifest.runs.filter(({ postRunState }) => postRunState.mode === 'restored').length,
    retainedCount: manifest.runs.filter(({ postRunState }) => postRunState.mode === 'retained').length,
    mutationCount: manifest.runs.reduce((total, run) => total + run.mutationCount, 0),
    retryCount: manifest.runs.reduce((total, run) => total + run.retryCount, 0),
    collateralMutationCount: manifest.runs.reduce((total, run) => total + run.collateralMutationCount, 0),
  } satisfies Counters;
  O5_COUNTER_KEYS.forEach((key) => {
    if (manifest.o5Counters[key] !== actualCounters[key]) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['o5Counters', key], message: 'counter does not match evidence records' });
    }
  });
}
