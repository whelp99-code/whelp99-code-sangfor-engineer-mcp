export interface LR02Recipe {
  captureStructure: string;
  allowlist: string[];
}

export interface LR02Result {
  factId: string;
  captureStructure: string;
  allowlist: string[];
  benchmarkScore: number;
  collectedAt: string;
}

export type LR02Error =
  | { code: 'RAW_SECRET_DETECTED'; message: string }
  | { code: 'RAW_PAYLOAD_DETECTED'; message: string };

const SECRET_PATTERNS = [/password/i, /secret/i, /token/i, /api[_-]?key/i];

export function validateLR02Recipe(recipe: LR02Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(recipe.captureStructure)) {
      errors.push('RAW_SECRET_DETECTED: raw secret pattern found in capture structure');
      break;
    }
  }
  for (const item of recipe.allowlist) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(item)) {
        errors.push('RAW_SECRET_DETECTED: raw secret pattern found in allowlist');
        break;
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export class LR02BenchmarkFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LR02Recipe): Promise<LR02Result | LR02Error> {
    const validation = validateLR02Recipe(recipe);
    if (!validation.valid) {
      return { code: 'RAW_SECRET_DETECTED', message: validation.errors.join('; ') };
    }
    return {
      factId: 'lr02-benchmark',
      captureStructure: recipe.captureStructure,
      allowlist: recipe.allowlist,
      benchmarkScore: 0.85,
      collectedAt: new Date().toISOString(),
    };
  }
}
