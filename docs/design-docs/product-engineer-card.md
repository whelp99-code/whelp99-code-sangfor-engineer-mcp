# Decision: Product engineer card (thin allowlist, not a new brain)

**Status:** draft — **frozen pending #28.** Do not implement before one real device has completed collect → evaluate → report by hand. The schema below is a hypothesis; the first card must be *extracted* from that run, not derived from imagination.

## Context

A new product should not spawn a new MCP server, a new evaluate engine, or a long-lived “HCI 시니어” persona. The shared spine already exists: spec + mapper + `evaluateSpec` + approval + EngineerReport. What a product actually differs in is *how it is observed* and *which session may hold which hand*.

The gap is small and specific: nothing today says **“for this product, may a session touch a browser, and which tools must it never see.”** That is all a card is for.

Everything else already has an owner, and the card must not copy it:

| Already owned by | Fields |
|---|---|
| `@sangfor/learning-strategy` `ProductRegistryEntry` | vendor, aliases, `defaultSpecMapping`, `specMappingByVariant` |
| `@sangfor/product-adapters` `ProductAdapter` | `strategy`, `authMethods`, `apiCatalogStatus`, `menuRoutes`, capabilities |
| `@sangfor/shared` / `@sangfor/spec` | `ProductCode` catalogs |
| MCP server | `SANGFOR_TOOL_PROFILE`, per-tool `readOnlyHint` / `destructiveHint` annotations |

The repo already has a `REGISTRY_DRIFT` error code, which means duplicated product identity has bitten this codebase before. A card that re-states registry facts would reintroduce exactly that bug class.

## Decision

### 1. Two session roles, not four occupations

An earlier draft proposed four LLM “occupations” (collector / advisor / scribe / operator). Two of them do not need a model:

| Stage | Kind | Why |
|---|---|---|
| **collector** | LLM session | Needs judgment: where to look, when REST is insufficient, when to escalate to a browser, when to stop |
| **evaluate** | deterministic function | `evaluateSpec(spec, observed)`. A model near a verdict is the main false-PASS surface |
| **report** | deterministic function | EngineerReport build + ledger append. The engine result is frozen input |
| **operator** | LLM session | Needs judgment *and* a human gate: dry-run, approval request, read-back interpretation |

So: `SessionRole = 'collector' | 'operator'`. Evaluate and report are pipeline stages the orchestrator calls directly.

### 2. The card is thin and points at the registry

```ts
/** schemaVersion bumps only on breaking field changes. Stays unversioned in
 *  practice until a second real card exists. */
export type ProductCardSchemaVersion = 1;

export type SessionRole = 'collector' | 'operator';

export interface ProductEngineerCard {
  schemaVersion: ProductCardSchemaVersion;
  /** Stable id, e.g. "sangfor.hci_scp". */
  cardId: string;

  /** The ONLY identity field. vendor, aliases, specMapping, strategy,
   *  menuRoutes and restCatalog are resolved from the registry + adapter at
   *  load time. Never copied here. */
  registryProduct: string;
  /** Reuses the existing drift check; mismatch → refuse. */
  expectedRegistryDigest?: string;

  /** Roles this product may open. Anything not listed → refuse. */
  sessions: SessionRole[];

  collect: {
    /** A collector session gets browser tools only when this is true. */
    browserAllowed: boolean;
    /** Env var NAMES only. Never a secret, never a literal URL. */
    consoleBaseUrlEnv?: string;
  };

  safety: {
    writeSurface: 'none' | 'operator-gated';
    /** Scorecard floor before an operator session may open. */
    autonomyMinTier: 'bronze' | 'silver' | 'gold';
    irreversibleHumanOnly: string[];
  };

  /** EXCEPTIONS ONLY. The default tool set is derived, not listed. */
  toolOverrides: {
    allow: string[];
    deny: string[];
  };

  /** Non-judging hints. Never an input to evaluateSpec. */
  fieldNotes: {
    doNot: string[];
  };

  learning?: {
    /** Partition key for feedback/lessons/chronicle. Defaults to cardId. */
    ledgerKey: string;
    approvedLessonIds: string[];
  };
}
```

### 3. Tool surface is derived, not enumerated

A hand-maintained `allowedTools` array across 115+ growing tools rots: every new tool would need an edit in every card, and the first person under deadline writes `"*"`.

Invert it. Each MCP tool already carries `readOnlyHint` / `destructiveHint` annotations. Derive the default per role:

```
collector : readOnlyHint === true  (+ browser tools iff collect.browserAllowed)
operator  : destructiveHint === true, and only when writeSurface === 'operator-gated'
```

Then apply `SANGFOR_TOOL_PROFILE`, then the card's `toolOverrides`. The card carries only what the derivation gets wrong for this product — normally a handful of entries, often zero.

An unannotated tool is treated as destructive (fail closed) and therefore invisible to a collector.

### 4. Partial collection has one rule

The common case is not a clean success or a clean failure — it is 6 of 10 facts. Leaving this undefined guarantees the orchestrator improvises, which is the non-determinism this design exists to remove.

- **Evaluate always runs on whatever was collected.** Missing `observedKey`s produce INDETERMINATE. The engine already does this; do not add a “wait for completeness” branch.
- **Re-collect is a separate, explicit job**, not an in-session retry loop. It is queued through the existing `@sangfor/acquisition` targeted re-collect queue when an INDETERMINATE threshold is crossed.
- INDETERMINATE is never upgraded by a second opinion from a model.

### Fail-closed rules

- `registryProduct` unresolvable, or digest mismatch → `UNSUPPORTED_PRODUCT` / `REGISTRY_DRIFT`.
- Requested role ∉ `sessions` → refuse.
- Evaluate with no resolvable spec mapping or mapper → refuse. Never a fabricated evaluation.
- `operator` with `writeSurface === 'none'`, or scorecard tier below `autonomyMinTier` → refuse.
- `browserAllowed === false`, or role ≠ `collector` → no browser tools in the session.
- Cards are committed data. An LLM draft is a proposal until a human merges it; cards are never generated in the hot path.

## Orchestrator dispatch

The orchestrator is a router. It does not click consoles and does not call `evaluateSpec` on its own judgment.

It is **dispatch**, not unattended self-spawning:

1. A job arrives (“HCI health”, “FortiOS baseline”).
2. The orchestrator selects one `{ cardId, role, engagementId }`.
3. It opens one short-lived session with the derived tool surface (§3).
4. The session returns only its contract — collector: observations + provenance; operator: dry-run / approval request / read-back — and exits.
5. Evaluate and report run as function calls, not sessions.
6. If another session is needed, a **new** one is opened. Roles never mutate in place.

Assess job: `collector → evaluate() → report()`. `operator` never joins that chain automatically; it requires an explicit human request plus `writeSurface === 'operator-gated'`.

This process does not exist in-repo. Today's equivalent is a human splitting work across `task`/subagents.

## Learning loop

The loop is viable, but only if it learns **observation, not verdict**. Trying to learn expected values as constants is what makes this look impossible.

| Learnable (deterministic) | Not learnable (environment-dependent) |
|---|---|
| Which endpoint / XHR / selector carries a fact on this firmware | Whether MTU should be 9000 here |
| Whether the fact was captured at all (binary) | Whether a given FAIL is actually a defect |
| Whether the mapper folded API JSON correctly (golden corpus) | Recommendation prose |
| The `evaluateSpec` result for given observations | |

The right-hand column is already acknowledged in code: `SpecItem.contextDependent` marks deviations that may be an intended choice and must never be asserted as misconfiguration.

**Loop:**

1. collector runs → observations + provenance.
2. `evaluateSpec` produces verdicts. No model involved.
3. A human reviews **only the residue** — INDETERMINATEs and `contextDependent` FAILs. This is the label. PASSes are not reviewed.
4. The label lands in one of two places:
   - *couldn’t observe* → a collection recipe fix (LM-01~LM-08 / LR-01~LR-04)
   - *observed, but the deviation was intended* → a spec condition or context refinement
5. Re-run and measure the delta.

**Measure the loop with the scorecard metrics that already exist**, not with “accuracy”: `collectionSuccessRate` ↑, INDETERMINATE rate ↓, `corroborationDivergence` ↓, `freshnessAttainment` ↑.

**Varying values are handled as context-conditioned priors, never as learned constants.** “47 of 50 verified clusters in this size tier use 9000” is information for a human reviewer, not a verdict. Below the sample floor, emit insufficient-data rather than a band — the same discipline `@sangfor/first-line` uses for normal-range envelopes.

**Promotion stays gated.** Recipe/spec changes ride shadow mode (compare beside the incumbent; no activation below the sample and rate floors), and strategy maturity moves `draft → researched → lab_verified → device_verified → strategy_field_verified` with human HMAC at every hop. `strategy_field_verified` alone does not increment the competency replacement rate.

**The bottleneck is human review throughput**, not model capability. So the loop’s design goal is to *reduce the number of items a human must look at* — fewer INDETERMINATEs means faster learning. Fine-tuning is last and applies to report prose only, never to verdicts; today the overwhelming majority of improvement arrives as recipe, spec, and mapper diffs.

## Rationale

- Reuses the vendor-agnostic evaluate decision: new products add data, not a class hierarchy and not a persona.
- Fixes the observed “agents don’t use the plugins” failure by *removing* tools a role must not see, rather than adding another system prompt.
- Deriving the tool surface from annotations keeps cards small enough that they stay honest.
- Keeps agent-browser as a collector transport, never a second write spine.
- Keeps every model out of the verdict path, which is the one failure this product cannot survive.

## Consequences

- **Sequencing: #28 before #29.** Prove one device end-to-end by hand first — install agent-browser, log into one console, collect, evaluate, report. Extract the first card from what that run actually required. A schema written before the first run will have wrong field names.
- Whether `browserAllowed` is even needed is unproven: agent-browser is not installed on this workstation and has never authenticated against a Sangfor console here.
- Implementation, when unfrozen: a refuse-closed loader (Zod), `data/product-cards/*.json`, the annotation-derived tool surface, and refusal tests for each fail-closed rule.
- Do not put card types in L0 `shared` until a package imports them; first home is a small L1 module plus `data/product-cards/`.
- Related: [vendor-agnostic-spec-evaluate](vendor-agnostic-spec-evaluate.md), [docs/MULTIVENDOR.md](../MULTIVENDOR.md), [docs/PRODUCT-SENSE.md](../PRODUCT-SENSE.md).
