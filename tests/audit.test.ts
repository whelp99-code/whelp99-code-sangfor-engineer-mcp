import { describe, expect, it } from 'vitest';
import {
  loadAuditFrameworks,
  getAuditFramework,
  listAuditFrameworkSummaries,
  validateAuditFramework,
  computeGapReport,
  type AuditOwner,
  type AuditPriority,
  type AuditMethod,
  type AuditObservation,
  type ObservationStatus,
} from '../packages/sangfor-audit/src/index.js';
import { PRODUCTS } from '../packages/shared/src/index.js';

const KNOWN_PRODUCT_CODES = new Set(PRODUCTS.map((p) => p.code));
const OWNERS: AuditOwner[] = ['customer', 'engineer', 'vendor'];
const PRIORITIES: AuditPriority[] = ['P1', 'P2', 'P3'];
const METHODS: AuditMethod[] = ['console_dryrun', 'external_evidence', 'change_required', 'procedure'];

describe('sangfor-audit — loads the seeded hyundai-supplier-2026 framework from data/audit', () => {
  it('registers the framework via sangfor_audit_frameworks-shaped summary', () => {
    const summaries = listAuditFrameworkSummaries();
    const hyundai = summaries.find((s) => s.frameworkId === 'hyundai-supplier-2026');
    expect(hyundai).toBeTruthy();
    expect(hyundai!.itemCount).toBe(35);
  });

  it('exposes the full framework via getAuditFramework', () => {
    const framework = getAuditFramework('hyundai-supplier-2026');
    expect(framework).toBeTruthy();
    expect(framework!.items).toHaveLength(35);
  });

  it('returns undefined for an unregistered frameworkId (no throw)', () => {
    expect(getAuditFramework('does-not-exist')).toBeUndefined();
  });
});

describe('sangfor-audit — seed integrity (ITEM-01..35, no dup, allowed enum values, known ProductCodes)', () => {
  const framework = getAuditFramework('hyundai-supplier-2026')!;

  it('has all of ITEM-01 through ITEM-35 present, no gaps', () => {
    const ids = framework.items.map((i) => i.itemId).sort();
    const expected = Array.from({ length: 35 }, (_, i) => `ITEM-${String(i + 1).padStart(2, '0')}`);
    expect(ids).toEqual(expected);
  });

  it('has no duplicate itemId', () => {
    const ids = framework.items.map((i) => i.itemId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every products[] entry is a known @sangfor/shared ProductCode', () => {
    for (const item of framework.items) {
      for (const code of item.products) {
        expect(KNOWN_PRODUCT_CODES.has(code), `${item.itemId} product ${code}`).toBe(true);
      }
    }
  });

  it('owner/priority/method are all within the allowed value sets', () => {
    for (const item of framework.items) {
      expect(OWNERS, item.itemId).toContain(item.owner);
      expect(PRIORITIES, item.itemId).toContain(item.priority);
      expect(METHODS, item.itemId).toContain(item.method);
    }
  });

  it('every item carries at least one reqId and at least one requiredEvidence entry', () => {
    for (const item of framework.items) {
      expect(item.reqIds.length, item.itemId).toBeGreaterThan(0);
      expect(item.requiredEvidence.length, item.itemId).toBeGreaterThan(0);
    }
  });
});

describe('validateAuditFramework — hand-rolled schema check (no zod)', () => {
  const validItem = {
    itemId: 'ITEM-01',
    topic: 'x',
    reqIds: ['REQ-1'],
    group: 'G1',
    groupLabel: 'group',
    products: ['IAG'],
    method: 'console_dryrun',
    requiredEvidence: ['evidence'],
    owner: 'engineer',
    priority: 'P1',
  };
  const validFramework = {
    frameworkId: 'fw-1',
    title: 't',
    version: '1',
    sourceNote: 'n',
    items: [validItem],
  };

  it('accepts a well-formed framework', () => {
    const result = validateAuditFramework(validFramework);
    expect(result.ok).toBe(true);
  });

  it('rejects an item with an invalid group', () => {
    const result = validateAuditFramework({ ...validFramework, items: [{ ...validItem, group: 'G9' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects an item with an unknown ProductCode', () => {
    const result = validateAuditFramework({ ...validFramework, items: [{ ...validItem, products: ['NOT_A_PRODUCT'] }] });
    expect(result.ok).toBe(false);
  });

  it('rejects an item with an invalid method/owner/priority', () => {
    expect(validateAuditFramework({ ...validFramework, items: [{ ...validItem, method: 'bogus' }] }).ok).toBe(false);
    expect(validateAuditFramework({ ...validFramework, items: [{ ...validItem, owner: 'bogus' }] }).ok).toBe(false);
    expect(validateAuditFramework({ ...validFramework, items: [{ ...validItem, priority: 'P9' }] }).ok).toBe(false);
  });

  it('rejects an empty requiredEvidence array', () => {
    const result = validateAuditFramework({ ...validFramework, items: [{ ...validItem, requiredEvidence: [] }] });
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate itemId within one framework', () => {
    const result = validateAuditFramework({ ...validFramework, items: [validItem, validItem] });
    expect(result.ok).toBe(false);
  });

  it('rejects a framework missing required top-level fields', () => {
    expect(validateAuditFramework({ title: 't' }).ok).toBe(false);
    expect(validateAuditFramework(null).ok).toBe(false);
    expect(validateAuditFramework('not an object').ok).toBe(false);
  });

  // R2: an array of strings is not enough — a blank/whitespace-only element must be rejected too,
  // not silently accepted as a "non-empty string array".
  it('rejects reqIds containing a blank or whitespace-only string', () => {
    expect(validateAuditFramework({ ...validFramework, items: [{ ...validItem, reqIds: [''] }] }).ok).toBe(false);
    expect(validateAuditFramework({ ...validFramework, items: [{ ...validItem, reqIds: ['   '] }] }).ok).toBe(false);
    expect(validateAuditFramework({ ...validFramework, items: [{ ...validItem, reqIds: ['REQ-1', '  '] }] }).ok).toBe(false);
  });

  it('rejects requiredEvidence containing a blank or whitespace-only string', () => {
    expect(validateAuditFramework({ ...validFramework, items: [{ ...validItem, requiredEvidence: [''] }] }).ok).toBe(false);
    expect(validateAuditFramework({ ...validFramework, items: [{ ...validItem, requiredEvidence: ['   '] }] }).ok).toBe(false);
  });

  it('rejects externalTools containing a blank or whitespace-only string when present', () => {
    const result = validateAuditFramework({ ...validFramework, items: [{ ...validItem, externalTools: ['FortiGate', '   '] }] });
    expect(result.ok).toBe(false);
  });

  it('still accepts a well-formed externalTools array of non-blank strings', () => {
    const result = validateAuditFramework({ ...validFramework, items: [{ ...validItem, externalTools: ['FortiGate'] }] });
    expect(result.ok).toBe(true);
  });
});

describe('computeGapReport — summary ratios (R1: observedRatio is inspection progress, metRatio is pass rate)', () => {
  const framework = getAuditFramework('hyundai-supplier-2026')!;

  it('keeps observedRatio and metRatio distinct when the checklist is fully inspected but mostly not met', () => {
    // Every item gets an observation (so unknown === 0, observedRatio === 1), but only the
    // first is 'met' — the rest alternate partial/gap, so metRatio stays low. A pass-rate-only
    // "coverage" field would have conflated these two very different facts.
    const observations: AuditObservation[] = framework.items.map((item, idx) => ({
      itemId: item.itemId,
      status: (idx === 0 ? 'met' : idx % 2 === 0 ? 'partial' : 'gap') as ObservationStatus,
      ...(idx === 0 ? { evidenceRefs: ['evidence'] } : {}),
    }));

    const report = computeGapReport(framework, observations);
    expect(report.summary.unknown).toBe(0);
    expect(report.summary.observedRatio).toBe(1);
    expect(report.summary.met).toBe(1);
    expect(report.summary.metRatio).toBeCloseTo(1 / 35, 10);
    expect(report.summary.observedRatio).not.toBe(report.summary.metRatio);
  });

  it('an empty checklist degrades both ratios to 0 (no division-by-zero/NaN)', () => {
    const empty = { ...framework, items: [] };
    const report = computeGapReport(empty, []);
    expect(report.summary.total).toBe(0);
    expect(report.summary.observedRatio).toBe(0);
    expect(report.summary.metRatio).toBe(0);
  });

  it('no coverage field is present on the summary anymore', () => {
    const report = computeGapReport(framework, []);
    expect(report.summary).not.toHaveProperty('coverage');
  });
});
