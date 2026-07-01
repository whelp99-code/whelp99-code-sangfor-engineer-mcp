import { describe, expect, it } from 'vitest';
import { computeLiveVerificationOk, type VerificationCheck } from '../packages/sangfor-verifier/src/index.js';

const check = (status: VerificationCheck['status']): VerificationCheck => ({
  id: 's', title: 't', status, message: '',
});

describe('computeLiveVerificationOk — false-pass prevention', () => {
  it('is FALSE when every check is manual_required (nothing actually verified)', () => {
    expect(computeLiveVerificationOk([check('manual_required'), check('manual_required')])).toBe(false);
  });

  it('is FALSE when there are no checks at all', () => {
    expect(computeLiveVerificationOk([])).toBe(false);
  });

  it('is TRUE only when every check passed', () => {
    expect(computeLiveVerificationOk([check('passed'), check('passed')])).toBe(true);
  });

  it('is FALSE if any check failed', () => {
    expect(computeLiveVerificationOk([check('passed'), check('failed')])).toBe(false);
  });

  it('is FALSE for a mix of passed and manual_required (undetermined blocks ok)', () => {
    expect(computeLiveVerificationOk([check('passed'), check('manual_required')])).toBe(false);
  });
});
