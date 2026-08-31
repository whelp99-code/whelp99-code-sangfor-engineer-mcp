export interface LR04Recipe {
  baselineStrategyId: string;
  candidateStrategyId: string;
  metrics: ('latency' | 'coverage' | 'conflict')[];
}

export interface LR04Result {
  factId: string;
  baselineStrategyId: string;
  candidateStrategyId: string;
  metrics: Record<string, number>;
  improvement: boolean;
  hasEvidenceFile: boolean;
  collectedAt: string;
}

export type LR04Error = { code: 'MISSING_EVIDENCE'; message: string };

export class LR04BenchmarkFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LR04Recipe): Promise<LR04Result | LR04Error> {
    if (this.syntheticMode) return this.executeSynthetic(recipe);
    return {
      code: 'MISSING_EVIDENCE',
      message: 'Real benchmark requires evidence file for promotion eligibility',
    };
  }

  private executeSynthetic(recipe: LR04Recipe): LR04Result {
    const metrics: Record<string, number> = {};
    for (const metric of recipe.metrics) metrics[metric] = 0.9;
    const improvement = Object.values(metrics).every((score) => score > 0.5);
    return {
      factId: 'lr04-benchmark',
      baselineStrategyId: recipe.baselineStrategyId,
      candidateStrategyId: recipe.candidateStrategyId,
      metrics,
      improvement,
      hasEvidenceFile: false,
      collectedAt: new Date().toISOString(),
    };
  }
}
