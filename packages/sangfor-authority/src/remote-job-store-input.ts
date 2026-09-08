import {
  JobCapabilityError,
  browserExecutionRequestDigest,
  leafCertificateSchema,
  verifyJobCapability,
  type CapabilityKey,
  type JobCapabilityClaim,
  type LeafCertificate,
  type RemoteJobReserveInput,
} from '@sangfor/browser-contracts';
import type { EnrollmentProjectScope } from './enrollment-database.js';

export type VerifiedRemoteJobInput = {
  readonly claim: JobCapabilityClaim;
  readonly certificate: LeafCertificate;
  readonly requestDigest: string;
  readonly now: Date;
};

export function verifyRemoteJobStoreInput(input: {
  readonly reserve: RemoteJobReserveInput;
  readonly capabilityPublicKey: CapabilityKey;
  readonly scope: EnrollmentProjectScope;
  readonly now: Date;
}): VerifiedRemoteJobInput | undefined {
  let claim: JobCapabilityClaim;
  try {
    claim = verifyJobCapability({
      envelope: input.reserve.envelope,
      publicKey: input.capabilityPublicKey,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof JobCapabilityError) return undefined;
    throw error;
  }
  if (claim.tenantId !== input.scope.tenantId || claim.projectId !== input.scope.projectId) {
    return undefined;
  }
  const certificate = leafCertificateSchema.safeParse(input.reserve.certificate);
  if (!certificate.success) return undefined;
  return {
    claim,
    certificate: certificate.data,
    requestDigest: browserExecutionRequestDigest(input.reserve.envelope.request),
    now: input.now,
  };
}
