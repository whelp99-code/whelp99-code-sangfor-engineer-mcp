<!-- Parent: ../../AGENTS.md -->

# http-bridge

> REST façade (`:3600`) wrapping the stdio MCP server so an external portal (AIOSv2) can call tools over HTTP — with a fail-closed authorizer.

## Constraints
- Entry: `src/server.ts`. Binds port 3600 (`PORT`/`WHELP99_HTTP_BRIDGE_PORT`) through `assertBindSafety` (non-loopback bind **requires** `SANGFOR_API_TOKEN`). It `spawn`s the MCP server and pipes JSON-RPC over its stdio.
- `@sangfor/operator`'s `tool-authorization.ts` is the shared security policy used by this adapter — **the second, independent execution gate**. It refuses tools with missing annotations (403), refuses `destructiveHint` tools without a valid single-use approval, refuses write tools on a non-loopback bind unless `SANGFOR_ALLOW_REMOTE_WRITE`, verifies the complete-action HMAC `SignedApproval`, and consumes the nonce **last**. Do not relax any of these.
- Routes: `GET /health`, `GET /tools`, `POST /tools/call {name, arguments, approval?}`.

## Working here
- Any change to `packages/sangfor-operator/src/tool-authorization.ts` needs a refusal test — see `tests/http-bridge-guard.test.ts`, `http-bridge-authorize.test.ts`, `http-bridge-approval-guard.test.ts`.
- Run: `pnpm run dev:http-bridge`.

## Dependencies
- Depends on: `@sangfor/shared` (bind safety, auth), `@sangfor/operator` (tool authorization and approval verification), and the MCP server child process.
- Depended on by: `apps/control-tower` (calls it over HTTP).

<!-- MANUAL: Notes below this line are preserved on regeneration -->
