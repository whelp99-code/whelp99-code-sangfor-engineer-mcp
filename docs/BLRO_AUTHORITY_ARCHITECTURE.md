# BLRO Authority Architecture

Status: future target; not implemented by the current JM-local increment.

## Ownership decision

- **JM is the client/browser execution edge.** It owns local Playwright/CDP
  processes, local profiles, login interaction, transient credentials, and
  execution of JSON-serializable browser requests.
- **BLRO is the server/data authority.** The future integrated BLRO owns
  authoritative MCP registration, RAG, databases, approval decisions, nonce
  state, audit ledgers, evidence metadata, tenant/project/provenance identity,
  ACL enforcement, and final verification verdicts.
- The current modular monolith keeps these roles in-process for delivery
  efficiency. It does **not** introduce a remote JM/BLRO protocol.

## Current seam

`BrowserExecutionPort` is the extraction seam:

1. Policy packages emit strict JSON requests.
2. The JM implementation performs local browser work.
3. Results return strict JSON, opaque artifact references, masked
   observations, mutation-attempt state, and independent read-back state.
4. Only `PASS` plus read-back `PASS` is authoritative success.

No Playwright `Browser`, `Context`, `Page`, CDP socket, filesystem path, or
credential crosses the contract.

## Future extraction constraints

A future remote transport may replace only the in-process port binding. It
must preserve:

- complete-action approval binding;
- single-use nonce ordering immediately before mutation;
- exact tenant/project/device/session/origin identity;
- opaque artifact transfer and BLRO-side durable persistence;
- append-only audit/provenance records;
- fail-closed timeout, replay, disconnect, and partial-result behavior;
- `INDETERMINATE` for any mutation without authoritative read-back.

The transport must not create per-project MCP/RAG/database silos. One BLRO
platform remains authoritative, with tenant/project/provenance/ACL isolation.

## Canonical design

The detailed topology, extraction phases, and trust boundaries are maintained
in [Unified BLRO Platform](design-docs/unified-blro-platform.md).
