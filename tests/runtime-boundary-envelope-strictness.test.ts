import { describe, expect, it } from 'vitest';
import { parseBoundaryHttpBridgeResponseV1 } from '../apps/http-bridge/src/runtime-boundaries.js';
import { CdpIndeterminateError, classifyCdpFrame } from '../packages/sangfor-jm-execution/src/cdp-frame.js';
import { parseBoundaryJmCdpMessageV1 } from '../packages/sangfor-jm-execution/src/runtime-boundaries.js';
import { RuntimeSchemaError } from '../packages/shared/src/runtime-schema.js';
import { captureRuntimeSchemaError } from './helpers/runtime-boundary-case.js';

// Both transports correlate a request to its answer by id and then hand the
// answer to a waiting caller. A frame that carries neither a result nor an
// error — or both at once — has no single outcome, so resolving it would hand
// the caller a fabricated empty success. These suites pin the only two honest
// verdicts: exactly one outcome, or a loud INDETERMINATE rejection.

const jsonRpcFrame = (fields: Record<string, unknown>): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, ...fields });

describe('http-bridge JSON-RPC response envelope strictness', () => {
  it('Given a response carrying neither result nor error, When the boundary parses it, Then it rejects as INDETERMINATE', () => {
    // Given
    const source = jsonRpcFrame({});

    // When
    const error = captureRuntimeSchemaError(() => parseBoundaryHttpBridgeResponseV1(source));

    // Then
    expect(error.policy).toBe('INDETERMINATE');
    expect(error.schemaName).toBe('http-bridge.json-rpc-response.v1');
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('Given a response carrying both result and error, When the boundary parses it, Then it rejects as INDETERMINATE', () => {
    // Given
    const source = jsonRpcFrame({ result: { ok: true }, error: { code: -32000, message: 'failed' } });

    // When
    const error = captureRuntimeSchemaError(() => parseBoundaryHttpBridgeResponseV1(source));

    // Then
    expect(error.policy).toBe('INDETERMINATE');
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('Given a result-only response, When the boundary parses it, Then the result survives and no error is attached', () => {
    // Given
    const source = jsonRpcFrame({ result: { tools: [{ name: 'ro.tool' }] } });

    // When
    const response = parseBoundaryHttpBridgeResponseV1(source);

    // Then
    expect(response.result).toEqual({ tools: [{ name: 'ro.tool' }] });
    expect(response.error).toBeUndefined();
  });

  it('Given an error-only response, When the boundary parses it, Then the code and message survive', () => {
    // Given
    const source = jsonRpcFrame({ error: { code: -32601, message: 'Method not found' } });

    // When
    const response = parseBoundaryHttpBridgeResponseV1(source);

    // Then
    expect(response.error).toEqual({ code: -32601, message: 'Method not found' });
    expect(response.result).toBeUndefined();
  });

  it('Given a response whose result is an explicit null, When the boundary parses it, Then null is a definite success', () => {
    // Given — JSON-RPC permits a null result; it must not read as "no outcome".
    const source = jsonRpcFrame({ result: null });

    // When
    const response = parseBoundaryHttpBridgeResponseV1(source);

    // Then
    expect(response.result).toBeNull();
    expect(response.error).toBeUndefined();
  });
});

describe('CDP frame envelope strictness', () => {
  it('Given a response frame carrying neither result nor error, When the boundary parses it, Then it rejects instead of yielding an empty success', () => {
    // Given
    const source = JSON.stringify({ id: 7 });

    // When
    const error = captureRuntimeSchemaError(() => parseBoundaryJmCdpMessageV1(source));

    // Then
    expect(error.schemaName).toBe('jm-execution.cdp-message.v1');
    expect(error.policy).toBe('INDETERMINATE');
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('Given a response frame carrying both result and error, When the boundary parses it, Then it rejects as ambiguous', () => {
    // Given
    const source = JSON.stringify({ id: 7, result: { value: 1 }, error: { code: -32000, message: 'failed' } });

    // When
    const error = captureRuntimeSchemaError(() => parseBoundaryJmCdpMessageV1(source));

    // Then
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('Given a mixed frame carrying an id and a method, When the boundary parses it, Then it rejects rather than guessing response or event', () => {
    // Given — a frame that is simultaneously a reply and an event.
    const source = JSON.stringify({ id: 7, method: 'Network.responseReceived', params: {} });

    // When
    const error = captureRuntimeSchemaError(() => parseBoundaryJmCdpMessageV1(source));

    // Then
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('Given an empty frame, When the boundary parses it, Then it rejects', () => {
    // Given
    const source = JSON.stringify({});

    // When
    const error = captureRuntimeSchemaError(() => parseBoundaryJmCdpMessageV1(source));

    // Then
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('Given a result response, When the boundary parses it, Then it classifies as a result frame carrying the value', () => {
    // Given
    const source = JSON.stringify({ id: 7, result: { processInfo: [] } });

    // When
    const frame = parseBoundaryJmCdpMessageV1(source);

    // Then
    expect(frame).toEqual({ kind: 'result', id: 7, value: { processInfo: [] } });
  });

  it('Given an error response, When the boundary parses it, Then it classifies as an error frame carrying code and message', () => {
    // Given — the real CDP error shape, which must not read as ambiguous.
    const source = JSON.stringify({ id: 7, error: { code: -32000, message: 'Target closed' } });

    // When
    const frame = parseBoundaryJmCdpMessageV1(source);

    // Then
    expect(frame).toEqual({ kind: 'error', id: 7, code: -32000, message: 'Target closed' });
  });

  it('Given an event frame, When the boundary parses it, Then it classifies as an event carrying method and params', () => {
    // Given
    const source = JSON.stringify({ method: 'DOMStorage.domStorageItemAdded', params: { key: 'a' } });

    // When
    const frame = parseBoundaryJmCdpMessageV1(source);

    // Then
    expect(frame).toEqual({ kind: 'event', method: 'DOMStorage.domStorageItemAdded', params: { key: 'a' } });
  });

  it('Given an event frame with no params, When the boundary parses it, Then params default to an empty object', () => {
    // Given
    const source = JSON.stringify({ method: 'Page.loadEventFired' });

    // When
    const frame = parseBoundaryJmCdpMessageV1(source);

    // Then
    expect(frame).toEqual({ kind: 'event', method: 'Page.loadEventFired', params: {} });
  });
});

describe('CDP frame classification for waiting callers', () => {
  it('Given an id-only frame, When the transport classifies it, Then waiting calls are handed an INDETERMINATE failure', () => {
    // Given
    const source = JSON.stringify({ id: 7 });

    // When
    const delivery = classifyCdpFrame(source);

    // Then
    expect(delivery.kind).toBe('indeterminate');
    if (delivery.kind !== 'indeterminate') throw new Error('expected an indeterminate delivery');
    expect(delivery.error).toBeInstanceOf(CdpIndeterminateError);
    expect(delivery.error.policy).toBe('INDETERMINATE');
    expect(delivery.error.cause).toBeInstanceOf(RuntimeSchemaError);
  });

  it('Given a frame that is not JSON at all, When the transport classifies it, Then waiting calls are handed an INDETERMINATE failure', () => {
    // Given
    const source = 'not-json';

    // When
    const delivery = classifyCdpFrame(source);

    // Then
    expect(delivery.kind).toBe('indeterminate');
    if (delivery.kind !== 'indeterminate') throw new Error('expected an indeterminate delivery');
    expect(delivery.error.policy).toBe('INDETERMINATE');
  });

  it('Given a result response, When the transport classifies it, Then it delivers the frame for its waiting call', () => {
    // Given
    const source = JSON.stringify({ id: 7, result: { ok: true } });

    // When
    const delivery = classifyCdpFrame(source);

    // Then
    expect(delivery).toEqual({ kind: 'frame', frame: { kind: 'result', id: 7, value: { ok: true } } });
  });
});
