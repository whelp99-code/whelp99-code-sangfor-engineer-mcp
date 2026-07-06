# Decision: Thin apps, fat packages, layered downward

**Status:** verified

## Context
There are multiple surfaces onto the same domain: an MCP stdio server, a REST bridge, an ops dashboard, and an engineer web console. If each app reimplemented planning/approval/execution, the safety logic would fork and drift — a fatal outcome for a security-critical product.

## Decision
- **All domain logic lives in `packages/*`.** Apps (`apps/*`) are thin transport adapters: they parse a request, call a package function, and shape a response. `apps/mcp-server` is the widest consumer (imports ~27 packages to expose 77 tools); `operator-console` calls packages in-process; `control-tower` and `http-bridge` mostly call *over HTTP* to other apps.
- **Dependency graph is layered and points downward** (see ARCHITECTURE.md): `L0 shared` (leaf) → `L1 domain/data` → `L2 execution` (operator, planner) → `L3 orchestration` (verifier, product-adapters) → apps. No L1 package imports an L2/L3 package.
- **Loose coupling at the top**: `collector` receives `rag`/`finetune` via injected function params rather than importing them, so the learning orchestrator doesn't hard-wire the heavy deps.
- **Run from source**: apps and tests run TypeScript directly via `tsx`/Vitest aliases; no build artifact is needed to run or test.

## Rationale
- **One implementation of safety**: the execution gate exists once (`@sangfor/operator`) and every surface routes through it. Two independent guards (operator gate + http-bridge `tool-guard`) are deliberate defense-in-depth, not duplication of business logic.
- **Change locality**: new capability = a package + a test, then a thin tool/route to expose it. Reviews focus on the package.
- **Layer rule makes cycles impossible** and keeps `shared` dependency-free, so anything can import it.

## Consequences
- Apps have minimal `package.json` (name/type/main); they import packages by relative path (`../../../packages/<pkg>/src/index.js`), while packages import each other via `@sangfor/*` tsconfig/vitest aliases.
- A behavioral change requested "in the app" almost always belongs in a package — put it there and expose it thinly.
- Related: [ARCHITECTURE.md](../../ARCHITECTURE.md#dependency-layering-the-rule-imports-point-downward-never-up), [CODE-REVIEW.md](../CODE-REVIEW.md).
