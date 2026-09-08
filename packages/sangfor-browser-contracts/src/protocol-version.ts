/**
 * Owns the browser-contract protocol version handshake between BLRO (the
 * authority) and JM endpoints (the browser runtime).
 *
 * Policy, per docs/BLRO_OPERATIONS_RUNBOOK.md §3: BLRO upgrades first, JM
 * second. A JM endpoint may trail BLRO by at most one contract minor.
 *
 * The declaration is mandatory and exact. There is no envelope-implied
 * fallback, no trimming, and no last-value-wins: a peer that does not declare
 * the canonical header with a single canonical value is refused before its
 * job is parsed, looked up, or dispatched.
 */

export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
}

export const BLRO_CONTRACT_VERSION: ContractVersion = { major: 1, minor: 1 };
export const JM_SUPPORTED_MINOR_LAG = 1;
export const CONTRACT_VERSION_HEADER = 'x-sangfor-browser-contract-version';

export const NODE_RUNTIME_PINS = {
  blroMajor: 22,
  jmMajor: 24,
  pnpm: '10.28.1',
} as const;

export const CONTRACT_VERSION_REFUSAL_REASONS = [
  'PEER_CONTRACT_MISSING',
  'PEER_CONTRACT_AMBIGUOUS',
  'PEER_CONTRACT_UNKNOWN',
  'PEER_CONTRACT_AHEAD',
  'PEER_CONTRACT_TOO_OLD',
] as const;

export type ContractVersionRefusalReason = (typeof CONTRACT_VERSION_REFUSAL_REASONS)[number];

export type ContractVersionDecision =
  | { readonly kind: 'supported'; readonly peer: ContractVersion }
  | {
    readonly kind: 'unsupported';
    readonly reason: ContractVersionRefusalReason;
    readonly declared: string;
    readonly message: string;
  };

/** A declared header value: absent, single, or repeated by the peer. */
export type DeclaredContractVersion = string | readonly string[] | ContractVersion | undefined;

/** Canonical form only: no padding, no signs, no whitespace, no extra segments. */
const CANONICAL_VERSION = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

export function parseContractVersion(input: string | ContractVersion): ContractVersion | null {
  if (typeof input !== 'string') return { major: input.major, minor: input.minor };
  const match = CANONICAL_VERSION.exec(input);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1] ?? '', 10),
    minor: Number.parseInt(match[2] ?? '', 10),
  };
}

export function formatContractVersion(version: ContractVersion): string {
  return `${version.major}.${version.minor}`;
}

function refuse(
  reason: ContractVersionRefusalReason,
  declared: string,
  message: string,
): ContractVersionDecision {
  return { kind: 'unsupported', reason, declared, message };
}

function isRepeated(declared: DeclaredContractVersion): declared is readonly string[] {
  return Array.isArray(declared);
}

function declaredText(declared: DeclaredContractVersion): string {
  if (declared === undefined) return '';
  if (typeof declared === 'string') return declared;
  if (isRepeated(declared)) return declared.join(', ');
  return formatContractVersion(declared);
}

export function negotiateContractVersion(
  declared: DeclaredContractVersion,
  authority: ContractVersion = BLRO_CONTRACT_VERSION,
): ContractVersionDecision {
  const text = declaredText(declared);
  if (declared === undefined) {
    return refuse(
      'PEER_CONTRACT_MISSING',
      text,
      `Peer did not declare the ${CONTRACT_VERSION_HEADER} header.`,
    );
  }
  if (isRepeated(declared)) {
    return refuse(
      'PEER_CONTRACT_AMBIGUOUS',
      text,
      `Peer declared ${declared.length} ${CONTRACT_VERSION_HEADER} values; exactly one is required.`,
    );
  }
  const peer = parseContractVersion(declared);
  if (!peer) {
    return refuse(
      'PEER_CONTRACT_UNKNOWN',
      text,
      `Peer declared an unrecognized browser contract version "${text}".`,
    );
  }
  if (peer.major > authority.major || (peer.major === authority.major && peer.minor > authority.minor)) {
    return refuse(
      'PEER_CONTRACT_AHEAD',
      text,
      `Peer contract ${text} is ahead of BLRO ${formatContractVersion(authority)}. `
      + 'Upgrade BLRO before its endpoints.',
    );
  }
  if (peer.major !== authority.major || peer.minor < authority.minor - JM_SUPPORTED_MINOR_LAG) {
    return refuse(
      'PEER_CONTRACT_TOO_OLD',
      text,
      `Peer contract ${text} is outside the supported window `
      + `(${formatContractVersion(authority)} minus ${JM_SUPPORTED_MINOR_LAG} minor).`,
    );
  }
  return { kind: 'supported', peer };
}
