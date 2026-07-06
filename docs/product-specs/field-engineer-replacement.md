# Product Spec: Field-Engineer Replacement

**Status:** active

## Goal
Substitute a single *trusted* Sangfor field engineer — the fusion of four roles (Presales SE, Delivery, Ops/TAC, embedded mini-PM) — across the full engagement lifecycle (discovery → design → PoC → delivery → ops). The target competency is **L2 breadth across all products + L3 depth for read-only advisory and diagnosis**.

## The AI's superpower vs. its permanent limit
- **Superpower:** never forgets a version delta, never skips a checklist item, always cites its source, always flags what it does not know.
- **Permanent limit:** humans keep the irreversible hand and the signature of accountability. Physical installs, irreversible applies, and customer risk decisions are never automated.

## Success metric (honest by construction)
The "1인 대체율" (one-person replacement rate) in `@sangfor/competency` counts a WorkAtom toward replacement **only** when it is all of: `auto_allowed` **and** `field_verified` **and** tool-covered **and** backed by real evidence. Optimistic-but-unproven capability does not count. This makes the number a floor, not a marketing figure.

## Priority products (MVP order)
1. HCI (HCI_SCP live-execution slice is the first mutation path)
2. IAG
3. Endpoint Secure
4. Cyber Command

FortiOS and Cisco IOS-XE are supported for **read-only advisory** only (via the shared spec/evaluate engine).

## Acceptance criteria (product-level)
- Every advisory and plan is **cited** and carries a risk classification.
- INDETERMINATE state is surfaced honestly, never rendered as PASS.
- Any live change is dry-run-previewed, gated, signed, verified by read-back, and evidenced.
- The replacement-rate metric reflects only verified automation.

## Out of scope (by design)
- Autonomous irreversible changes, autonomous rollback, and unattended production writes.
- Any capability that would require fabricating a value the system cannot source.

Detail: [FIELD_ENGINEER_CAPABILITY_VISION.md](../FIELD_ENGINEER_CAPABILITY_VISION.md), [PRODUCT-SENSE.md](../PRODUCT-SENSE.md).
