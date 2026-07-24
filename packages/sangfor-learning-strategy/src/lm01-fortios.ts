import type { MethodResult, ConflictCandidate } from './methods.js';

/**
 * PR-003: LM-01 FortiOS synthetic fixture and direct read-only facade.
 * 
 * LM-01: 공식 citation이 있는 same-origin GET/HEAD와 제한된 JSON key path만 허용한다.
 * 
 * REQ-11: 공식 same-origin GET/HEAD가 eligible fact 생성
 * - citation/endpoint/credential 부재 시 unavailable
 */

export interface LM01Recipe {
  endpoint: string;
  method: 'GET' | 'HEAD';
  citation: string;
  keyPaths?: string[];
  headers?: Record<string, string>;
}

export interface LM01SyntheticResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface LM01FactResult {
  factId: string;
  value: unknown;
  endpoint: string;
  citation: string;
  collectedAt: string;
}

export type LM01Error =
  | { code: 'MISSING_CITATION'; message: string }
  | { code: 'MISSING_ENDPOINT'; message: string }
  | { code: 'INVALID_METHOD'; message: string }
  | { code: 'FORBIDDEN_FIELD'; message: string }
  | { code: 'SYNTHETIC_ONLY'; message: string };

const FORBIDDEN_FIELDS = ['shell', 'regex', 'functionName', 'urlHost', 'headerValue'];

export function validateLM01Recipe(recipe: LM01Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!recipe.citation || recipe.citation.trim() === '') {
    errors.push('MISSING_CITATION: citation is required');
  }

  if (!recipe.endpoint || recipe.endpoint.trim() === '') {
    errors.push('MISSING_ENDPOINT: endpoint is required');
  }

  if (recipe.method !== 'GET' && recipe.method !== 'HEAD') {
    errors.push('INVALID_METHOD: only GET and HEAD are allowed');
  }

  // Check for forbidden fields
  for (const field of FORBIDDEN_FIELDS) {
    if (field in recipe) {
      errors.push(`FORBIDDEN_FIELD: ${field} is not allowed`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export class LM01FortiosFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LM01Recipe): Promise<LM01FactResult | LM01Error> {
    // Validate recipe
    const validation = validateLM01Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'FORBIDDEN_FIELD',
        message: validation.errors.join('; '),
      };
    }

    // In synthetic mode, return synthetic response
    if (this.syntheticMode) {
      return this.executeSynthetic(recipe);
    }

    // Real device execution is not implemented in PR-003
    return {
      code: 'SYNTHETIC_ONLY',
      message: 'Real device execution requires PR-004 CDP session and PR-005 user approval',
    };
  }

  private executeSynthetic(recipe: LM01Recipe): LM01FactResult {
    // Synthetic FortiOS 8.0 API response
    const syntheticResponse: LM01SyntheticResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        version: '8.0.0',
        serial: 'FGT8000000000000',
        license: {
          status: 'valid',
          expires: '2027-12-31',
        },
      },
    };

    // Extract facts from key paths
    const factId = recipe.keyPaths?.[0] ?? 'version';
    const value = this.extractKeyPath(syntheticResponse.body, factId);

    return {
      factId,
      value,
      endpoint: recipe.endpoint,
      citation: recipe.citation,
      collectedAt: new Date().toISOString(),
    };
  }

  private extractKeyPath(obj: unknown, path: string): unknown {
    const keys = path.split('.');
    let current: unknown = obj;
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return current;
  }
}

/**
 * FortiOS 8.0 synthetic fixture for LM-01 testing.
 */
export const FORTIOS_8_0_SYNTHETIC_FIXTURE = {
  version: '8.0.0',
  serial: 'FGT8000000000000',
  license: {
    status: 'valid',
    expires: '2027-12-31',
  },
  interfaces: [
    { name: 'port1', ip: '192.168.1.1', status: 'up' },
    { name: 'port2', ip: '10.0.0.1', status: 'up' },
  ],
  firewall: {
    policies: 5,
    enabled: true,
  },
};
