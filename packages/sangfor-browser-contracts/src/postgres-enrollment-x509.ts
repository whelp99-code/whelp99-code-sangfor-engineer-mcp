import { X509Certificate } from 'node:crypto';
import { z } from 'zod';

export const CLIENT_AUTH_EKU = '1.3.6.1.5.5.7.3.2' as const;
const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const PRIVATE_KEY_PATTERN = /-----BEGIN[^-]*PRIVATE KEY-----/iu;
const pemSchema = z.string().trim().min(1).max(65_536)
  .refine((value) => !PRIVATE_KEY_PATTERN.test(value), 'Private key material is refused.')
  .refine((value) => {
    const matches = value.match(CERTIFICATE_PATTERN) ?? [];
    return matches.length === 1 && value.replaceAll(CERTIFICATE_PATTERN, '').trim().length === 0;
  }, 'Exactly one certificate PEM is required.');
const derSchema = z.string().min(1).max(90_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u);

export const leafCertificateSchema = z.discriminatedUnion('encoding', [
  z.object({ encoding: z.literal('pem'), value: pemSchema }).strict(),
  z.object({ encoding: z.literal('der-base64'), value: derSchema }).strict(),
]).readonly();
export type LeafCertificate = z.infer<typeof leafCertificateSchema>;
export type TrustedIssuer = {
  readonly certificate: X509Certificate;
  readonly fingerprintSha256: string;
  readonly subject: string;
};
export type DerivedClientCertificate = {
  readonly issuerChainRef: string;
  readonly issuer: string;
  readonly subjectAltNames: readonly string[];
  readonly extendedKeyUsages: readonly string[];
  readonly serial: string;
  readonly fingerprintSha256: string;
  readonly notBefore: string;
  readonly notAfter: string;
};
export type CertificateIdentityRefusal =
  | 'CERTIFICATE_EXPIRED' | 'CERTIFICATE_INVALID' | 'CERTIFICATE_NOT_YET_VALID'
  | 'CLIENT_EKU_MISSING' | 'ISSUER_UNTRUSTED' | 'SAN_MISMATCH';
export type CertificateIdentityDecision =
  | { readonly ok: true; readonly certificate: DerivedClientCertificate }
  | { readonly ok: false; readonly reason: CertificateIdentityRefusal };
export type DeriveClientCertificateInput = {
  readonly certificate: LeafCertificate;
  readonly trustedIssuers: readonly TrustedIssuer[];
  readonly binding: {
    readonly installationId: string;
    readonly deviceBindingDigest: string;
  };
  readonly now: Date;
};

const fingerprint = (certificate: X509Certificate): string => (
  certificate.fingerprint256.replaceAll(':', '').toLowerCase()
);
export const installationSubjectAltName = (installationId: string): string => (
  `urn:sangfor:installation:${installationId}`
);
export const deviceSubjectAltName = (deviceBindingDigest: string): string => (
  `urn:sangfor:device-sha256:${deviceBindingDigest}`
);

export function parseTrustedIssuerBundle(bundle: string | Buffer): readonly TrustedIssuer[] {
  const text = bundle.toString('utf8');
  const encoded = text.match(CERTIFICATE_PATTERN) ?? [];
  if (encoded.length === 0 || text.replaceAll(CERTIFICATE_PATTERN, '').trim().length > 0) {
    throw new CertificateTrustError('Trust bundle must contain only PEM certificates.');
  }
  return encoded.map((pem) => {
    const certificate = new X509Certificate(pem);
    if (!certificate.ca) throw new CertificateTrustError('Trust anchor must be a CA certificate.');
    return { certificate, fingerprintSha256: fingerprint(certificate), subject: certificate.subject };
  });
}

function parseLeaf(input: LeafCertificate): X509Certificate | undefined {
  try {
    const value = input.encoding === 'pem' ? input.value : Buffer.from(input.value, 'base64');
    return new X509Certificate(value);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

export function deriveClientCertificateIdentity(
  input: DeriveClientCertificateInput,
): CertificateIdentityDecision {
  const parsed = leafCertificateSchema.parse(input.certificate);
  const leaf = parseLeaf(parsed);
  if (!leaf || leaf.ca) return { ok: false, reason: 'CERTIFICATE_INVALID' };
  const issuer = input.trustedIssuers.find((candidate) => (
    leaf.checkIssued(candidate.certificate) && leaf.verify(candidate.certificate.publicKey)
  ));
  if (!issuer) return { ok: false, reason: 'ISSUER_UNTRUSTED' };
  if (!leaf.keyUsage.includes(CLIENT_AUTH_EKU)) return { ok: false, reason: 'CLIENT_EKU_MISSING' };
  const requiredSans = [
    installationSubjectAltName(input.binding.installationId),
    deviceSubjectAltName(input.binding.deviceBindingDigest),
  ];
  const encodedSans = leaf.subjectAltName?.split(', ') ?? [];
  if (!requiredSans.every((value) => encodedSans.includes(`URI:${value}`))) {
    return { ok: false, reason: 'SAN_MISMATCH' };
  }
  const now = input.now.getTime();
  if (now < leaf.validFromDate.getTime()) return { ok: false, reason: 'CERTIFICATE_NOT_YET_VALID' };
  if (now >= leaf.validToDate.getTime()) return { ok: false, reason: 'CERTIFICATE_EXPIRED' };
  return {
    ok: true,
    certificate: {
      issuerChainRef: issuer.fingerprintSha256,
      issuer: leaf.issuer,
      subjectAltNames: requiredSans,
      extendedKeyUsages: [...leaf.keyUsage],
      serial: leaf.serialNumber,
      fingerprintSha256: fingerprint(leaf),
      notBefore: leaf.validFromDate.toISOString(),
      notAfter: leaf.validToDate.toISOString(),
    },
  };
}

export class CertificateTrustError extends Error {
  override readonly name = 'CertificateTrustError';
}
