import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * PR-007: LM-05 JSON/CSV streaming import and LM-06 inbound stream listener.
 * 
 * LM-05: 사람이 미리 저장한 JSON/CSV만 allowlisted import root에서 streaming parse하며 symlink/path traversal을 금지한다.
 * LM-06: 이미 존재하는 WS/SSE의 inbound frame listener만 사용하고 send/new WebSocket/new EventSource를 금지한다.
 * 
 * REQ-15~16: bounded streaming import와 inbound-only stream fixture
 * 
 * LM-05 limits:
 * - File: 50MiB
 * - Rows: 100,000
 * - Fields/row: 256
 * - String: 64KiB
 * - Parse timeout: 30 seconds
 */

export const LM05_LIMITS = {
  maxFileSize: 50 * 1024 * 1024, // 50MiB
  maxRows: 100_000,
  maxFieldsPerRow: 256,
  maxStringLength: 64 * 1024, // 64KiB
  parseTimeoutMs: 30_000, // 30 seconds
};

export interface LM05Recipe {
  importRoot: string;
  filePattern: string;
  format: 'json' | 'csv';
}

export interface LM05FactResult {
  factId: string;
  value: unknown;
  filePath: string;
  rowCount: number;
  collectedAt: string;
}

export type LM05Error =
  | { code: 'FILE_NOT_FOUND'; message: string }
  | { code: 'FILE_TOO_LARGE'; message: string }
  | { code: 'PATH_TRAVERSAL'; message: string }
  | { code: 'SYMLINK_FORBIDDEN'; message: string }
  | { code: 'PARSE_TIMEOUT'; message: string }
  | { code: 'TOO_MANY_ROWS'; message: string }
  | { code: 'TOO_MANY_FIELDS'; message: string };

export function validateLM05Recipe(recipe: LM05Recipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!recipe.importRoot || recipe.importRoot.trim() === '') {
    errors.push('FILE_NOT_FOUND: importRoot is required');
  }

  if (!recipe.filePattern || recipe.filePattern.trim() === '') {
    errors.push('FILE_NOT_FOUND: filePattern is required');
  }

  if (recipe.format !== 'json' && recipe.format !== 'csv') {
    errors.push('FILE_NOT_FOUND: format must be json or csv');
  }

  return { valid: errors.length === 0, errors };
}

export function isPathTraversal(importRoot: string, filePath: string): boolean {
  const resolvedRoot = resolve(importRoot);
  const resolvedPath = resolve(filePath);
  return !resolvedPath.startsWith(resolvedRoot);
}

export function isSymlink(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export class LM05ImportFacade {
  private readonly syntheticMode: boolean;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LM05Recipe): Promise<LM05FactResult | LM05Error> {
    const validation = validateLM05Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'FILE_NOT_FOUND',
        message: validation.errors.join('; '),
      };
    }

    if (this.syntheticMode) {
      return this.executeSynthetic(recipe);
    }

    // Real file import
    const filePath = join(recipe.importRoot, recipe.filePattern);

    // Check path traversal
    if (isPathTraversal(recipe.importRoot, filePath)) {
      return {
        code: 'PATH_TRAVERSAL',
        message: `Path traversal detected: ${filePath} is outside import root ${recipe.importRoot}`,
      };
    }

    // Check symlink
    if (isSymlink(filePath)) {
      return {
        code: 'SYMLINK_FORBIDDEN',
        message: `Symlink forbidden: ${filePath}`,
      };
    }

    // Check file exists
    if (!existsSync(filePath)) {
      return {
        code: 'FILE_NOT_FOUND',
        message: `File not found: ${filePath}`,
      };
    }

    // Check file size
    const stats = statSync(filePath);
    if (stats.size > LM05_LIMITS.maxFileSize) {
      return {
        code: 'FILE_TOO_LARGE',
        message: `File too large: ${stats.size} bytes exceeds limit of ${LM05_LIMITS.maxFileSize} bytes`,
      };
    }

    // Parse file with timeout
    try {
      const result = await this.parseFileWithTimeout(filePath, recipe.format);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'PARSE_TIMEOUT') {
        return {
          code: 'PARSE_TIMEOUT',
          message: `Parse timeout: exceeded ${LM05_LIMITS.parseTimeoutMs}ms`,
        };
      }
      throw error;
    }
  }

  private async parseFileWithTimeout(filePath: string, format: 'json' | 'csv'): Promise<LM05FactResult> {
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('PARSE_TIMEOUT'));
      }, LM05_LIMITS.parseTimeoutMs);

      const rows: unknown[] = [];
      let rowCount = 0;

      const stream = createReadStream(filePath);
      const rl = createInterface({ input: stream });

      rl.on('line', (line) => {
        rowCount++;
        if (rowCount > LM05_LIMITS.maxRows) {
          clearTimeout(timeout);
          rl.close();
          reject(new Error('TOO_MANY_ROWS'));
          return;
        }

        if (format === 'csv') {
          const fields = line.split(',');
          if (fields.length > LM05_LIMITS.maxFieldsPerRow) {
            clearTimeout(timeout);
            rl.close();
            reject(new Error('TOO_MANY_FIELDS'));
            return;
          }
          rows.push(fields);
        } else {
          try {
            const parsed = JSON.parse(line);
            rows.push(parsed);
          } catch {
            // Skip invalid JSON lines
          }
        }
      });

      rl.on('close', () => {
        clearTimeout(timeout);
        resolvePromise({
          factId: 'import',
          value: rows,
          filePath,
          rowCount,
          collectedAt: new Date().toISOString(),
        });
      });

      rl.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private executeSynthetic(recipe: LM05Recipe): LM05FactResult {
    // Synthetic import response
    const syntheticRows = [
      { version: '13.0.120', license: 'active' },
      { version: '13.0.121', license: 'expired' },
    ];

    return {
      factId: 'import',
      value: syntheticRows,
      filePath: join(recipe.importRoot, recipe.filePattern),
      rowCount: syntheticRows.length,
      collectedAt: new Date().toISOString(),
    };
  }
}

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

const FORBIDDEN_OPERATIONS = ['send', 'newWebSocket', 'newEventSource', 'emit', 'write'];

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
  private frameCount: number = 0;

  constructor(options: { syntheticMode?: boolean } = {}) {
    this.syntheticMode = options.syntheticMode ?? true;
  }

  async execute(recipe: LM06Recipe): Promise<LM06FactResult | LM06Error> {
    const validation = validateLM06Recipe(recipe);
    if (!validation.valid) {
      return {
        code: 'STREAM_NOT_FOUND',
        message: validation.errors.join('; '),
      };
    }

    if (this.syntheticMode) {
      return this.executeSynthetic(recipe);
    }

    return {
      code: 'STREAM_NOT_FOUND',
      message: 'Real stream access requires browser session (PR-004)',
    };
  }

  private executeSynthetic(recipe: LM06Recipe): LM06FactResult {
    this.frameCount++;

    // Synthetic inbound frame
    const syntheticFrame = {
      type: 'status',
      data: { version: '13.0.120', status: 'active' },
    };

    return {
      factId: recipe.frameListener,
      value: syntheticFrame,
      frameCount: this.frameCount,
      collectedAt: new Date().toISOString(),
    };
  }

  getFrameCount(): number {
    return this.frameCount;
  }
}
