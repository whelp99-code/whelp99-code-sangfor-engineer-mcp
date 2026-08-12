import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  describeAttribution,
  resolveBlroScope,
  type ActorType,
} from '../packages/sangfor-identity/src/index.js';

/**
 * BLRO Phase 3 — identity and scope (D1 + D2).
 *
 * Purpose is narrow and set by the product north star: attribute work to an
 * actor (including an AI engineer actor) and isolate it to one project, so a
 * human PM can supervise AI engineers. It is NOT a general IAM system.
 *
 * Fail-closed: an absent or malformed scope must REFUSE, never fall back to a
 * shared root. Today's `SANGFOR_ENGAGEMENT_ID` is fail-open; this model is the
 * opposite, and `engagementId` is the seed of `projectId` (D1).
 */

const VALID = {
  SANGFOR_TENANT_ID: 'acme-corp',
  SANGFOR_PROJECT_ID: 'dc-migration-2026',
  SANGFOR_ACTOR_ID: 'agent-01',
  SANGFOR_ACTOR_TYPE: 'ai_engineer',
};

describe('BLRO scope identity', () => {
  it('resolves a complete scope and reports it authorized', () => {
    const scope = resolveBlroScope({ env: VALID });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.value).toMatchObject({
      tenantId: 'acme-corp',
      projectId: 'dc-migration-2026',
      actorId: 'agent-01',
      actorType: 'ai_engineer',
    });
  });

  it('models the three actor types the PM-over-AI-engineers workflow needs', () => {
    expect([...ACTOR_TYPES].sort()).toEqual(['ai_engineer', 'human_pm', 'service']);
  });

  it('refuses when the tenant is missing instead of defaulting to a shared scope', () => {
    const scope = resolveBlroScope({ env: { ...VALID, SANGFOR_TENANT_ID: undefined } });
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.reasons).toContain('TENANT_ID_MISSING');
  });

  it('refuses when the project is missing', () => {
    const scope = resolveBlroScope({ env: { ...VALID, SANGFOR_PROJECT_ID: undefined } });
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.reasons).toContain('PROJECT_ID_MISSING');
  });

  it('refuses an unknown actor type rather than coercing it', () => {
    const scope = resolveBlroScope({ env: { ...VALID, SANGFOR_ACTOR_TYPE: 'root' } });
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.reasons).toContain('ACTOR_TYPE_INVALID');
  });

  it.each([
    ['..', 'traversal'],
    ['.', 'self'],
    ['a/b', 'separator'],
    ['x'.repeat(65), 'too long'],
    ['bad id', 'space'],
  ])('refuses a malformed project id (%s, %s)', (value) => {
    const scope = resolveBlroScope({ env: { ...VALID, SANGFOR_PROJECT_ID: value } });
    expect(scope.ok).toBe(false);
    if (scope.ok) return;
    expect(scope.reasons).toContain('PROJECT_ID_INVALID');
  });

  it('promotes a legacy engagement id to the project id (D1)', () => {
    const scope = resolveBlroScope({
      env: {
        SANGFOR_TENANT_ID: 'acme-corp',
        SANGFOR_ENGAGEMENT_ID: 'legacy-engagement',
        SANGFOR_ACTOR_ID: 'agent-01',
        SANGFOR_ACTOR_TYPE: 'ai_engineer',
      },
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.value.projectId).toBe('legacy-engagement');
    expect(scope.value.projectIdSource).toBe('engagement_id');
  });

  it('prefers an explicit project id over the legacy engagement id', () => {
    const scope = resolveBlroScope({
      env: { ...VALID, SANGFOR_ENGAGEMENT_ID: 'legacy-engagement' },
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.value.projectId).toBe('dc-migration-2026');
    expect(scope.value.projectIdSource).toBe('project_id');
  });

  it('never carries a credential value into a resolved scope', () => {
    const secret = 'blro_live_key_super_secret_value';
    const scope = resolveBlroScope({
      env: { ...VALID, SANGFOR_ACTOR_API_KEY: secret, SANGFOR_OPERATOR_APPROVAL_SECRET: secret },
    });
    expect(scope.ok).toBe(true);
    expect(JSON.stringify(scope)).not.toContain(secret);
  });

  it('renders an attribution string that names the actor and its type', () => {
    const scope = resolveBlroScope({ env: VALID });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    const attribution = describeAttribution(scope.value);
    expect(attribution).toContain('agent-01');
    expect(attribution).toContain('ai_engineer');
    expect(attribution).toContain('dc-migration-2026');
  });

  it('marks AI-engineer work as requiring human PM supervision', () => {
    const ai = resolveBlroScope({ env: VALID });
    const pm = resolveBlroScope({ env: { ...VALID, SANGFOR_ACTOR_TYPE: 'human_pm' } });
    expect(ai.ok && ai.value.requiresHumanSupervision).toBe(true);
    expect(pm.ok && pm.value.requiresHumanSupervision).toBe(false);
  });

  it('accepts every declared actor type', () => {
    for (const actorType of ACTOR_TYPES) {
      const scope = resolveBlroScope({ env: { ...VALID, SANGFOR_ACTOR_TYPE: actorType } });
      expect(scope.ok, `actor type ${actorType satisfies ActorType} must resolve`).toBe(true);
    }
  });
});
