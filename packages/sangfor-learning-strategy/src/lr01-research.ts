export interface LR01Recipe {
  citation: string;
  pageVerified: boolean;
  productApplicability?: string;
  versionApplicability?: string;
}

export interface LR01Result {
  factId: string;
  citation: string;
  pageVerified: boolean;
  productApplicability?: string;
  versionApplicability?: string;
  eligibleForPromotion: boolean;
  collectedAt: string;
}

export type LR01Error =
  | { code: 'MISSING_CITATION'; message: string }
  | { code: 'NOT_PAGE_VERIFIED'; message: string };

export function validateLR01Recipe(recipe: LR01Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!recipe.citation || recipe.citation.trim() === '') {
    errors.push('MISSING_CITATION: citation is required');
  }
  if (!recipe.pageVerified) {
    errors.push('NOT_PAGE_VERIFIED: pageVerified must be true for promotion eligibility');
  }
  return { valid: errors.length === 0, errors };
}

export class LR01ResearchFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LR01Recipe): Promise<LR01Result | LR01Error> {
    const validation = validateLR01Recipe(recipe);
    if (!validation.valid) {
      return { code: 'MISSING_CITATION', message: validation.errors.join('; ') };
    }
    const eligibleForPromotion = recipe.pageVerified
      && Boolean(recipe.productApplicability)
      && Boolean(recipe.versionApplicability);
    return {
      factId: 'lr01-citation',
      citation: recipe.citation,
      pageVerified: recipe.pageVerified,
      productApplicability: recipe.productApplicability,
      versionApplicability: recipe.versionApplicability,
      eligibleForPromotion,
      collectedAt: new Date().toISOString(),
    };
  }
}
