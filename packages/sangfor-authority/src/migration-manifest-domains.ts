import { sourcesFor } from './migration-manifest-builder.js';
import {
  CAPABILITY_REFS,
  CONFIG_REFS,
  EVALS_REFS,
  FEEDBACK_REFS,
  FIRMWARE_REFS,
  LEARNING_REFS,
  PM_REFS,
  WIKI_REFS,
} from './migration-inventory-domains.js';

export const DOMAIN_MIGRATIONS = [
  {
    id: 'm010-pm-tasks', order: 10, aggregate: 'pm_tasks', ownerPackage: '@sangfor/pm', classification: 'authoritative',
    sources: sourcesFor(PM_REFS), target: { kind: 'postgres', tables: ['BlroPmRecord'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['pm-authority-schema'], dependsOn: ['m002-project-installation-identity', 'm003-registry-services'], inventoryRefs: [...PM_REFS],
  },
  {
    id: 'm011-feedback-lessons', order: 11, aggregate: 'feedback_lessons', ownerPackage: '@sangfor/feedback', classification: 'authoritative',
    sources: sourcesFor(FEEDBACK_REFS), target: { kind: 'postgres', tables: ['BlroFeedbackLesson'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['feedback-authority-schema'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...FEEDBACK_REFS],
  },
  {
    id: 'm012-evals', order: 12, aggregate: 'evals', ownerPackage: '@sangfor/evals', classification: 'authoritative',
    sources: sourcesFor(EVALS_REFS), target: { kind: 'postgres', tables: ['BlroEvalRecord'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['eval-authority-schema'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...EVALS_REFS],
  },
  {
    id: 'm013-wiki-proposals', order: 13, aggregate: 'wiki_proposals', ownerPackage: '@sangfor/wiki', classification: 'authoritative',
    sources: sourcesFor(WIKI_REFS), target: { kind: 'postgres', tables: ['BlroWikiProposal'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['wiki-authority-schema'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...WIKI_REFS],
  },
  {
    id: 'm014-learning-strategy-lifecycle', order: 14, aggregate: 'learning_strategy_lifecycle', ownerPackage: '@sangfor/learning-strategy', classification: 'authoritative',
    sources: sourcesFor(LEARNING_REFS), target: { kind: 'postgres', tables: ['BlroLearningRecord'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['learning-authority-schema'], dependsOn: ['m002-project-installation-identity', 'm007-evidence'], inventoryRefs: [...LEARNING_REFS],
  },
  {
    id: 'm015-firmware-version-evidence', order: 15, aggregate: 'firmware_version_evidence', ownerPackage: '@sangfor/version', classification: 'authoritative',
    sources: sourcesFor(FIRMWARE_REFS), target: { kind: 'postgres', tables: ['BlroFirmwareEvidence'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['firmware-evidence-schema'], dependsOn: ['m002-project-installation-identity', 'm007-evidence'], inventoryRefs: [...FIRMWARE_REFS],
  },
  {
    id: 'm016-config-chronicle-state', order: 16, aggregate: 'config_chronicle_state', ownerPackage: '@sangfor/chronicle', classification: 'authoritative',
    sources: sourcesFor(CONFIG_REFS), target: { kind: 'postgres', tables: ['BlroConfigChronicle'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['config-chronicle-schema'], dependsOn: ['m002-project-installation-identity', 'm003-registry-services'], inventoryRefs: [...CONFIG_REFS],
  },
  {
    id: 'm017-capability-evidence-promotion', order: 17, aggregate: 'capability_evidence_promotion', ownerPackage: '@sangfor/competency', classification: 'authoritative',
    sources: sourcesFor(CAPABILITY_REFS), target: { kind: 'postgres', tables: ['BlroCapabilityEvidence'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['capability-evidence-schema'], dependsOn: ['m002-project-installation-identity', 'm007-evidence'], inventoryRefs: [...CAPABILITY_REFS],
  },
] as const;
