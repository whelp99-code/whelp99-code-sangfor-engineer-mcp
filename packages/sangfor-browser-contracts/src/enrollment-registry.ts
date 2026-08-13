import { z } from 'zod';
import {
  ENROLLMENT_RECORD_VERSION,
  assertEnrollmentAllowsJob,
  clientEnrollmentSchema,
  denyEnrollment,
  evaluateEnrollmentForJob,
  issuedCertificateMetadataSchema,
  parseCsrOrDeny,
  toPersistedEnrollmentRecord,
  type CertificateSigningRequest,
  type ClientEnrollment,
  type EnrollmentDecision,
  type EnrollmentRefusalReason,
  type IssuedCertificateMetadata,
  type PersistedEnrollmentRecord,
} from './enrollment-schemas.js';

export interface CertificateIssuer {
  issueFromCsr(input: {
    readonly installationId: string;
    readonly clientIdentityId: string;
    readonly csr: CertificateSigningRequest;
    readonly now: Date;
  }): IssuedCertificateMetadata;
}

export interface EnrollmentRegistryOptions {
  readonly clock?: { now(): Date };
  readonly ids?: { clientIdentityId(installationId: string): string };
}

export type EnrollmentLifecycleResult =
  | {
    readonly ok: true;
    readonly enrollment: ClientEnrollment;
    readonly revokedSerial?: string;
  }
  | {
    readonly ok: false;
    readonly reason: EnrollmentRefusalReason;
    readonly message: string;
  };

export class EnrollmentRegistry {
  private readonly byInstallation = new Map<string, ClientEnrollment>();
  private readonly bySerial = new Map<string, ClientEnrollment>();
  private readonly clock: { now(): Date };
  private readonly ids: { clientIdentityId(installationId: string): string };

  constructor(
    private readonly issuer: CertificateIssuer,
    options: EnrollmentRegistryOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? {
      clientIdentityId: (installationId) => `client:${installationId}`,
    };
  }

  getByInstallation(installationId: string): ClientEnrollment | undefined {
    return this.byInstallation.get(installationId);
  }

  getBySerial(serial: string): ClientEnrollment | undefined {
    return this.bySerial.get(serial);
  }

  enroll(input: unknown): EnrollmentLifecycleResult {
    const csr = parseCsrOrDeny(input);
    if ('ok' in csr) return csr;
    const existing = this.byInstallation.get(csr.installationId);
    if (existing?.status === 'active') {
      return denyEnrollment(
        'INSTALLATION_ALREADY_ENROLLED',
        `Installation ${csr.installationId} already has client identity ${existing.clientIdentityId}.`,
      );
    }
    return this.issueAndStore(
      csr,
      existing?.clientIdentityId ?? this.ids.clientIdentityId(csr.installationId),
      undefined,
    );
  }

  rotate(installationId: string, input: unknown): EnrollmentLifecycleResult {
    const current = this.byInstallation.get(installationId);
    if (!current) {
      return denyEnrollment(
        'ENROLLMENT_MISSING',
        `Installation ${installationId} is not enrolled.`,
      );
    }
    if (current.status === 'revoked') {
      return denyEnrollment(
        'IDENTITY_REVOKED',
        `Client identity ${current.clientIdentityId} is revoked and cannot rotate.`,
      );
    }
    const csr = parseCsrOrDeny(input);
    if ('ok' in csr) return csr;
    if (csr.installationId !== installationId) {
      return denyEnrollment(
        'INSTALLATION_MISMATCH',
        'CSR installationId does not match the rotation target.',
      );
    }
    return this.issueAndStore(csr, current.clientIdentityId, current);
  }

  revoke(installationId: string, reason: string): EnrollmentLifecycleResult {
    const current = this.byInstallation.get(installationId);
    if (!current) {
      return denyEnrollment(
        'ENROLLMENT_MISSING',
        `Installation ${installationId} is not enrolled.`,
      );
    }
    if (current.status === 'revoked') return { ok: true, enrollment: current };
    const revoked = clientEnrollmentSchema.parse({
      ...current,
      status: 'revoked',
      revokedAt: this.clock.now().toISOString(),
      revocationReason: reason.trim() || 'revoked',
    });
    this.store(revoked);
    return {
      ok: true,
      enrollment: revoked,
      revokedSerial: revoked.certificateSerial,
    };
  }

  assertActiveForJob(installationId: string): ClientEnrollment {
    return assertEnrollmentAllowsJob(
      this.byInstallation.get(installationId),
      this.clock.now(),
    );
  }

  evaluateForJob(installationId: string): EnrollmentDecision {
    return evaluateEnrollmentForJob(
      this.byInstallation.get(installationId),
      this.clock.now(),
    );
  }

  persistedRecord(installationId: string): PersistedEnrollmentRecord | undefined {
    const enrollment = this.byInstallation.get(installationId);
    return enrollment ? toPersistedEnrollmentRecord(enrollment) : undefined;
  }

  private store(enrollment: ClientEnrollment): void {
    this.byInstallation.set(enrollment.installationId, enrollment);
    this.bySerial.set(enrollment.certificateSerial, enrollment);
  }

  private issueAndStore(
    csr: CertificateSigningRequest,
    clientIdentityId: string,
    prior: ClientEnrollment | undefined,
  ): EnrollmentLifecycleResult {
    const now = this.clock.now();
    let issued: IssuedCertificateMetadata;
    try {
      issued = issuedCertificateMetadataSchema.parse(
        this.issuer.issueFromCsr({
          installationId: csr.installationId,
          clientIdentityId,
          csr,
          now,
        }),
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        return denyEnrollment(
          'CERTIFICATE_INVALID',
          error.issues[0]?.message ?? 'Issued certificate metadata invalid.',
        );
      }
      throw error;
    }
    if (prior && issued.serial === prior.certificateSerial) {
      return denyEnrollment(
        'CERTIFICATE_INVALID',
        'Rotated certificate serial must differ from the prior serial.',
      );
    }
    const enrolledAt = now.toISOString();
    const enrollment = clientEnrollmentSchema.parse({
      schemaVersion: ENROLLMENT_RECORD_VERSION,
      installationId: csr.installationId,
      clientIdentityId,
      certificateSerial: issued.serial,
      publicKeyFingerprintSha256: csr.publicKeyFingerprintSha256,
      certificateFingerprintSha256: issued.fingerprintSha256,
      status: 'active',
      enrolledAt,
      notBefore: issued.notBefore,
      notAfter: issued.notAfter,
    });
    let revokedSerial: string | undefined;
    if (prior?.status === 'active') {
      this.bySerial.set(prior.certificateSerial, clientEnrollmentSchema.parse({
        ...prior,
        status: 'superseded',
        revokedAt: enrolledAt,
        revocationReason: 'rotated',
        supersededBySerial: enrollment.certificateSerial,
      }));
      revokedSerial = prior.certificateSerial;
    }
    this.store(enrollment);
    return {
      ok: true,
      enrollment,
      ...(revokedSerial ? { revokedSerial } : {}),
    };
  }
}
