# JM Browser Migration Gaps

Status: current JM modular-monolith implementation is complete; these are the
known gaps before a physical JM/BLRO separation.

## Deliberately deferred

1. **Remote transport:** no JM enrollment, remote job queue, polling,
   streaming, or remote artifact upload protocol exists.
2. **BLRO identity:** tenant/project/device/provenance/ACL claims are not yet
   carried through a signed remote envelope.
3. **Remote approval dispatch:** approvals remain in the current process
   boundary; BLRO has not yet become the network authority.
4. **Durable remote evidence:** browser artifacts remain local until explicitly
   materialized; BLRO object storage and metadata persistence are future work.
5. **Disconnect recovery:** no remote lease/heartbeat/reconnect state machine
   exists because execution is in-process.
6. **Fleet operations:** no multi-JM registration, capability inventory,
   scheduling, version negotiation, or revocation mechanism exists.

## Extraction prerequisites

- Freeze `BrowserExecutionPort` request/result versioning.
- Define signed, action-bound job envelopes and replay protection.
- Define BLRO-issued session/device/origin bindings.
- Define encrypted credential delivery that never persists on JM.
- Define chunked opaque artifact upload with hash verification.
- Define authoritative BLRO audit and read-back persistence.
- Exercise disconnect, duplicate delivery, stale approval, and partial-upload
  failure paths before enabling remote mutation.

## Current compatibility promise

Policy packages depend only on strict JSON browser contracts. Replacing the
in-process local port with a remote adapter must not change MCP tool names,
approval semantics, nonce order, origin locking, artifact opacity, or the rule
that a mutation without independent read-back is `INDETERMINATE`.

Human prerequisites and current safe QA commands are documented in
[JM Browser User Intervention](USER_INTERVENTION_JM_BROWSER.md). The target
authority model is documented in
[BLRO Authority Architecture](BLRO_AUTHORITY_ARCHITECTURE.md).
