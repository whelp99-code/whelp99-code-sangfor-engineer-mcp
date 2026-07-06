# Decision: Vendor-agnostic spec/evaluate engine (data contract, not class hierarchy)

**Status:** verified

## Context
The product is Sangfor-first but must advise on FortiOS firewalls and Cisco IOS-XE routers too. These devices expose wildly different APIs (Sangfor HCI = OpenStack REST, FortiOS = `/api/v2` REST, Cisco = RESTCONF/YANG). A classic OO `Device` interface with per-vendor subclasses would force the evaluation logic to know about every transport and would grow a new method per vendor capability.

## Decision
Split "what to observe" from "how a device reports it," joined by a string key:

- **Spec packages** (`@sangfor-engineer/fortios-spec`, `cisco-spec`, and Sangfor spec data under `data/specs/`) declare `IntendedSpec` = a list of `SpecItem`s keyed by `observedKey`, each with an operator (`exists`, …), severity (`must`/…), and a manual citation. This is the *intent*.
- **Client packages** (`fortios-client`, `cisco-client`) are **pure mapper functions**: vendor API JSON → a normalized `observed` record / `ConfigStateItem[]`. They hold no transport and no state.
- **`@sangfor/spec.evaluateSpec(spec, observed)`** is the single vendor-agnostic engine that produces `PASS` / `FAIL` / `INDETERMINATE` and `renderAdvisoryReport`.

The MCP tool orchestrates: call the vendor API (or mock) → map with the client → `evaluateSpec` against the spec → render. Adding a vendor = add a spec + a client mapper + a mock-console handler + an MCP tool + spec data files, with **no change to the engine**.

## Rationale
- **Additive extension**: new vendors don't touch shared logic, so they can't regress existing advisories.
- **INDETERMINATE is first-class**: an unmapped/uncaptured `observedKey` is omitted by the mapper and the engine reports INDETERMINATE rather than a false PASS — the core belief that false confidence is dangerous.
- **Testability**: mappers are pure functions with fixture-driven tests (`fortios-config-state`, `cisco-config-state`, `spec-evaluate`); no live device needed.

## Consequences
- The vendor-agnostic `ProductCode` superset (`+ FORTIOS + CISCO_IOSXE`) lives in `@sangfor/spec`, not `@sangfor/shared` (which stays Sangfor-only).
- This pattern covers **read-only advisory** only. Live *mutation* is Sangfor-HCI-specific and lives in `@sangfor/hci-client` + `@sangfor/operator`, not in this engine.
- Related: [ARCHITECTURE.md](../../ARCHITECTURE.md#multi-vendor-abstraction), [docs/MULTIVENDOR.md](../MULTIVENDOR.md).
