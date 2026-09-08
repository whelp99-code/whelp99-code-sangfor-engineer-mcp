// Resolve the evidence objects a BlroEvidenceManifest row references, and hash their exact bytes.
//
// The manifest column is free-form JSON written by the evidence service, so it is untrusted input:
// it is parsed at this boundary into a typed object reference, or it refuses. A referenced object
// that is missing, unreadable, or outside the evidence root is a refusal — never a synthesised hash,
// because a fabricated hash makes the backup lie about what is recoverable.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertContainedPath, BlroRuntimeError } from './blro-backup-runtime.mjs';

const objectReferenceSchema = z.object({
  objectPath: z.string().min(1),
}).passthrough();

const manifestBodySchema = z.object({
  objects: z.array(objectReferenceSchema).optional(),
}).passthrough();

export class BlroEvidenceObjectError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BlroEvidenceObjectError';
    this.code = code;
  }
}

/** Object references declared by one manifest row, parsed from untrusted JSON. */
export function parseObjectReferences(manifestValue) {
  const body = manifestBodySchema.safeParse(manifestValue);
  if (!body.success) throw new BlroEvidenceObjectError('BLRO_EVIDENCE_MANIFEST_SHAPE_REFUSED');
  return (body.data.objects ?? []).map((reference) => reference.objectPath);
}

/**
 * Resolve one manifest row to an exact object hash.
 *
 * A row that declares no objects still yields a deterministic entry: the hash of its own canonical
 * manifest bytes, so a manifest whose body is tampered with is still caught by the backup digest.
 */
export function resolveEvidenceObject(manifestRow, evidenceRoot) {
  const references = parseObjectReferences(manifestRow.manifest);
  if (references.length === 0) {
    const bytes = Buffer.from(JSON.stringify(manifestRow.manifest), 'utf8');
    return {
      objectPath: `inline:${manifestRow.contentHash}`,
      objectHash: createHash('sha256').update(bytes).digest('hex'),
      objectBytes: bytes.byteLength,
    };
  }
  const root = resolve(evidenceRoot);
  const hasher = createHash('sha256');
  let totalBytes = 0;
  const paths = [];
  for (const reference of [...references].sort()) {
    let contained;
    try {
      contained = assertContainedPath(reference, root, `evidence object ${reference}`);
    } catch (error) {
      if (error instanceof BlroRuntimeError) {
        throw new BlroEvidenceObjectError('BLRO_EVIDENCE_OBJECT_UNRESOLVABLE', `${manifestRow.id}: ${error.code}`);
      }
      throw error;
    }
    if (!statSync(contained).isFile()) {
      throw new BlroEvidenceObjectError('BLRO_EVIDENCE_OBJECT_NOT_A_FILE', `${manifestRow.id}: ${reference}`);
    }
    const bytes = readFileSync(contained);
    hasher.update(relative(root, contained), 'utf8').update(bytes);
    totalBytes += bytes.byteLength;
    paths.push(relative(root, contained));
  }
  return { objectPath: paths.join('|'), objectHash: hasher.digest('hex'), objectBytes: totalBytes };
}
