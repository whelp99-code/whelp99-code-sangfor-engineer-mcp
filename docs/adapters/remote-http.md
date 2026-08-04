# Remote HTTP adapter (standard MCP Streamable HTTP)

`apps/http-bridge` (`:3600`) exposes a standard MCP Streamable HTTP endpoint
at `POST /mcp`, in addition to its existing `GET /health` / `GET /tools` /
`POST /tools/call` REST façade for the AIOSv2 portal. Use `/mcp` for any
client that speaks plain MCP-over-HTTP instead of the bridge's bespoke REST
shape.

## Connect

```bash
curl -sS -X POST http://<host>:3600/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer '"$SANGFOR_API_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Every request must be `Content-Type: application/json` with a single
JSON-RPC 2.0 request object in the body. Only `initialize`, `tools/list`,
`tools/call`, `resources/list`, `resources/read`, `prompts/list`, and
`prompts/get` are proxied to the MCP server; any other method returns a
JSON-RPC `-32601` error. `GET`/`DELETE /mcp` return `405`.

## Stateless — no SSE, no session id

`/mcp` runs single-response mode only: one JSON-RPC request in, one JSON-RPC
response out, over a normal HTTP response — no Server-Sent Events stream and
no `Mcp-Session-Id` header is issued or required. This is a deliberate,
documented limitation, not a bug: it matches how the bridge already proxies
`/tools/call` (one request, spawn/reuse the stdio MCP child, one response)
and keeps the transport a single dependency-free `http.Server`. Clients that
require a persistent SSE stream or server-initiated notifications should use
the stdio transport (see `docs/adapters/cursor.md`, `claude-code.md`)
instead.

## Auth and safety — identical to the REST routes, not a parallel path

`/mcp` sits behind the exact same `checkAuth` Bearer-token gate as `/tools`
and `/tools/call` (open only when no `SANGFOR_API_TOKEN` is configured, and
`assertBindSafety` already refuses a non-loopback bind with no token at
startup). A `tools/call` sent through `/mcp` clears **the same**
`authorizeToolCall` gate as `POST /tools/call` — same destructive-always-
refuse rule, same non-loopback write refusal, same whitelist, same signed-
approval path — the code is called, not duplicated. A refused call gets the
same `403 { error }` shape either route returns; the id/method allowlist and
the guard are enforced before the call ever reaches the MCP server.

Remote writes still need `SANGFOR_ALLOW_REMOTE_WRITE=true` set on the bridge
(on top of a valid signed approval) — the same rule that already applies to
`/tools/call` on a non-loopback bind.
