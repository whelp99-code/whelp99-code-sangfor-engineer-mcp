# Sangfor source learning pipeline

Collects metadata and posts from Knowledge, Community, and optionally full KB bodies via **ONE (Partner Portal)**.

**Running on your own PC:** see [LOCAL_SETUP.md](./LOCAL_SETUP.md).

| Source | URL | Access |
|--------|-----|--------|
| **ONE (recommended hub)** | https://one.sangfor.com | Partner login → `access_token_mh` |
| Knowledge (catalog) | https://knowledgebase.sangfor.com | Public `category-navigation.json` |
| Knowledge (full body) | KB markdown API | `SANGFOR_KB_TOKEN` or auto from ONE session |
| Community | https://community.sangfor.com | Public threads; SSO also via ONE |

`knowledge.sangfor.com` may return 503; use **knowledgebase.sangfor.com** (linked from ONE).

## ONE session setup (recommended)

1. Log in at https://one.sangfor.com
2. Open DevTools → Application → Local Storage → `access_token_mh`
3. Copy the value into `.env` (do **not** paste credentials in chat):

```bash
SANGFOR_ONE_ACCESS_TOKEN="<paste access_token_mh here>"
```

Verify:

```bash
pnpm run verify:one
```

Then run full learning:

```bash
pnpm run learn:sources
```

The pipeline will try to exchange the ONE token for a Knowledge Base `library_token` automatically.

## Run

```bash
pnpm run learn:sources
```

With partner/login token for full KB articles:

Copy `.env.example` to `.env` — scripts load it automatically (existing shell env wins).

```bash
export SANGFOR_KB_TOKEN='your-library-token'
export SANGFOR_KB_MAX_ARTICLES=all
export SANGFOR_COMMUNITY_MAX_THREADS=all
pnpm run learn:sources
```

MCP tool: `sangfor.learn_sources` (same pipeline; optional `communityMaxThreadsPerForum`, `knowledgeMaxArticles`, `includeDemoDocs`).

## Outputs

- `data/sources/raw/*.md` — fetched documents with YAML frontmatter
- `data/sources/manifest.json` — collection manifest
- `data/rag/index.json` — RAG vector index (updated)
- `data/finetune/sangfor-sources.jsonl` — fine-tune examples for review
- `data/demo-docs/*.md` — ingested when `SANGFOR_INCLUDE_DEMO_DOCS` is not `0`

## Compliance

Respect Sangfor platform terms. Use only for authorized engineering assistants. Do not redistribute raw KB content outside approved scope. Community EULA applies to community.sangfor.com usage.
