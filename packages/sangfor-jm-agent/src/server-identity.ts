import { X509Certificate, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalizeUrlOrigin } from '@sangfor/shared';

export const SERVER_AUTH_EKU = '1.3.6.1.5.5.7.3.1' as const;
/** X.509 keyCertSign; node reports key usage OIDs and names in one list. */
export const CERT_SIGN_KEY_USAGE = 'keyCertSign' as const;
export const CLIENT_AUTH_EKU_OID = '1.3.6.1.5.5.7.3.2' as const;

export const SERVER_IDENTITY_REFUSALS = {
  CERT_INVALID: 'SERVER_CERT_INVALID',
  CA_INVALID: 'SERVER_CA_INVALID',
  CA_EXPIRED: 'SERVER_CA_EXPIRED',
  CA_NOT_YET_VALID: 'SERVER_CA_NOT_YET_VALID',
  CA_NOT_A_CA: 'SERVER_CA_NOT_A_CA',
  CA_KEY_USAGE_INVALID: 'SERVER_CA_KEY_USAGE_INVALID',
  NOT_ISSUED_BY_CA: 'SERVER_CERT_NOT_ISSUED_BY_CA',
  EKU_NOT_SERVER_AUTH: 'SERVER_CERT_EKU_NOT_SERVER_AUTH',
  SAN_NOT_LOOPBACK: 'SERVER_CERT_SAN_NOT_LOOPBACK',
  KEY_MISMATCH: 'SERVER_CERT_KEY_MISMATCH',
  EXPIRED: 'SERVER_CERT_EXPIRED',
  NOT_YET_VALID: 'SERVER_CERT_NOT_YET_VALID',
} as const;

export type ServerIdentityRefusal =
  (typeof SERVER_IDENTITY_REFUSALS)[keyof typeof SERVER_IDENTITY_REFUSALS];

export type ServerIdentityCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ServerIdentityRefusal };

const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const LOOPBACK_SANS = ['IP Address:127.0.0.1', 'IP Address:0:0:0:0:0:0:0:1', 'DNS:localhost'];

export type ServerIdentityInput = {
  readonly certPath: string;
  readonly keyPath: string;
  readonly caPath: string;
  readonly now: Date;
};

/**
 * Startup proof that the leaf JM will present is genuinely the operator's
 * loopback server identity: issued by the configured CA, marked serverAuth,
 * bound to a loopback SAN, matching its private key, and currently valid.
 * A clientAuth-only or foreign leaf is refused here, before any bind.
 */
export function checkServerIdentity(input: ServerIdentityInput): ServerIdentityCheck {
  const leaf = parseCertificate(input.certPath);
  if (!leaf || leaf.ca) return refuse(SERVER_IDENTITY_REFUSALS.CERT_INVALID);
  const anchors = parseBundle(input.caPath);
  if (anchors.length === 0) return refuse(SERVER_IDENTITY_REFUSALS.CA_INVALID);
  const moment = input.now.getTime();
  // Every anchor must itself be a currently valid CA that may sign certificates.
  // An expired or not-yet-valid CA is refused even when the leaf still verifies.
  for (const anchor of anchors) {
    if (!anchor.ca) return refuse(SERVER_IDENTITY_REFUSALS.CA_NOT_A_CA);
    const usage = anchor.keyUsage;
    if (usage !== undefined && usage.length > 0 && !usage.includes(CERT_SIGN_KEY_USAGE)
      && !usage.includes(SERVER_AUTH_EKU)) {
      return refuse(SERVER_IDENTITY_REFUSALS.CA_KEY_USAGE_INVALID);
    }
    if (moment < anchor.validFromDate.getTime()) {
      return refuse(SERVER_IDENTITY_REFUSALS.CA_NOT_YET_VALID);
    }
    if (moment >= anchor.validToDate.getTime()) {
      return refuse(SERVER_IDENTITY_REFUSALS.CA_EXPIRED);
    }
  }
  const issued = anchors.some((anchor) => (
    leaf.checkIssued(anchor) && leaf.verify(anchor.publicKey)
  ));
  if (!issued) return refuse(SERVER_IDENTITY_REFUSALS.NOT_ISSUED_BY_CA);
  const usages = leaf.keyUsage ?? [];
  if (!usages.includes(SERVER_AUTH_EKU)) {
    return refuse(SERVER_IDENTITY_REFUSALS.EKU_NOT_SERVER_AUTH);
  }
  const sans = (leaf.subjectAltName ?? '').split(', ').map((value) => value.trim());
  if (!sans.some((value) => LOOPBACK_SANS.includes(value))) {
    return refuse(SERVER_IDENTITY_REFUSALS.SAN_NOT_LOOPBACK);
  }
  if (moment < leaf.validFromDate.getTime()) {
    return refuse(SERVER_IDENTITY_REFUSALS.NOT_YET_VALID);
  }
  if (moment >= leaf.validToDate.getTime()) {
    return refuse(SERVER_IDENTITY_REFUSALS.EXPIRED);
  }
  // Derive the PUBLIC half of the configured key and compare SPKI. This proves
  // the same pairing as checkPrivateKey while keeping JM free of any
  // private-key constructor, which the export-boundary test enforces.
  const derived = publicSpki(input.keyPath);
  if (!derived || derived !== leaf.publicKey.export({ type: 'spki', format: 'pem' }).toString()) {
    return refuse(SERVER_IDENTITY_REFUSALS.KEY_MISMATCH);
  }
  return { ok: true };
}

/**
 * Allowed browser origins are https origins and nothing else: no path, query,
 * fragment, userinfo, or plaintext scheme survives this boundary.
 */
export function canonicalizeAllowedOrigin(value: string): string | undefined {
  try {
    const origin = canonicalizeUrlOrigin(value.trim(), 'origin');
    return origin.startsWith('https://') ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** The configured BLRO SAN URI must be an exact, parseable URN, not a prefix. */
export function parseBlroSanUri(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^urn:sangfor:installation:[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/u.test(trimmed)) {
    return undefined;
  }
  return trimmed.includes('..') ? undefined : trimmed;
}

function parseCertificate(path: string): X509Certificate | undefined {
  try {
    return new X509Certificate(readFileSync(path));
  } catch {
    return undefined;
  }
}

function parseBundle(path: string): readonly X509Certificate[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const blocks = text.match(CERTIFICATE_PATTERN) ?? [];
  if (blocks.length === 0 || text.replaceAll(CERTIFICATE_PATTERN, '').trim().length > 0) return [];
  try {
    return blocks.map((pem) => new X509Certificate(pem));
  } catch {
    return [];
  }
}

function publicSpki(path: string): string | undefined {
  try {
    return createPublicKey(readFileSync(path)).export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    return undefined;
  }
}

function refuse(reason: ServerIdentityRefusal): ServerIdentityCheck {
  return { ok: false, reason };
}
