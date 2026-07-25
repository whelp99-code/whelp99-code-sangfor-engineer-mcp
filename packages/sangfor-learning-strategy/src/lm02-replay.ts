import type { MethodResult } from './methods.js';

/**
 * PR-005: LM-02 synthetic fixture and user approval gate.
 * 
 * LM-02: exact+promoted recipe의 GET/HEAD와 명시적 read-only POST template을 1회 replay하는 후보 방식.
 * 
 * REQ-12: synthetic 1회 요청 + real facade `ACTIVE_REPLAY_NOT_APPROVED`
 * 
 * Security requirements:
 * - real-device ReadOnlyFacade에는 LM-02 transport method를 구현하지 않는다
 * - recipe가 LM-02를 포함해도 synthetic adapter가 아니면 ACTIVE_REPLAY_NOT_APPROVED 반환
 * - 사용자 결정표 U-02가 명시 승인으로 바뀌기 전 실장비 endpoint·body·header capture를 recipe로 승격하지 않는다
 */

export interface LM02Recipe {
  endpoint: string;
  method: 'GET' | 'HEAD' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  citation?: string;
  readOnlyPostTemplate?: boolean;
}

export interface LM02SyntheticResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface LM02FactResult {
  factId: string;
  value: unknown;
  endpoint: string;
  requestCount: number;
  collectedAt: string;
}

export type LM02Error =
  | { code: 'ACTIVE_REPLAY_NOT_APPROVED'; message: string }
  | { code: 'INVALID_METHOD'; message: string }
  | { code: 'FORBIDDEN_FIELD'; message: string }
  | { code: 'MISSING_CITATION'; message: string };

const FORBIDDEN_FIELDS = ['shell', 'regex', 'functionName', 'urlHost', 'headerValue'];
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST'];

export function validateLM02Recipe(recipe: LM02Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!ALLOWED_METHODS.includes(recipe.method)) {
    errors.push('INVALID_METHOD: only GET, HEAD, and read-only POST are allowed');
  }

  if (recipe.method === 'POST' && !recipe.readOnlyPostTemplate) {
    errors.push('INVALID_METHOD: POST requires readOnlyPostTemplate flag');
  }

  // Check for forbidden fields
  for (const field of FORBIDDEN_FIELDS) {
    if (field in recipe) {
      errors.push(`FORBIDDEN_FIELD: ${field} is not allowed`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export class LM02ReplayFacade {
  private readonly syntheticMode: boolean;
  private readonly userApproved: boolean;
  private requestCount: number = 0;

  constructor(options: { syntheticMode?: boolean; userApproved?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
    this.userApproved = options.userApproved ?? false;
  }

  async execute(recipe: LM02Recipe): Promise<LM02FactResult | LM02Error> {
    // Validate recipe
    const validation = validateLM02Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'FORBIDDEN_FIELD',
        message: validation.errors.join('; '),
      };
    }

    // Real device execution requires user approval (U-02)
    if (!this.syntheticMode && !this.userApproved) {
      return {
        code: 'ACTIVE_REPLAY_NOT_APPROVED',
        message: 'LM-02 active replay requires user approval (U-02). Real device execution is blocked.',
      };
    }

    // In synthetic mode, return synthetic response
    if (this.syntheticMode) {
      return this.executeSynthetic(recipe);
    }

    // Real device execution (only if user approved)
    return this.executeReal(recipe);
  }

  private executeSynthetic(recipe: LM02Recipe): LM02FactResult {
    this.requestCount++;

    // Synthetic CC 3.0.98 API response
    const syntheticResponse: LM02SyntheticResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        version: '3.0.98',
        build: '1234',
        license: {
          status: 'valid',
        },
      },
    };

    const body = syntheticResponse.body as { version?: string } | undefined;

    return {
      factId: 'version',
      value: body?.version,
      endpoint: recipe.endpoint,
      requestCount: this.requestCount,
      collectedAt: new Date().toISOString(),
    };
  }

  private executeReal(recipe: LM02Recipe): LM02FactResult {
    this.requestCount++;

    // Real device execution placeholder
    // In production, this would make actual HTTP request
    return {
      factId: 'version',
      value: 'unknown',
      endpoint: recipe.endpoint,
      requestCount: this.requestCount,
      collectedAt: new Date().toISOString(),
    };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  resetRequestCount(): void {
    this.requestCount = 0;
  }
}

/**
 * CC 3.0.98 synthetic fixture for LM-02 testing.
 */
export const CC_3_0_98_SYNTHETIC_FIXTURE = {
  version: '3.0.98',
  build: '1234',
  license: {
    status: 'valid',
  },
};

/**
 * CC version-conflict fixture for testing.
 * Represents the conflict between 3.0.98 and 3.0.98C.
 */
export const CC_VERSION_CONFLICT_FIXTURE = {
  candidate1: {
    version: '3.0.98',
    source: 'api',
    citation: 'https://docs.sangfor.com/cc/3.0/api',
  },
  candidate2: {
    version: '3.0.98C',
    source: 'ui',
    citation: 'https://docs.sangfor.com/cc/3.0/ui',
  },
  conflict: true,
  resolution: 'pending_m2_verification',
};
