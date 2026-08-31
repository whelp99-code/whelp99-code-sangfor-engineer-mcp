import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserExecutionPort } from '../packages/sangfor-browser-contracts/src/index.js';
import type { ObserverTransport } from '../packages/sangfor-observer/src/index.js';
import {
  configureJmBrowserRuntime,
  observerManager,
} from '../apps/mcp-server/src/browser-runtime-composition.js';
import { parseObserverProfilesEnvironment } from '../apps/mcp-server/src/runtime-boundaries.js';
import { RuntimeSchemaError } from '../packages/shared/src/runtime-schema.js';

const validRegistry = {
  version: 1,
  profiles: [{
    product: 'ENDPOINT_SECURE',
    expectedOrigin: 'https://console.example',
    cdpPort: 9333,
    firmwareTruthId: 'epp-6.0.4',
    deviceScope: 'device-scope-1',
  }],
} as const;

function captureRuntimeSchemaError(action: () => unknown): RuntimeSchemaError {
  try {
    action();
  } catch (error) {
    if (error instanceof RuntimeSchemaError) return error;
    throw error;
  }
  throw new Error('Expected RuntimeSchemaError');
}

function inertPort(): BrowserExecutionPort {
  return { execute: vi.fn() };
}

describe('observer profile environment boundary', () => {
  afterEach(() => {
    delete process.env.SANGFOR_OBSERVER_PROFILES_JSON;
  });

  it('Given a valid versioned registry, When parsed, Then typed profiles are returned', () => {
    // Given
    const source = JSON.stringify(validRegistry);

    // When
    const profiles = parseObserverProfilesEnvironment(source);

    // Then
    expect(profiles).toEqual(validRegistry.profiles);
  });

  it.each([
    ['product', { product: 7 }],
    ['expectedOrigin', { expectedOrigin: false }],
    ['cdpPort', { cdpPort: '9333' }],
    ['firmwareTruthId', { firmwareTruthId: null }],
    ['deviceScope', { deviceScope: [] }],
  ])('Given malformed %s type, When parsed, Then the registry is rejected', (_, replacement) => {
    // Given
    const source = JSON.stringify({
      ...validRegistry,
      profiles: [{ ...validRegistry.profiles[0], ...replacement }],
    });

    // When
    const error = captureRuntimeSchemaError(() => parseObserverProfilesEnvironment(source));

    // Then
    expect(error.issues).toEqual(expect.arrayContaining([
      { code: 'schema_mismatch', path: ['profiles', 0, expect.any(String)] },
    ]));
  });

  it('Given an unknown registry version, When parsed, Then unknown_version is reported', () => {
    // Given
    const source = JSON.stringify({ ...validRegistry, version: 2 });

    // When
    const error = captureRuntimeSchemaError(() => parseObserverProfilesEnvironment(source));

    // Then
    expect(error.issues).toEqual([{ code: 'unknown_version', path: ['version'] }]);
  });

  it('Given an unknown profile key, When parsed, Then the strict schema rejects it', () => {
    // Given
    const source = JSON.stringify({
      ...validRegistry,
      profiles: [{ ...validRegistry.profiles[0], credential: 'must-not-be-accepted' }],
    });

    // When
    const error = captureRuntimeSchemaError(() => parseObserverProfilesEnvironment(source));

    // Then
    expect(error.issues).toEqual([{ code: 'schema_mismatch', path: ['profiles', 0] }]);
  });

  it.each([
    ['prototype key', '{"version":1,"profiles":[],"__proto__":{"polluted":true}}', 'prototype_key'],
    ['over-depth value', JSON.stringify({ version: 1, profiles: [{ nested: { too: { deep: true } } }] }), 'max_depth_exceeded'],
  ])('Given a %s, When parsed, Then structural protections reject it', (_, source, issueCode) => {
    // Given

    // When
    const error = captureRuntimeSchemaError(() => parseObserverProfilesEnvironment(source));

    // Then
    expect(error.issues).toEqual([{ code: issueCode, path: expect.any(Array) }]);
  });

  it('Given a rejected secret field, When formatted, Then the secret value is masked', () => {
    // Given
    const secret = 'production-password-SUPER-SECRET';
    const source = JSON.stringify({ ...validRegistry, password: secret });

    // When
    const error = captureRuntimeSchemaError(() => parseObserverProfilesEnvironment(source));

    // Then
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
  });

  it('Given an invalid registry, When the manager is requested, Then no browser or observer effect occurs', () => {
    // Given
    const execute = vi.fn();
    const listPages = vi.fn();
    const snapshot = vi.fn();
    const captureStructure = vi.fn();
    const observerTransport: ObserverTransport = { listPages, snapshot, captureStructure };
    configureJmBrowserRuntime({
      executionPort: { execute },
      verificationPort: inertPort(),
      observerTransport,
    });
    process.env.SANGFOR_OBSERVER_PROFILES_JSON = JSON.stringify({
      ...validRegistry,
      profiles: [{ ...validRegistry.profiles[0], cdpPort: '9333' }],
    });

    // When
    expect(() => observerManager()).toThrow(RuntimeSchemaError);

    // Then
    expect(execute).not.toHaveBeenCalled();
    expect(listPages).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(captureStructure).not.toHaveBeenCalled();
  });
});
