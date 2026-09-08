export interface LR03Recipe {
  frameworkProbe: string;
  routeProbe: string;
  capabilityProbe: string;
}

export interface LR03Result {
  factId: string;
  detectedFramework?: string;
  routes: string[];
  capabilities: string[];
  collectedAt: string;
}

export type LR03Error = { code: 'FRAMEWORK_ASSUMPTION'; message: string };

export function validateLR03Recipe(recipe: LR03Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const frameworkAssumptions = ['extjs', 'vue', 'react', 'angular'];
  const probeLower = recipe.frameworkProbe.toLowerCase();
  for (const assumption of frameworkAssumptions) {
    if (probeLower.includes(assumption)) {
      errors.push('FRAMEWORK_ASSUMPTION: framework should not be assumed beforehand');
      break;
    }
  }
  return { valid: errors.length === 0, errors };
}

export class LR03ProbeFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LR03Recipe): Promise<LR03Result | LR03Error> {
    const validation = validateLR03Recipe(recipe);
    if (!validation.valid) {
      return { code: 'FRAMEWORK_ASSUMPTION', message: validation.errors.join('; ') };
    }
    if (this.syntheticMode) return this.executeSynthetic(recipe);
    return {
      factId: 'lr03-probe',
      routes: [],
      capabilities: [],
      collectedAt: new Date().toISOString(),
    };
  }

  private executeSynthetic(_recipe: LR03Recipe): LR03Result {
    return {
      factId: 'lr03-probe',
      detectedFramework: undefined,
      routes: ['/dashboard', '/settings', '/license'],
      capabilities: ['read-version', 'read-license', 'read-interfaces'],
      collectedAt: new Date().toISOString(),
    };
  }
}
