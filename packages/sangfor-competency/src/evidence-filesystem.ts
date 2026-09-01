import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { CapabilityEvidenceArtifact } from './evidence-schema.js';
import type {
  EvidenceFilesystem,
  EvidenceValidationIssue,
  EvidenceValidationIssueCode,
} from './evidence-validation-types.js';
import { MAX_EVIDENCE_ARTIFACT_BYTES } from './evidence-validation-types.js';

export function nodeEvidenceFilesystem(): EvidenceFilesystem {
  return {
    realpath: realpathSync,
    lstat: lstatSync,
    readFile(path): Uint8Array {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile()) throw new EvidenceFileReadError();
        return readFileSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

class EvidenceFileReadError extends Error {
  readonly name = 'EvidenceFileReadError';
}

type RootResolution =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly issue: EvidenceValidationIssue };

type FileResolution =
  | { readonly ok: true; readonly path: string; readonly bytes: Uint8Array; readonly size: number }
  | { readonly ok: false; readonly issue: EvidenceValidationIssue };

const issue = (code: EvidenceValidationIssueCode, path: readonly (string | number)[]): EvidenceValidationIssue => ({ code, path });

export function resolveEvidenceRoot(filesystem: EvidenceFilesystem, root: string): RootResolution {
  try {
    const claimed = filesystem.lstat(root);
    if (claimed.isSymbolicLink()) return { ok: false, issue: issue('evidence_root_symlink', []) };
    if (!claimed.isDirectory()) return { ok: false, issue: issue('evidence_root_not_directory', []) };
    const resolved = filesystem.realpath(root);
    const measured = filesystem.lstat(resolved);
    if (measured.isSymbolicLink()) return { ok: false, issue: issue('evidence_root_symlink', []) };
    if (!measured.isDirectory()) return { ok: false, issue: issue('evidence_root_not_directory', []) };
    return { ok: true, root: resolved };
  } catch (error) {
    if (error instanceof Error) return { ok: false, issue: issue('evidence_root_unreadable', []) };
    throw error;
  }
}

function isConfined(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '' && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot);
}

type ResolveEvidenceFileInput = {
  readonly filesystem: EvidenceFilesystem;
  readonly root: string;
  readonly claimedPath: string;
  readonly issuePath: readonly (string | number)[];
};

export function resolveEvidenceFile(input: ResolveEvidenceFileInput): FileResolution {
  const { filesystem, root, claimedPath, issuePath } = input;
  const segments = claimedPath.split(/[\\/]/u);
  try {
    let partial = root;
    for (const segment of segments) {
      partial = join(partial, segment);
      if (filesystem.lstat(partial).isSymbolicLink()) {
        return { ok: false, issue: issue('artifact_symlink', issuePath) };
      }
    }
    const resolved = filesystem.realpath(partial);
    if (!isConfined(root, resolved)) return { ok: false, issue: issue('artifact_outside_root', issuePath) };
    const stat = filesystem.lstat(resolved);
    if (stat.isSymbolicLink()) return { ok: false, issue: issue('artifact_symlink', issuePath) };
    if (!stat.isFile()) return { ok: false, issue: issue('artifact_not_regular_file', issuePath) };
    if (stat.size > MAX_EVIDENCE_ARTIFACT_BYTES) return { ok: false, issue: issue('artifact_too_large', issuePath) };
    const bytes = filesystem.readFile(resolved);
    return { ok: true, path: resolved, bytes, size: stat.size };
  } catch (error) {
    if (error instanceof Error) return { ok: false, issue: issue('artifact_unreadable', issuePath) };
    throw error;
  }
}

function isJson(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return true;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return false;
    throw error;
  }
}

function isNdjson(bytes: Uint8Array): boolean {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const lines = source.split(/\r?\n/u).filter((line) => line.length > 0);
    return lines.length > 0 && lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch (error) {
        if (error instanceof SyntaxError) return false;
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function measuredMediaType(path: string, bytes: Uint8Array): string | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === '.json' && isJson(bytes)) return 'application/json';
  if ((extension === '.jsonl' || extension === '.ndjson') && isNdjson(bytes)) return 'application/x-ndjson';
  if (extension === '.pdf' && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-') return 'application/pdf';
  if (extension === '.png' && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if ((extension === '.jpg' || extension === '.jpeg') && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if ((extension === '.txt' || extension === '.log')) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return 'text/plain';
    } catch (error) {
      if (error instanceof TypeError) return undefined;
      throw error;
    }
  }
  return undefined;
}

export function verifyArtifactFile(
  artifact: CapabilityEvidenceArtifact,
  index: number,
  file: Extract<FileResolution, { readonly ok: true }>,
): readonly EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  const path = ['artifacts', index] as const;
  if (file.size !== artifact.sizeBytes || file.bytes.byteLength !== artifact.sizeBytes) issues.push(issue('artifact_size_mismatch', [...path, 'sizeBytes']));
  if (createHash('sha256').update(file.bytes).digest('hex') !== artifact.sha256) issues.push(issue('artifact_digest_mismatch', [...path, 'sha256']));
  if (measuredMediaType(file.path, file.bytes) !== artifact.mediaType) issues.push(issue('artifact_media_type_mismatch', [...path, 'mediaType']));
  return issues;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
