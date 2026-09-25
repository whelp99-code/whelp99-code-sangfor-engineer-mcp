import { BlroAuthorityStore } from '../../sangfor-authority/src/authority-store.js';
import {
  isBlroAuthorityPostgres,
  refuseEngineerCaseLocalFallback,
  refuseEngineerCasePublicIndex,
  unsavedEngineerCase,
} from '../../sangfor-authority/src/engineer-case-persistence.js';
import type {
  AuthorityActorScope,
  EngineerCaseArtifactResult,
  EngineerCaseLoadResult,
  EngineerCaseSaveRequest,
  EngineerCaseSaveResult,
} from '../../sangfor-authority/src/authority-store-contracts.js';
import { getPrisma } from './index.js';

function authorityStore(): BlroAuthorityStore | undefined {
  const db = getPrisma();
  if (!db) return undefined;
  return new BlroAuthorityStore(db);
}

export async function persistEngineerCase(input: EngineerCaseSaveRequest): Promise<EngineerCaseSaveResult> {
  if (input.localFallback === true) return refuseEngineerCaseLocalFallback();
  const store = authorityStore();
  if (!store) {
    return isBlroAuthorityPostgres() ? refuseEngineerCaseLocalFallback() : unsavedEngineerCase('STORE_UNAVAILABLE');
  }
  return store.saveEngineerCase(input);
}

export async function loadPersistedEngineerCase(
  input: AuthorityActorScope & { readonly caseId: string },
): Promise<EngineerCaseLoadResult> {
  const store = authorityStore();
  if (!store) {
    return isBlroAuthorityPostgres() ? refuseEngineerCaseLocalFallback() : unsavedEngineerCase('STORE_UNAVAILABLE');
  }
  return store.loadEngineerCase(input);
}

export async function loadPersistedEngineerCaseArtifact(
  input: AuthorityActorScope & { readonly caseId: string; readonly artifactId: string },
): Promise<EngineerCaseArtifactResult> {
  const store = authorityStore();
  if (!store) {
    return isBlroAuthorityPostgres() ? refuseEngineerCaseLocalFallback() : unsavedEngineerCase('STORE_UNAVAILABLE');
  }
  return store.loadEngineerCaseArtifact(input);
}

export function writeEngineerCaseLocalFallback(): EngineerCaseSaveResult {
  return refuseEngineerCaseLocalFallback();
}

export function indexEngineerCaseOriginals(): EngineerCaseSaveResult {
  return refuseEngineerCasePublicIndex();
}
