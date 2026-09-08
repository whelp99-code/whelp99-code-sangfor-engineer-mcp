// Canonical BLRO backup manifest: versioned shape, deterministic bytes, Ed25519 detached signature.
//
// The manifest is the only publishable description of a backup. It never carries credentials,
// cookies, session material, or private keys: `assertNoSecretMaterial` is a machine gate, not a
// convention, and it runs over the exact bytes that get written.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const BACKUP_MANIFEST_VERSION = 'blro.backup.manifest/1';

export class BlroBackupManifestError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BlroBackupManifestError';
    this.code = code;
  }
}

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u);
const nonEmpty = z.string().min(1);

const tableDigestSchema = z.object({
  table: nonEmpty,
  rowCount: z.number().int().nonnegative(),
  setDigest: sha256Hex,
}).strict();

const relationshipSchema = z.object({
  table: nonEmpty,
  parent: nonEmpty,
  constraint: nonEmpty,
  columns: z.array(nonEmpty).min(1),
  references: z.array(nonEmpty).min(1),
  deleteAction: nonEmpty,
  childRows: z.number().int().nonnegative(),
}).strict();

const auditHeadSchema = z.object({
  projectId: nonEmpty,
  eventCount: z.number().int().nonnegative(),
  headSeq: z.number().int(),
  headHash: nonEmpty,
  keyedCount: z.number().int().nonnegative(),
  chainDigest: sha256Hex,
}).strict();

const epochSchema = z.object({
  projectId: nonEmpty,
  epoch: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  cutovers: z.array(z.object({
    aggregate: nonEmpty,
    state: nonEmpty,
    epoch: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
  }).strict()),
}).strict();

const authoritySchema = z.object({
  outstandingApprovals: z.array(z.object({
    id: nonEmpty, projectId: nonEmpty, actionHash: nonEmpty, status: nonEmpty,
    authorityEpoch: z.number().int().nonnegative(),
  }).strict()),
  outstandingNonces: z.array(z.object({
    id: nonEmpty, projectId: nonEmpty, nonceDigest: sha256Hex,
    authorityEpoch: z.number().int().nonnegative(),
  }).strict()),
  remoteJobs: z.array(z.object({
    id: nonEmpty, projectId: nonEmpty, jobId: nonEmpty, capabilityJti: nonEmpty,
    state: nonEmpty, resultDigest: sha256Hex.nullable(),
    authorityEpoch: z.number().int().nonnegative(),
  }).strict()),
  indeterminateCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
}).strict();

const evidenceObjectSchema = z.object({
  id: nonEmpty,
  projectId: nonEmpty,
  contentHash: nonEmpty,
  objectPath: nonEmpty,
  objectHash: sha256Hex,
  objectBytes: z.number().int().nonnegative(),
}).strict();

export const backupManifestSchema = z.object({
  version: z.literal(BACKUP_MANIFEST_VERSION),
  backupId: nonEmpty,
  mode: z.enum(['task', 'production']),
  capturedAt: z.string().datetime(),
  dump: z.object({
    format: z.literal('custom'),
    fileName: nonEmpty,
    bytes: z.number().int().positive(),
    sha256: sha256Hex,
  }).strict(),
  postgres: z.object({
    versionNum: z.number().int().positive(),
    versionText: nonEmpty,
    databaseName: nonEmpty,
    schemaName: nonEmpty,
    systemIdentifier: nonEmpty,
    recoveryPoint: z.object({
      lsn: z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/u),
      inRecovery: z.boolean(),
      timelineId: z.number().int().positive(),
    }).strict(),
    durability: z.object({
      syncCommit: nonEmpty,
      synchronousStandbyNames: z.string(),
      walLevel: nonEmpty,
      fsync: nonEmpty,
      fullPageWrites: nonEmpty,
      archiveMode: nonEmpty,
      syncReplicaCount: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  schema: z.object({
    migrations: z.array(z.object({ name: nonEmpty, checksum: nonEmpty }).strict()),
    migrationDigest: sha256Hex,
    catalogDigest: sha256Hex,
    tableCount: z.number().int().positive(),
  }).strict(),
  tables: z.array(tableDigestSchema).min(1),
  relationships: z.array(relationshipSchema),
  epochs: z.array(epochSchema),
  auditHeads: z.array(auditHeadSchema),
  authority: authoritySchema,
  evidenceObjects: z.array(evidenceObjectSchema),
  rpo: z.object({
    contract: nonEmpty,
    claim: nonEmpty,
    syncDurabilityProven: z.boolean(),
    findings: z.array(nonEmpty),
  }).strict(),
  signature: z.object({
    algorithm: z.literal('ed25519'),
    publicKeySpkiSha256: sha256Hex,
    payloadSha256: sha256Hex,
    value: z.string().min(1),
  }).strict(),
}).strict();

const SECRET_PATTERNS = Object.freeze([
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, 'PRIVATE_KEY_PEM'],
  [/postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/iu, 'DATABASE_URL_PASSWORD'],
  [/\bPGPASSWORD\b/u, 'PGPASSWORD'],
  [/"(?:password|passwd|secret|cookie|sessionId|apiToken|privateKey)"\s*:/iu, 'SECRET_FIELD'],
  [/\bSet-Cookie\b/iu, 'COOKIE'],
]);

/** Machine gate: the exact bytes that will be published must carry no secret material. */
export function assertNoSecretMaterial(bytes, where) {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new BlroBackupManifestError('BLRO_BACKUP_SECRET_MATERIAL_REFUSED', `${label} in ${where}`);
  }
}

/** RFC 8785-style ordering: object keys sorted, no incidental whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function sha256OfString(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadSigningKey(privateKeyPath) {
  const pem = readFileSync(privateKeyPath, 'utf8');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new BlroBackupManifestError('BLRO_BACKUP_SIGNING_KEY_ALGORITHM_REFUSED', key.asymmetricKeyType ?? 'unknown');
  }
  return key;
}

export function publicKeyDigest(privateKeyPath) {
  const spki = createPublicKey(loadSigningKey(privateKeyPath)).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

/**
 * Sign the unsigned manifest body. The private key is read here and never leaves this frame:
 * only the SPKI digest of the public half is recorded.
 */
export function signManifest(body, privateKeyPath) {
  const key = loadSigningKey(privateKeyPath);
  const payload = canonicalJson(body);
  assertNoSecretMaterial(payload, 'manifest payload');
  const signed = {
    ...body,
    signature: {
      algorithm: 'ed25519',
      publicKeySpkiSha256: publicKeyDigest(privateKeyPath),
      payloadSha256: sha256OfString(payload),
      value: sign(null, Buffer.from(payload, 'utf8'), key).toString('base64'),
    },
  };
  const manifest = backupManifestSchema.parse(signed);
  assertNoSecretMaterial(canonicalJson(manifest), 'signed manifest');
  return manifest;
}

export function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BlroBackupManifestError('BLRO_BACKUP_MANIFEST_UNPARSABLE');
  }
  const parsed = backupManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BlroBackupManifestError('BLRO_BACKUP_MANIFEST_SHAPE_REFUSED', parsed.error.issues[0]?.path.join('.') ?? 'unknown');
  }
  return parsed.data;
}

/** Verify the detached signature against the canonical bytes of the manifest minus `signature`. */
export function verifyManifestSignature(manifest, publicKeyPath) {
  const { signature, ...body } = manifest;
  const payload = canonicalJson(body);
  if (sha256OfString(payload) !== signature.payloadSha256) {
    throw new BlroBackupManifestError('BLRO_BACKUP_MANIFEST_PAYLOAD_DIGEST_MISMATCH');
  }
  const publicKey = createPublicKey(readFileSync(publicKeyPath, 'utf8'));
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new BlroBackupManifestError('BLRO_BACKUP_SIGNING_KEY_ALGORITHM_REFUSED', publicKey.asymmetricKeyType ?? 'unknown');
  }
  const spki = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (spki !== signature.publicKeySpkiSha256) throw new BlroBackupManifestError('BLRO_BACKUP_MANIFEST_KEY_MISMATCH');
  if (!verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature.value, 'base64'))) {
    throw new BlroBackupManifestError('BLRO_BACKUP_MANIFEST_SIGNATURE_INVALID');
  }
  return manifest;
}
