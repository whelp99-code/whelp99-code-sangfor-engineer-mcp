import { createHash } from 'node:crypto';

/**
 * PR-008: LM-07 local OCR and LM-08 signed confirmation.
 * 
 * LM-07: local-only OCR provider, recipe ROI와 고정 type parser만 사용하고 pixel·원문 OCR text 저장과 단독 자동 PASS를 금지한다.
 * LM-08: typed observation digest에 대한 reviewer·identity·nonce·expiry 서명만 허용하고 forged boolean과 free-form secret을 금지한다.
 * 
 * REQ-17~18: OCR review-required와 signed confirmation replay
 */

export interface LM07Recipe {
  roi: { x: number; y: number; width: number; height: number };
  typeParser: 'version' | 'license' | 'serial' | 'custom';
}

export interface LM07FactResult {
  factId: string;
  value: unknown;
  roi: LM07Recipe['roi'];
  reviewRequired: boolean;
  collectedAt: string;
}

export type LM07Error =
  | { code: 'FORBIDDEN_OPERATION'; message: string }
  | { code: 'INVALID_ROI'; message: string }
  | { code: 'AUTO_PASS_FORBIDDEN'; message: string };

const FORBIDDEN_OPERATIONS = ['pixelStorage', 'rawOcrText', 'autoPass'];

export function validateLM07Recipe(recipe: LM07Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!recipe.roi || typeof recipe.roi !== 'object') {
    errors.push('INVALID_ROI: roi is required');
  } else {
    const { x, y, width, height } = recipe.roi;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
      errors.push('INVALID_ROI: roi must have numeric x, y, width, height');
    }
    if (width <= 0 || height <= 0) {
      errors.push('INVALID_ROI: roi width and height must be positive');
    }
  }

  if (!recipe.typeParser || !['version', 'license', 'serial', 'custom'].includes(recipe.typeParser)) {
    errors.push('INVALID_ROI: typeParser must be version, license, serial, or custom');
  }

  return { valid: errors.length === 0, errors };
}

export class LM07OcrFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LM07Recipe): Promise<LM07FactResult | LM07Error> {
    const validation = validateLM07Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'INVALID_ROI',
        message: validation.errors.join('; '),
      };
    }

    if (this.syntheticMode) {
      return this.executeSynthetic(recipe);
    }

    return {
      code: 'FORBIDDEN_OPERATION',
      message: 'Real OCR requires local OCR provider setup',
    };
  }

  private executeSynthetic(recipe: LM07Recipe): LM07FactResult {
    // Synthetic OCR result
    const syntheticValues: Record<string, unknown> = {
      version: '13.0.120',
      license: 'Active',
      serial: 'IAG1300000000000',
    };

    const value = syntheticValues[recipe.typeParser] ?? 'unknown';

    return {
      factId: recipe.typeParser,
      value,
      roi: recipe.roi,
      reviewRequired: true, // LM-07 always requires review
      collectedAt: new Date().toISOString(),
    };
  }
}

export interface LM08Recipe {
  observationDigest: string;
  reviewer: string;
  identity: string;
  nonce: string;
  expiry: string;
}

export interface LM08Confirmation {
  observationDigest: string;
  reviewer: string;
  identity: string;
  nonce: string;
  expiry: string;
  signature: string;
  confirmedAt: string;
}

export type LM08Error =
  | { code: 'FORBIDDEN_FIELD'; message: string }
  | { code: 'INVALID_DIGEST'; message: string }
  | { code: 'FORGED_BOOLEAN'; message: string }
  | { code: 'FREE_FORM_SECRET'; message: string }
  | { code: 'EXPIRED'; message: string };

const FORBIDDEN_FIELDS = ['forgedBoolean', 'freeFormSecret'];

export function validateLM08Recipe(recipe: LM08Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!recipe.observationDigest || !/^[a-f0-9]{64}$/i.test(recipe.observationDigest)) {
    errors.push('INVALID_DIGEST: observationDigest must be 64-character hex');
  }

  if (!recipe.reviewer || recipe.reviewer.trim() === '') {
    errors.push('FORBIDDEN_FIELD: reviewer is required');
  }

  if (!recipe.identity || recipe.identity.trim() === '') {
    errors.push('FORBIDDEN_FIELD: identity is required');
  }

  if (!recipe.nonce || recipe.nonce.trim() === '') {
    errors.push('FORBIDDEN_FIELD: nonce is required');
  }

  if (!recipe.expiry || recipe.expiry.trim() === '') {
    errors.push('FORBIDDEN_FIELD: expiry is required');
  }

  // Check for forbidden fields
  for (const field of FORBIDDEN_FIELDS) {
    if (field in recipe) {
      errors.push(`FORBIDDEN_FIELD: ${field} is not allowed`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export class LM08ConfirmationFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LM08Recipe): Promise<LM08Confirmation | LM08Error> {
    const validation = validateLM08Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'FORBIDDEN_FIELD',
        message: validation.errors.join('; '),
      };
    }

    // Check expiry
    const expiryTime = new Date(recipe.expiry).getTime();
    if (Date.now() > expiryTime) {
      return {
        code: 'EXPIRED',
        message: `Confirmation expired at ${recipe.expiry}`,
      };
    }

    if (this.syntheticMode) {
      return this.executeSynthetic(recipe);
    }

    return {
      code: 'FORBIDDEN_FIELD',
      message: 'Real confirmation requires HMAC signing setup',
    };
  }

  private executeSynthetic(recipe: LM08Recipe): LM08Confirmation {
    // Synthetic signature (in production, this would be HMAC)
    const signature = createHash('sha256')
      .update(`${recipe.observationDigest}:${recipe.reviewer}:${recipe.identity}:${recipe.nonce}`)
      .digest('hex');

    return {
      observationDigest: recipe.observationDigest,
      reviewer: recipe.reviewer,
      identity: recipe.identity,
      nonce: recipe.nonce,
      expiry: recipe.expiry,
      signature,
      confirmedAt: new Date().toISOString(),
    };
  }
}
