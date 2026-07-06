<!-- Parent: ../../AGENTS.md -->

# mock-sangfor-console

> Fake vendor device/console (`:3400`) — Sangfor HCI/IAG + FortiOS + Cisco IOS-XE + OpenStack — so read/write tools can be exercised without real hardware.

## Constraints
- Entry: `src/server.ts` (port 3400, `PORT`). Guarded by `MOCK_NO_SERVE`/`VITEST`.
- **Fully self-contained: no internal package imports.** Only local modules (`openstack.ts`, `fortios.ts`, `cisco-iosxe.ts`, `vendor-paths.ts`). Keep it dependency-free so tests and clients can point at it freely.
- It emulates vendor API shapes: `/api/v1/fortios/*`, `/api/v1/cisco-iosxe/*`, OpenStack identity/volume, plus a `VENDOR_PATH_RESPONSES` alias table for advisor paths, and `GET /state`.
- The mock must mirror **real vendor semantics** that the safety spine depends on — e.g. a quota-exceeded write returns 202 with no effect (so read-back correctly FAILs). Don't "make the mock pass" by fabricating success.

## Working here
- Adding a vendor endpoint: add the handler here alongside the vendor's spec + client package and the MCP tool (see [docs/MULTIVENDOR.md](../../docs/MULTIVENDOR.md)).
- Run: `pnpm run dev:mock-console` → http://localhost:3400.

## Dependencies
- Depends on: nothing internal.
- Depended on by: control-tower (health widget), HCI/vendor tests and clients (via `SANGFOR_HCI_IDENTITY_URL` default `127.0.0.1:3400/...`).

<!-- MANUAL: Notes below this line are preserved on regeneration -->
