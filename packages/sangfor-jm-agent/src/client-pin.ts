import type { RemotePeerIdentity } from '@sangfor/browser-contracts';
import { normalizeFingerprint256 } from '@sangfor/browser-contracts';

export type BlroClientPin = {
  readonly fingerprintSha256: string;
  readonly subjectCn: string;
  readonly serial: string;
  readonly sanUri: string;
  readonly issuerCn: string;
};

type PeerCertificateShape = {
  readonly fingerprint256?: string;
  readonly subject?: { readonly CN?: unknown };
  readonly issuer?: { readonly CN?: unknown };
  readonly serialNumber?: unknown;
  readonly subjectaltname?: unknown;
};

function commonName(value: { readonly CN?: unknown } | undefined): string | undefined {
  return typeof value?.CN === 'string' ? value.CN : undefined;
}

/**
 * mTLS proves the peer chains to the configured CA. The pin additionally proves
 * it is the exact enrolled BLRO client, so a second CA-issued certificate --
 * or a rotated one JM was not told about -- is refused.
 */
export function createBlroClientAuthorizer(
  pin: BlroClientPin,
): (identity: RemotePeerIdentity) => boolean {
  const expectedFingerprint = normalizeFingerprint256(pin.fingerprintSha256);
  const expectedSerial = pin.serial.toUpperCase();
  return (identity: RemotePeerIdentity): boolean => {
    if (!identity.tlsAuthorized) return false;
    if (normalizeFingerprint256(identity.fingerprint256) !== expectedFingerprint) return false;
    const certificate = identity.raw as PeerCertificateShape;
    if (commonName(certificate.subject) !== pin.subjectCn) return false;
    if (commonName(certificate.issuer) !== pin.issuerCn) return false;
    if (typeof certificate.serialNumber !== 'string'
      || certificate.serialNumber.toUpperCase() !== expectedSerial) {
      return false;
    }
    return subjectAltNames(certificate.subjectaltname).includes(`URI:${pin.sanUri}`);
  };
}

function subjectAltNames(value: unknown): readonly string[] {
  return typeof value === 'string' ? value.split(', ').map((entry) => entry.trim()) : [];
}
