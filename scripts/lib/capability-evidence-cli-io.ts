import { lstatSync, readFileSync } from 'node:fs';
import { MAX_CAPABILITY_EVIDENCE_BYTES } from '@sangfor/competency';
import { CapabilityEvidenceCliError } from './capability-evidence-cli-errors.js';

type UnreadableCode = 'manifest_unreadable' | 'validation_context_unavailable' | 'promotion_unreadable';

export function readBoundedFile(path: string, unreadableCode: UnreadableCode): string {
  const tooLargeCode = unreadableCode === 'validation_context_unavailable'
    ? 'validation_context_too_large'
    : 'manifest_too_large';
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new CapabilityEvidenceCliError({ code: unreadableCode, path: [] });
    }
    if (file.size > MAX_CAPABILITY_EVIDENCE_BYTES) {
      throw new CapabilityEvidenceCliError({ code: tooLargeCode, path: [] });
    }
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source) > MAX_CAPABILITY_EVIDENCE_BYTES) {
      throw new CapabilityEvidenceCliError({ code: tooLargeCode, path: [] });
    }
    return source;
  } catch (error) {
    if (error instanceof CapabilityEvidenceCliError) throw error;
    if (error instanceof Error) throw new CapabilityEvidenceCliError({ code: unreadableCode, path: [] });
    throw error;
  }
}
