/** Inbound-only listener over an existing WS/SSE stream. */
export interface LM06Recipe {
  frameListener: string;
  streamType: 'websocket' | 'sse';
}

export interface LM06FactResult {
  factId: string;
  value: unknown;
  frameCount: number;
  collectedAt: string;
}

export type LM06Error =
  | { code: 'FORBIDDEN_OPERATION'; message: string }
  | { code: 'STREAM_NOT_FOUND'; message: string };

export function validateLM06Recipe(recipe: LM06Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!recipe.frameListener || recipe.frameListener.trim() === '') {
    errors.push('STREAM_NOT_FOUND: frameListener is required');
  }
  if (recipe.streamType !== 'websocket' && recipe.streamType !== 'sse') {
    errors.push('STREAM_NOT_FOUND: streamType must be websocket or sse');
  }
  return { valid: errors.length === 0, errors };
}

export class LM06StreamFacade {
  private readonly syntheticMode: boolean;
  private frameCount = 0;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LM06Recipe): Promise<LM06FactResult | LM06Error> {
    const validation = validateLM06Recipe(recipe);
    if (!validation.valid) {
      return { code: 'STREAM_NOT_FOUND', message: validation.errors.join('; ') };
    }
    if (this.syntheticMode) return this.executeSynthetic(recipe);
    return {
      code: 'STREAM_NOT_FOUND',
      message: 'Real stream access requires browser session (PR-004)',
    };
  }

  private executeSynthetic(recipe: LM06Recipe): LM06FactResult {
    this.frameCount += 1;
    return {
      factId: recipe.frameListener,
      value: { type: 'status', data: { version: '13.0.120', status: 'active' } },
      frameCount: this.frameCount,
      collectedAt: new Date().toISOString(),
    };
  }

  getFrameCount(): number {
    return this.frameCount;
  }
}
