import { describe, expect, it } from 'vitest';
import {
  browserExecutionRequestSchema,
  browserExecutionResultSchema,
  isAuthoritativePass,
} from '../packages/sangfor-browser-contracts/src/index.js';

const baseRequest = {
  schemaVersion: 'browser-execution-request.v1',
  requestId: 'request-security-1',
  sessionId: 'session-local-1',
  origin: 'http://127.0.0.1:3400',
} as const;

describe('BrowserExecutionPort security boundary', () => {
  it.each([
    ['selector', '#apply'],
    ['javascript', 'document.body.innerHTML'],
    ['cdpEndpoint', 'ws://127.0.0.1:9222/devtools/browser/secret'],
    ['cookie', 'session=secret'],
    ['storageState', { cookies: [] }],
    ['authorization', 'Bearer secret'],
  ])('rejects forbidden operation field %s', (field, value) => {
    expect(() => browserExecutionRequestSchema.parse({
      ...baseRequest,
      operation: {
        kind: 'observe_console',
        includeSnapshot: true,
        [field]: value,
      },
    })).toThrow();
  });

  it.each([
    ['requestId', '../request-escape'],
    ['sessionId', '/tmp/session-secret'],
    ['profileRef', '../../profiles/admin.json'],
    ['authRef', 'C:\\credentials\\admin.json'],
  ])('rejects path-like browser reference %s', (field, value) => {
    expect(() => browserExecutionRequestSchema.parse({
      ...baseRequest,
      [field]: value,
      operation: { kind: 'observe_console' },
    })).toThrow(/opaque|path|identifier/i);
  });

  it('rejects a cross-origin navigation target', () => {
    expect(() => browserExecutionRequestSchema.parse({
      ...baseRequest,
      operation: {
        kind: 'perform_console_action',
        action: {
          type: 'navigate',
          target: 'https://attacker.example/admin',
          dryRun: true,
        },
      },
    })).toThrow(/origin/i);
  });

  it('rejects cross-origin authenticated knowledge extraction', () => {
    expect(() => browserExecutionRequestSchema.parse({
      ...baseRequest,
      operation: {
        kind: 'extract_authenticated_knowledge',
        sourceUrl: 'https://attacker.example/private',
      },
    })).toThrow(/origin/i);
  });

  it.each([
    'Apply',
    'Save',
    'Delete policy',
    'Commit changes',
    'Erase configuration',
    'Factory Default',
    'ApplyPolicy',
    'deletepolicy',
    'savechanges',
    '删除策略',
    '刪除策略',
    'Ｄｅｌｅｔｅ',
    '삭 제',
    '저 장',
  ])(
    'rejects destructive evidence navigation label %s',
    (menu) => {
      expect(() => browserExecutionRequestSchema.parse({
        ...baseRequest,
        operation: {
          kind: 'capture_console_evidence',
          captureId: 'capture-security',
          menuPath: [{ menu }],
        },
      })).toThrow(/read-only|destructive/i);
    },
  );

  it.each(['Overview', 'Dashboard', 'Policy Status', 'Read-only Report'])(
    'allows safe evidence navigation label %s',
    (menu) => {
      expect(() => browserExecutionRequestSchema.parse({
        ...baseRequest,
        operation: {
          kind: 'capture_console_evidence',
          captureId: 'safe-menu',
          menuPath: [{ menu }],
        },
      })).not.toThrow();
    },
  );

  it('does not treat a mutation attempt without PASS read-back as authoritative', () => {
    const result = browserExecutionResultSchema.parse({
      schemaVersion: 'browser-execution-result.v1',
      requestId: 'request-security-1',
      status: 'INDETERMINATE',
      mutationAttempted: true,
      readBack: { status: 'INDETERMINATE' },
      evidence: [],
      error: {
        code: 'READ_BACK_INDETERMINATE',
        message: 'Mutation may have happened but read-back did not complete.',
      },
    });

    expect(isAuthoritativePass(result)).toBe(false);
  });

  it('requires both result and read-back PASS', () => {
    const withoutReadBack = browserExecutionResultSchema.parse({
      schemaVersion: 'browser-execution-result.v1',
      requestId: 'request-security-2',
      status: 'PASS',
      mutationAttempted: false,
      evidence: [],
    });
    const withReadBack = browserExecutionResultSchema.parse({
      ...withoutReadBack,
      readBack: { status: 'PASS' },
    });

    expect(isAuthoritativePass(withoutReadBack)).toBe(false);
    expect(isAuthoritativePass(withReadBack)).toBe(true);
  });
});
