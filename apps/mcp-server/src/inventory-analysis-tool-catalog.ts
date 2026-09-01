import { resolveRepoData } from '../../../packages/shared/src/index.js';
import { getHead as getChronicleHead, getDiff as getChronicleDiff, findUnapprovedDrift, listSnapshots as listChronicleSnapshots } from '../../../packages/sangfor-chronicle/src/index.js';
import { readdirSync } from 'node:fs';
import { queryDevices, computeTier, autonomyAllowed } from '../../../packages/sangfor-scorecard/src/index.js';
import type { ScorecardMetrics, TierThresholds } from '../../../packages/sangfor-scorecard/src/index.js';
import { verifyReportChain } from '../../../packages/sangfor-engineer-report/src/index.js';
import { getCapabilitySafety, listCapabilitySafety } from '../../../packages/sangfor-safety/src/index.js';
import { listedToolsForProfile as listToolsForProfile } from './tool-catalog-view.js';
import { buildRepoCoverageContext, computeReplacementCoverage, loadWorkAtomCatalog } from '../../../packages/sangfor-competency/src/index.js';
import { paginateOptionalField } from './catalog-query-support.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const inventoryAnalysisToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_chronicle_diff", {
    description: 'Read-only: latest (or span) semantic config diff for a device from the local Config Chronicle (content-addressed snapshot DAG, issue #23). Returns head hash, parent link and the write-time diff; unknown device → error, never a fabricated diff.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, dir: { type: 'string' }, fromHash: { type: 'string' }, toHash: { type: 'string' } }, required: ['deviceId'] },
    handler: (args: { deviceId: string; dir?: string; fromHash?: string; toHash?: string }) => {
      const dir = args.dir ?? resolveRepoData('data/chronicle', 'SANGFOR_CHRONICLE_DIR');
      const head = getChronicleHead(args.deviceId, dir);
      if (!head) return { error: `no chronicle chain for device "${args.deviceId}" — nothing has been recorded` };
      const diff = getChronicleDiff(args.deviceId, dir, { fromHash: args.fromHash, toHash: args.toHash });
      return { deviceId: args.deviceId, headHash: head.hash, parentHash: head.parentHash, capturedAt: head.capturedAt, diff };
    }
  }],
  ["sangfor_drift_findings", {
    description: 'Read-only: unapproved-drift findings for a device — chronicle diffs joined against caller-supplied change approvals (dependency-injected; this tool never writes). A diff whose capture time falls inside an approval window produces no finding.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, dir: { type: 'string' }, approvals: { type: 'array', items: { type: 'object', properties: { changeTicketId: { type: 'string' }, deviceId: { type: 'string' }, approvedAt: { type: 'string' }, windowStartAt: { type: 'string' }, windowEndAt: { type: 'string' } }, required: ['changeTicketId', 'deviceId', 'approvedAt'] } } }, required: ['deviceId'] },
    handler: (args: { deviceId: string; dir?: string; approvals?: Array<{ changeTicketId: string; deviceId: string; approvedAt: string; windowStartAt?: string; windowEndAt?: string }> }) => {
      const dir = args.dir ?? resolveRepoData('data/chronicle', 'SANGFOR_CHRONICLE_DIR');
      const findings = findUnapprovedDrift({ deviceId: args.deviceId, dir, approvals: args.approvals ?? [] });
      return { deviceId: args.deviceId, approvalsSupplied: (args.approvals ?? []).length, findings };
    }
  }],
  ["sangfor_snapshot_query", {
    description: 'Read-only: point-in-time query over local Config Chronicle chains — "which devices satisfy <key op value> (optionally as of a past timestamp)". Devices without an eligible snapshot are reported under noData, never matched; an empty chronicle dir is an error, never an empty fabricated answer.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, where: { type: 'object', properties: { key: { type: 'string' }, op: { type: 'string', enum: ['eq', 'neq', 'lt', 'gte', 'exists'] }, value: {} }, required: ['key', 'op'] }, asOf: { type: 'string' } }, required: ['where'] },
    handler: (args: { dir?: string; where: { key: string; op: 'eq' | 'neq' | 'lt' | 'gte' | 'exists'; value?: unknown }; asOf?: string }) => {
      const dir = args.dir ?? resolveRepoData('data/chronicle', 'SANGFOR_CHRONICLE_DIR');
      let deviceIds: string[] = [];
      try {
        deviceIds = readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
      } catch {
        return { error: `chronicle dir unreadable: ${dir}` };
      }
      if (deviceIds.length === 0) return { error: `no chronicle chains under ${dir} — nothing has been recorded` };
      const chains = Object.fromEntries(deviceIds.map((deviceId) => [
        deviceId,
        listChronicleSnapshots(deviceId, dir).map((snapshot) => ({ capturedAt: snapshot.capturedAt, observed: snapshot.observed })),
      ]));
      return queryDevices({ chains, where: { key: args.where.key, op: args.where.op, value: args.where.value ?? null }, ...(args.asOf ? { asOf: args.asOf } : {}) });
    }
  }],
  ["sangfor_report_chain_verify", {
    description: 'Read-only: verify the hash-chained EngineerReport ledger in a directory — detects edited verdicts, deleted records, and unparseable lines. Reports the honest chain state; it never repairs anything.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    handler: (args: { dir?: string }) => verifyReportChain(args.dir ?? resolveRepoData('data/engineer-reports', 'SANGFOR_ENGINEER_REPORT_DIR'))
  }],
  ["sangfor_scorecard_tier", {
    description: 'Read-only advisory: compute a device acquisition-quality tier (bronze/silver/gold with dwell hysteresis) from caller-supplied metrics and thresholds, plus which autonomy capabilities that tier permits (auto-close and cross-device specs are gold-only, fail-closed).',
    inputSchema: { type: 'object', properties: { metrics: { type: 'object' }, thresholds: { type: 'object' }, previous: { type: 'object' } }, required: ['metrics', 'thresholds'] },
    handler: (args: { metrics: ScorecardMetrics; thresholds: TierThresholds; previous?: { tier: 'bronze' | 'silver' | 'gold'; sinceAt: string; candidateTier: 'bronze' | 'silver' | 'gold'; candidateSinceAt: string } }) => {
      const result = computeTier(args.metrics, args.thresholds, args.previous);
      return {
        ...result,
        autonomy: {
          'auto-close': autonomyAllowed(result.tier, 'auto-close'),
          'cross-device-spec': autonomyAllowed(result.tier, 'cross-device-spec'),
        },
      };
    }
  }],
  ["sangfor_capability_safety", {
    description: 'Report capability safety_class and maturity from physically separated safety/competency files. Default is human_only; autoAllowed is true only for explicit auto_allowed entries, and fieldVerifiedAutoAllowed additionally requires maturity=field_verified.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, capabilityId: { type: 'string' } } },
    handler: (args: { product?: string; capabilityId?: string }) => args.product && args.capabilityId
      ? getCapabilitySafety(args.product, args.capabilityId)
      : { capabilities: listCapabilitySafety() }
  }],
  ["sangfor_field_engineer_coverage", {
    description: 'Honest "field-engineer replacement rate" from the WorkAtom taxonomy: counts ONLY automatable AND field_verified atoms whose covering tool is ADVERTISED by the active tool profile and whose evidence is a real confined artifact. Human-only atoms never count. Any unverifiable claim refuses the whole report (ok=false + typed violations) instead of returning a quietly wrong rate. groundedToolCount reports how many advertised tools the grounding used. Optional cursor/limit page the atoms list; omit both for the full list.',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    handler: (args: { cursor?: string; limit?: number }) => {
      // Ground on what this server ADVERTISES, not on the internal tool map: a
      // tool hidden by the active profile cannot be called by any client here, so
      // certifying a replacement against it would claim a capability nobody can
      // reach. The rest of the context is the one repo-anchored factory both
      // surfaces share, so the console can never disagree with this rate.
      const advertised = listToolsForProfile().map((t) => t.name);
      const groundedToolCount = advertised.length;
      const built = buildRepoCoverageContext(advertised);
      if (!built.ok) return { ok: false, groundedToolCount, violations: built.violations };

      const result = computeReplacementCoverage(built.context);
      if (!result.ok) return { ok: false, groundedToolCount, violations: result.violations };

      const loaded = loadWorkAtomCatalog(built.context.catalogRoot);
      if (!loaded.ok) return { ok: false, groundedToolCount, violations: loaded.violations };
      // coverage is computed over ALL atoms regardless of pagination — only the
      // returned `atoms` listing is windowed. Sort by id so a cursor always
      // resumes at the same row (loader order is directory order, not stable).
      const sortedAtoms = [...loaded.atoms].sort((a, b) => a.id.localeCompare(b.id));
      return { ok: true, groundedToolCount, coverage: result.report, ...paginateOptionalField(sortedAtoms, args, (a) => a.id, 'atoms') };
    }
  }],
];
