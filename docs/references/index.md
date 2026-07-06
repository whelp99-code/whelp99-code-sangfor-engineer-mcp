# External References

LLM-formatted reference docs for heavily-relied-on external dependencies go here as `{library}-llms.txt`. None are generated yet — this index lists the candidates worth capturing, highest-value first.

| Dependency | Used by | Why a reference would help |
|---|---|---|
| `@modelcontextprotocol/sdk` | `apps/mcp-server`, `http-bridge` | Tool/JSON-RPC contract, annotations (`destructiveHint`, `readOnlyHint`) that drive `tool-guard` authorization. Note: the stdio server is hand-rolled over readline, not the SDK transport. |
| `playwright` | `@sangfor/chrome`, `operator`, login/crawl scripts | `connectOverCDP`, locator strictness (0/>1 match → throw), screenshot capture — the browser-automation contract. |
| `@prisma/client` / `prisma` | `@sangfor/store`, `scripts/sync-db.ts` | Optional Postgres bridge; client generation, migration commands. See [../generated/db-schema.md](../generated/db-schema.md). |
| `zod` | schema validation across packages | Input validation patterns. |
| `pdf-parse` | `@sangfor/rag` | PDF text extraction for ingestion. |
| PptxGenJS | `@sangfor/pptx` | Slide generation for setting/ops guides. |

To add one: prefer Context7 (`resolve-library-id` → `query-docs`) or the library's own llms.txt, then trim to the API surface and gotchas this repo actually uses.
