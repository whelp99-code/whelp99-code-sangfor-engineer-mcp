import { z } from 'zod';
import { ENGINEER_ID_RE, ENGINEER_UNITS, type EngineerCaseDocument, type EngineerCaseAuthContext } from '../../shared/src/engineer-case-contract.js';
import { HCI_E03B_REQUIRED_FIELDS } from '../../sangfor-hci-client/src/required-observations.js';
import { ENGINEER_FORMULA_IDS, ENGINEER_FORMULA_CATALOG, evaluateEngineerFormula, operandFromObservation, type EngineerFormulaRole } from '../../sangfor-sizing/src/engineer-calculations.js';
import { assembleEngineerCase, type EngineerCaseAssembly } from './engineer-case.js';
import { assessEngineerCase } from './engineer-assessment.js';
import { buildEngineerGuide } from './engineer-guide.js';

const id = z.string().regex(ENGINEER_ID_RE).refine(v => v !== '.' && !v.includes('..'));
/** Explicit same-revision references only. No labels, executable text or scope claims. */
export const engineerProvidedAnalysisSchema = z.object({
  caseRevision: id,
  calculations: z.array(z.object({
    id, formulaId: z.enum(ENGINEER_FORMULA_IDS),
    roles: z.object({ total: id, used: id, demand: id.optional() }).strict(),
    outputUnit: z.enum(ENGINEER_UNITS).optional(),
  }).strict()).max(64),
  bindings: z.array(z.object({
    requirementId: id, fieldId: z.enum([...HCI_E03B_REQUIRED_FIELDS, 'volume_status']).optional(),
    currentRef: id.optional(), calculationRef: id.optional(),
  }).strict().refine(b => Boolean(b.currentRef) !== Boolean(b.calculationRef), 'EXACTLY_ONE_VALUE_REF')).max(256),
}).strict();
export type EngineerProvidedAnalysis = z.infer<typeof engineerProvidedAnalysisSchema>;

export function analyzeEngineerProvidedCase(
  document: EngineerCaseDocument, input: unknown, auth: EngineerCaseAuthContext,
): EngineerCaseAssembly {
  const fail = (code: string, path = 'analysis'): EngineerCaseAssembly => ({ ok: false, issues: [{ code, path, message: code }] });
  const parsed = engineerProvidedAnalysisSchema.safeParse(input);
  if (!parsed.success) return fail('ANALYSIS_SCHEMA_INVALID');
  const analysis = parsed.data;
  if (analysis.caseRevision !== document.revision) return fail('ANALYSIS_REVISION_MISMATCH');
  const initial = assembleEngineerCase(document, auth);
  if (!initial.ok) return initial;
  const observations = new Map(document.observations.map(o => [o.id, o]));
  const ids = new Set([...document.observations, ...document.requirements, ...document.evidence].map(o => o.id));
  for (const calc of analysis.calculations) {
    if (ids.has(calc.id)) return fail('DUPLICATE_ANALYSIS_ID');
    ids.add(calc.id);
    const required: readonly string[] = ENGINEER_FORMULA_CATALOG[calc.formulaId].roles;
    if (Object.keys(calc.roles).length !== required.length || !required.every(role => role in calc.roles)) return fail('FORMULA_ROLES_MISMATCH');
    for (const ref of Object.values(calc.roles)) if (ref && !observations.has(ref)) return fail('UNKNOWN_OBSERVATION_REF');
  }
  const calculations = analysis.calculations.map(calc => evaluateEngineerFormula({
    id: calc.id, formulaId: calc.formulaId, caseId: document.caseId, projectId: auth.projectId, outputUnit: calc.outputUnit,
    roles: Object.fromEntries(Object.entries(calc.roles).map(([role, ref]) => [role as EngineerFormulaRole, operandFromObservation(observations.get(ref!)!)])),
    now: new Date().toISOString(),
  }));
  const bound = new Set<string>();
  for (const binding of analysis.bindings) {
    if (bound.has(binding.requirementId)) return fail('DUPLICATE_REQUIREMENT_BINDING');
    if (!document.requirements.some(r => r.id === binding.requirementId)) return fail('UNKNOWN_REQUIREMENT_REF');
    bound.add(binding.requirementId);
    if (binding.currentRef && !observations.has(binding.currentRef)) return fail('UNKNOWN_OBSERVATION_REF');
    if (binding.calculationRef && !calculations.some(c => c.id === binding.calculationRef)) return fail('UNKNOWN_CALCULATION_REF');
  }
  if (document.requirements.some(r => !bound.has(r.id))) return fail('MISSING_REQUIREMENT_BINDING');
  const assessed = assessEngineerCase({ document: { ...initial.value, calculations }, auth, caseRevision: document.revision,
    explicitBindingsOnly: true, now: new Date().toISOString(),
    bindings: analysis.bindings.map(b => ({ requirementId: b.requirementId, fieldId: b.fieldId, currentRef: b.currentRef,
      ...(b.calculationRef ? { calculationRefs: [b.calculationRef], formulaId: analysis.calculations.find(c => c.id === b.calculationRef)!.formulaId } : {}),
    })),
  });
  if (!assessed.ok) return fail(assessed.code);
  if (!assessed.assembled.ok) return assessed.assembled;
  const built = buildEngineerGuide({ document: assessed.assembled.value, auth, caseRevision: document.revision });
  return built.ok ? assembleEngineerCase(built.document, auth) : fail(built.code);
}
