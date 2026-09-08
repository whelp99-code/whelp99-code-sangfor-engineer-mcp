import { describe, expect, it } from 'vitest';
import {
  decodeControlTowerRequestBody,
  parseBoundaryControlTowerRequestBodyV1,
} from '../apps/control-tower/src/runtime-boundaries.js';
import {
  decodeOperatorRequestBody,
  parseBoundaryOperatorRequestBodyV1,
} from '../apps/operator-console/src/runtime-boundaries.js';
import { RuntimeSchemaError } from '../packages/shared/src/runtime-schema.js';

describe('route-specific request boundaries', () => {
  it('accepts the complete playbook analysis submission contract', () => {
    // Given
    const source = JSON.stringify({
      playbookId: 'pb-1',
      playbookRunId: 'pbrun-1',
      summary: 'validated run',
      authoredBy: 'agent-1',
      improvements: [{ observation: 'latency', recommendation: 'measure again' }],
      proposals: [{ action: 'add precheck', rationale: 'prevent recurrence' }],
    });

    // When
    const body = decodeControlTowerRequestBody(
      parseBoundaryControlTowerRequestBodyV1(source),
      'analysis-submit',
    );

    // Then
    expect(body.playbookRunId).toBe('pbrun-1');
    expect(body.improvements).toHaveLength(1);
  });

  it('rejects an unknown analysis field instead of forwarding it to store logic', () => {
    // Given
    const source = JSON.stringify({
      playbookId: 'pb-1',
      playbookRunId: 'pbrun-1',
      summary: 'validated run',
      authoredBy: 'agent-1',
      improvements: [],
      proposals: [],
      bypassReview: true,
    });

    // When
    const parse = () => decodeControlTowerRequestBody(
      parseBoundaryControlTowerRequestBodyV1(source),
      'analysis-submit',
    );

    // Then
    expect(parse).toThrow(RuntimeSchemaError);
  });

  it('rejects malformed operator project fields at the selected route boundary', () => {
    // Given
    const source = JSON.stringify({ customerName: 'Acme', requirements: [7] });

    // When
    const parse = () => decodeOperatorRequestBody(
      parseBoundaryOperatorRequestBodyV1(source),
      'analyze-project',
    );

    // Then
    expect(parse).toThrow(RuntimeSchemaError);
  });
});
