/**
 * Fail-closed E12 live-collect start intake.
 *
 * Names the Jae-owned fields required before a live HCI/Janus GET.
 * This module does not contact a host, invent a target, read password
 * values, grant `field_accepted`, or start E14. Unknown stays missing.
 */

import type { ProductCode } from './product-catalog.js';

export const ENGINEER_LIVE_COLLECT_INTAKE_FIELDS = [
  'authorized_read_only_target',
  'e02_ops_confirmation_and_private_store_locator',
  'janus_sanitized_capture_or_observed_path',
  'retention_sanitization_scope',
  'existing_case_requirements_and_new_build_specs',
  'read_only_session_confirmation',
] as const;

export type EngineerLiveCollectIntakeFieldId =
  (typeof ENGINEER_LIVE_COLLECT_INTAKE_FIELDS)[number];

export const ENGINEER_LIVE_COLLECT_REACH_PATH_CLASSES = [
  'private_store_injected',
  'janus_sanitized_capture',
  'observed_path_confirmed',
] as const;

export type EngineerLiveCollectReachPathClass =
  (typeof ENGINEER_LIVE_COLLECT_REACH_PATH_CLASSES)[number];

const PRODUCT_CODES = new Set<ProductCode>([
  'HCI_SCP',
  'HCI',
  'NGFW',
  'SCC',
  'IAG',
  'ENDPOINT_SECURE',
  'NDR',
  'CYBER_COMMAND',
  'HIWARE',
  'OTHER',
]);

const REACH_PATH_CLASSES = new Set<string>(ENGINEER_LIVE_COLLECT_REACH_PATH_CLASSES);
const LOCATOR = /^[A-Za-z0-9._:/-]{1,128}$/u;
const FIRMWARE = /^[A-Za-z0-9._+-]{1,64}$/u;
const SCOPE = /^[A-Za-z0-9._:-]{1,64}$/u;
const RETENTION = /^[A-Za-z0-9._-]{1,64}$/u;
const JANUS_PATH = /^\/[A-Za-z0-9._/-]{1,127}$/u;
const SECRET_SHAPE = /password|secret|cookie|token|authorization/iu;
const HOST_SHAPE = /https?:|\b\d{1,3}(?:\.\d{1,3}){3}\b/iu;

export type EngineerLiveCollectIntake = {
  readonly authorizedReadOnlyTarget?: {
    readonly product?: string;
    readonly firmware?: string;
    readonly reachPathClass?: string;
    readonly collectionScope?: string;
  };
  readonly e02?: {
    readonly opsConfirmation?: boolean;
    readonly privateStoreLocator?: string;
  };
  readonly janus?: {
    readonly sanitizedCaptureLocator?: string;
    readonly observedPathConfirmation?: string;
  };
  readonly retentionSanitizationScope?: string;
  readonly caseRequirements?: {
    readonly existingCaseRequirementsConfirmed?: boolean;
    readonly newBuildProvidedProposedSpecsConfirmed?: boolean;
  };
  readonly readOnlySession?: {
    readonly confirmedReadOnly?: boolean;
    readonly allowRealExecution?: boolean;
  };
};

export type EngineerLiveCollectMissingField = {
  readonly id: EngineerLiveCollectIntakeFieldId;
  readonly status: 'missing';
};

export type EngineerLiveCollectIntakeIncomplete = {
  readonly ok: false;
  readonly fieldAccepted: false;
  readonly grantPath: 'none';
  readonly liveRead: 'not_run';
  readonly collectExecuted: false;
  readonly networkContacted: false;
  readonly reasonCode: 'LIVE_COLLECT_INTAKE_INCOMPLETE' | 'LIVE_COLLECT_REAL_EXECUTION_REFUSED';
  readonly missingFields: readonly EngineerLiveCollectMissingField[];
  readonly mutationDispatchCount: 0;
};

export type EngineerLiveCollectIntakeComplete = {
  readonly ok: true;
  readonly fieldAccepted: false;
  readonly grantPath: 'none';
  readonly liveRead: 'not_run';
  readonly collectExecuted: false;
  readonly networkContacted: false;
  readonly reasonCode: 'LIVE_COLLECT_INTAKE_COMPLETE';
  readonly missingFields: readonly [];
  readonly mutationDispatchCount: 0;
};

export type EngineerLiveCollectStartRefusal = {
  readonly ok: false;
  readonly fieldAccepted: false;
  readonly grantPath: 'none';
  readonly liveRead: 'not_run';
  readonly collectExecuted: false;
  readonly networkContacted: false;
  readonly reasonCode:
    | 'LIVE_COLLECT_INTAKE_INCOMPLETE'
    | 'LIVE_COLLECT_REAL_EXECUTION_REFUSED'
    | 'LIVE_COLLECT_INTAKE_COMPLETE_NOT_STARTED';
  readonly missingFields: readonly EngineerLiveCollectMissingField[];
  readonly mutationDispatchCount: 0;
};

export type EngineerLiveCollectIntakeResult =
  | EngineerLiveCollectIntakeIncomplete
  | EngineerLiveCollectIntakeComplete;

function present(value: string | undefined, pattern: RegExp): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) return false;
  if (SECRET_SHAPE.test(trimmed) || HOST_SHAPE.test(trimmed) || trimmed.includes('=')) return false;
  return true;
}

function missing(id: EngineerLiveCollectIntakeFieldId): EngineerLiveCollectMissingField {
  return { id, status: 'missing' };
}

function realExecutionRequested(intake: EngineerLiveCollectIntake | undefined): boolean {
  return intake?.readOnlySession?.allowRealExecution === true
    || process.env.SANGFOR_ALLOW_REAL_EXECUTION === 'true';
}

function collectMissingFields(intake: EngineerLiveCollectIntake | undefined): EngineerLiveCollectMissingField[] {
  const missingFields: EngineerLiveCollectMissingField[] = [];
  const target = intake?.authorizedReadOnlyTarget;
  const productOk = typeof target?.product === 'string' && PRODUCT_CODES.has(target.product as ProductCode);
  const firmwareOk = present(target?.firmware, FIRMWARE);
  const reachOk = typeof target?.reachPathClass === 'string' && REACH_PATH_CLASSES.has(target.reachPathClass);
  const scopeOk = present(target?.collectionScope, SCOPE);
  if (!productOk || !firmwareOk || !reachOk || !scopeOk) {
    missingFields.push(missing('authorized_read_only_target'));
  }

  const e02Ok = intake?.e02?.opsConfirmation === true
    && present(intake.e02.privateStoreLocator, LOCATOR);
  if (!e02Ok) missingFields.push(missing('e02_ops_confirmation_and_private_store_locator'));

  const janusLocatorOk = present(intake?.janus?.sanitizedCaptureLocator, LOCATOR);
  const janusPathOk = present(intake?.janus?.observedPathConfirmation, JANUS_PATH);
  if (!janusLocatorOk && !janusPathOk) {
    missingFields.push(missing('janus_sanitized_capture_or_observed_path'));
  }

  if (!present(intake?.retentionSanitizationScope, RETENTION)) {
    missingFields.push(missing('retention_sanitization_scope'));
  }

  const requirementsOk = intake?.caseRequirements?.existingCaseRequirementsConfirmed === true
    && intake.caseRequirements.newBuildProvidedProposedSpecsConfirmed === true;
  if (!requirementsOk) {
    missingFields.push(missing('existing_case_requirements_and_new_build_specs'));
  }

  const readOnlyOk = intake?.readOnlySession?.confirmedReadOnly === true
    && !realExecutionRequested(intake);
  if (!readOnlyOk) missingFields.push(missing('read_only_session_confirmation'));

  return missingFields;
}

function refusal(
  reasonCode: EngineerLiveCollectIntakeIncomplete['reasonCode'],
  missingFields: readonly EngineerLiveCollectMissingField[],
): EngineerLiveCollectIntakeIncomplete {
  return {
    ok: false,
    fieldAccepted: false,
    grantPath: 'none',
    liveRead: 'not_run',
    collectExecuted: false,
    networkContacted: false,
    reasonCode,
    missingFields,
    mutationDispatchCount: 0,
  };
}

export function evaluateEngineerLiveCollectStart(
  intake?: EngineerLiveCollectIntake,
): EngineerLiveCollectIntakeResult {
  const missingFields = collectMissingFields(intake);
  if (realExecutionRequested(intake)) {
    return refusal('LIVE_COLLECT_REAL_EXECUTION_REFUSED', missingFields);
  }
  if (missingFields.length > 0) {
    return refusal('LIVE_COLLECT_INTAKE_INCOMPLETE', missingFields);
  }
  return {
    ok: true,
    fieldAccepted: false,
    grantPath: 'none',
    liveRead: 'not_run',
    collectExecuted: false,
    networkContacted: false,
    reasonCode: 'LIVE_COLLECT_INTAKE_COMPLETE',
    missingFields: [],
    mutationDispatchCount: 0,
  };
}
