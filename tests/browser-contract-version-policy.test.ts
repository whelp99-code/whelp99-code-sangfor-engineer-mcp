import { describe, expect, it } from 'vitest';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  JM_SUPPORTED_MINOR_LAG,
  negotiateContractVersion,
  parseContractVersion,
} from '../packages/sangfor-browser-contracts/src/protocol-version.js';

const supported = `${BLRO_CONTRACT_VERSION.major}.${BLRO_CONTRACT_VERSION.minor}`;
const adjacent = `${BLRO_CONTRACT_VERSION.major}.${BLRO_CONTRACT_VERSION.minor - JM_SUPPORTED_MINOR_LAG}`;

describe('browser contract version policy', () => {
  it('pins the supported BLRO contract version and the one-minor JM window', () => {
    expect(parseContractVersion(supported)).toEqual(BLRO_CONTRACT_VERSION);
    expect(JM_SUPPORTED_MINOR_LAG).toBe(1);
  });

  it('accepts an exactly matching JM contract version', () => {
    expect(negotiateContractVersion(supported)).toEqual({
      kind: 'supported',
      peer: BLRO_CONTRACT_VERSION,
    });
  });

  it('accepts a JM exactly one supported minor behind BLRO', () => {
    expect(negotiateContractVersion(adjacent).kind).toBe('supported');
  });

  it('refuses a JM more than one minor behind an advanced BLRO', () => {
    // Given a BLRO that already moved two minors ahead of this JM endpoint,
    // When the endpoint declares its trailing version,
    // Then it is outside the one-minor window, while the adjacent minor
    // against that same authority stays supported.
    const advanced = { major: BLRO_CONTRACT_VERSION.major, minor: BLRO_CONTRACT_VERSION.minor + 2 };

    const decision = negotiateContractVersion(supported, advanced);

    expect(decision.kind).toBe('unsupported');
    if (decision.kind === 'unsupported') expect(decision.reason).toBe('PEER_CONTRACT_TOO_OLD');
    expect(negotiateContractVersion(
      `${advanced.major}.${advanced.minor - JM_SUPPORTED_MINOR_LAG}`,
      advanced,
    ).kind).toBe('supported');
  });

  it.each([
    ['blro_older_than_jm_minor', `${BLRO_CONTRACT_VERSION.major}.${BLRO_CONTRACT_VERSION.minor + 1}`, 'PEER_CONTRACT_AHEAD'],
    ['future_major', `${BLRO_CONTRACT_VERSION.major + 1}.0`, 'PEER_CONTRACT_AHEAD'],
    ['old_major', `${BLRO_CONTRACT_VERSION.major - 1}.9`, 'PEER_CONTRACT_TOO_OLD'],
    ['unknown_token', 'browser-contract.vNEXT', 'PEER_CONTRACT_UNKNOWN'],
    ['empty', '', 'PEER_CONTRACT_UNKNOWN'],
    ['non_numeric_minor', '1.x', 'PEER_CONTRACT_UNKNOWN'],
  ])('refuses %s with a typed unsupported decision', (_case, declared, reason) => {
    const decision = negotiateContractVersion(declared);
    expect(decision.kind).toBe('unsupported');
    if (decision.kind === 'unsupported') expect(decision.reason).toBe(reason);
  });

  it.each([
    ['leading_space', ` ${supported}`],
    ['trailing_space', `${supported} `],
    ['inner_space', `${BLRO_CONTRACT_VERSION.major}. ${BLRO_CONTRACT_VERSION.minor}`],
    ['tab', `\t${supported}`],
    ['newline', `${supported}\n`],
    ['zero_padded_major', `0${supported}`],
    ['zero_padded_minor', `${BLRO_CONTRACT_VERSION.major}.0${BLRO_CONTRACT_VERSION.minor}`],
    ['comma_joined_duplicate', `${supported}, ${supported}`],
  ])('refuses %s rather than normalizing it', (_case, declared) => {
    // Given the canonical form is exact, When a peer declares a decorated
    // variant, Then it is unknown — the authority never trims or normalizes.
    const decision = negotiateContractVersion(declared);
    expect(decision.kind).toBe('unsupported');
    if (decision.kind === 'unsupported') expect(decision.reason).toBe('PEER_CONTRACT_UNKNOWN');
  });

  it('refuses a missing declaration outright with no envelope-implied fallback', () => {
    const decision = negotiateContractVersion(undefined);
    expect(decision.kind).toBe('unsupported');
    if (decision.kind === 'unsupported') expect(decision.reason).toBe('PEER_CONTRACT_MISSING');
  });

  it.each([
    ['two_supported_values', [supported, supported]],
    ['supported_then_hostile', [supported, `${BLRO_CONTRACT_VERSION.major + 1}.0`]],
    ['hostile_then_supported', [`${BLRO_CONTRACT_VERSION.major + 1}.0`, supported]],
    ['single_element_array', [supported]],
  ])('refuses %s as an ambiguous declaration instead of picking a winner', (_case, declared) => {
    const decision = negotiateContractVersion(declared);
    expect(decision.kind).toBe('unsupported');
    if (decision.kind === 'unsupported') expect(decision.reason).toBe('PEER_CONTRACT_AMBIGUOUS');
  });
});
