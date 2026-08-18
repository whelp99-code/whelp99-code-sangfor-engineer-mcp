/**
 * Deny-by-default payload scrubber for the golden corpus (design 002, block G1).
 *
 * Vendor payloads are captured from real devices: hostnames, serials, admin
 * usernames, API keys, addresses and free-text descriptions all ride along. An
 * allowlist scrubber is the only shape that fails safe — a field nobody thought
 * about is redacted, not leaked. Every string value whose leaf key is not
 * explicitly allowlisted is replaced by `REDACTED_<12 hex>`, derived as a
 * salted sha256 of the original value so the token is deterministic (fixtures
 * stay byte-stable and diffable) while remaining one-way for the plaintext.
 *
 * Non-string leaves (numbers, booleans, null) are structural and are kept:
 * they are what the mappers and the spec engine actually compare.
 */
import { createHash } from 'node:crypto';

const TOKEN_SALT = 'sangfor-golden-corpus:v1';
const TOKEN_PREFIX = 'REDACTED_';
const TOKEN_RE = /^REDACTED_[0-9a-f]{12}$/u;

/** True for a value this scrubber already emitted — a token carries no plaintext. */
function isRedactionToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/** Deterministic, non-reversible token for one redacted string value. */
export function redactionToken(value: string): string {
  const digest = createHash('sha256').update(`${TOKEN_SALT}|${value}`).digest('hex');
  return `${TOKEN_PREFIX}${digest.slice(0, 12)}`;
}

function scrubValue(value: unknown, allowed: ReadonlySet<string>, key: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, allowed, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v, allowed, k);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Array elements inherit their parent key: `tags: ['prod','hq']` is
    // allowlisted (or not) as a unit, exactly like a scalar field would be.
    if (key !== undefined && allowed.has(key)) return value;
    // Idempotent: re-running the scrubber over a committed fixture must be a
    // no-op, otherwise every CI check would rewrite the corpus it verifies.
    return isRedactionToken(value) ? value : redactionToken(value);
  }
  return value;
}

/**
 * Return a structural copy of `raw` with every non-allowlisted string replaced
 * by a deterministic token. `allowlist` holds exact leaf key names (case
 * sensitive, matched at any depth) — never prefixes, so `logtrafficNotes` is
 * not smuggled through by an allowlisted `logtraffic`.
 */
export function scrubPayload(raw: unknown, allowlist: readonly string[]): unknown {
  return scrubValue(raw, new Set(allowlist), undefined);
}
