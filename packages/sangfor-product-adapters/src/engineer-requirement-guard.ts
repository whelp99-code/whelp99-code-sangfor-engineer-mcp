import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export const ENGINEER_REQUIREMENT_MAX_XLSX_BYTES = 2 * 1024 * 1024;

export type EngineerRequirementGuardCode =
  | 'PATH_TRAVERSAL'
  | 'CROSS_CUSTOMER_FILE'
  | 'FILE_TOO_LARGE'
  | 'MALFORMED_EXCEL'
  | 'SYMLINK_FORBIDDEN'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_EXTENSION'
  | 'ALLOWED_ROOT_REQUIRED';

export type EngineerRequirementGuardFailure = {
  readonly ok: false;
  readonly code: EngineerRequirementGuardCode;
  readonly message: string;
};

export type EngineerRequirementGuardSuccess = {
  readonly ok: true;
  readonly resolvedPath: string;
};

const fail = (code: EngineerRequirementGuardCode, message: string): EngineerRequirementGuardFailure => ({
  ok: false,
  code,
  message,
});

function containedByRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * Resolve a customer Excel path inside an authenticated case/project root.
 * `..` and symlink escapes are refused. A path that resolves outside the root
 * is a cross-customer file, not a silent fallback to another tree.
 */
export function assertEngineerRequirementFile(input: {
  readonly filePath: string;
  readonly allowedRoot: string;
  readonly projectId: string;
}): EngineerRequirementGuardSuccess | EngineerRequirementGuardFailure {
  const filePath = input.filePath.trim();
  const allowedRoot = input.allowedRoot.trim();
  if (!allowedRoot) return fail('ALLOWED_ROOT_REQUIRED', 'allowedRoot is required for Excel ingest');
  if (!filePath) return fail('FILE_NOT_FOUND', 'filePath is required');
  if (filePath.includes('\0') || allowedRoot.includes('\0')) {
    return fail('PATH_TRAVERSAL', 'NUL in path is refused');
  }
  if (!filePath.toLowerCase().endsWith('.xlsx')) {
    return fail('UNSUPPORTED_EXTENSION', `Expected .xlsx file: ${filePath}`);
  }
  if (filePath.includes('..') || allowedRoot.includes('..')) {
    return fail('PATH_TRAVERSAL', `Path traversal refused: ${filePath}`);
  }

  const root = resolve(allowedRoot);
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  if (!containedByRoot(root, candidate)) {
    return fail('CROSS_CUSTOMER_FILE', `File is outside the allowed project root for ${input.projectId}`);
  }
  if (!existsSync(candidate)) return fail('FILE_NOT_FOUND', `Excel file not found: ${candidate}`);

  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) return fail('SYMLINK_FORBIDDEN', `Symlink refused: ${candidate}`);
  if (!stat.isFile()) return fail('MALFORMED_EXCEL', 'Excel path is not a regular file');
  const real = realpathSync(candidate);
  if (!containedByRoot(root, real)) {
    return fail('PATH_TRAVERSAL', `Resolved path escapes allowed root: ${filePath}`);
  }
  if (stat.size > ENGINEER_REQUIREMENT_MAX_XLSX_BYTES) {
    return fail('FILE_TOO_LARGE', `Excel exceeds ${ENGINEER_REQUIREMENT_MAX_XLSX_BYTES} bytes`);
  }
  if (!hasZipMagic(real)) return fail('MALFORMED_EXCEL', 'Excel is not a zip workbook');
  return { ok: true, resolvedPath: real };
}

function hasZipMagic(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const bytes = readSync(fd, header, 0, 4, 0);
    return bytes >= 2 && header[0] === 0x50 && header[1] === 0x4b;
  } finally {
    closeSync(fd);
  }
}

export function isExternalFileReference(text: string, allowedRoot: string): boolean {
  const root = resolve(allowedRoot);
  const matches = text.match(/(?:[A-Za-z]:)?(?:\/|\\)[^\s"'<>]+/g) ?? [];
  return matches.some((raw) => {
    const cleaned = raw.replace(/[.,;:)]+$/u, '');
    if (!cleaned.toLowerCase().endsWith('.xlsx') && !cleaned.includes(`${sep}customers${sep}`)) return false;
    if (cleaned.includes('..')) return true;
    try {
      return !containedByRoot(root, resolve(cleaned));
    } catch {
      return true;
    }
  });
}
