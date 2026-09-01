export declare class BlroEvidenceObjectError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string);
}

export interface ResolvedEvidenceObject {
  readonly objectPath: string;
  readonly objectHash: string;
  readonly objectBytes: number;
}

export interface EvidenceManifestRow {
  readonly id: string;
  readonly contentHash: string;
  readonly manifest: unknown;
}

export declare function parseObjectReferences(manifestValue: unknown): readonly string[];
export declare function resolveEvidenceObject(
  manifestRow: EvidenceManifestRow,
  evidenceRoot: string,
): ResolvedEvidenceObject;
