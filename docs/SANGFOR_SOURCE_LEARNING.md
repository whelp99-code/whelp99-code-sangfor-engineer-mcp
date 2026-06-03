# Sangfor source learning pipeline

Collects public metadata and posts from:

| Source | URL | Access |
|--------|-----|--------|
| Knowledge (catalog) | https://knowledgebase.sangfor.com (`knowledge.sangfor.com` may 503; catalog JSON is on knowledgebase) | Public `category-navigation.json` |
| Knowledge (full body) | KB markdown API | Requires `SANGFOR_KB_TOKEN` (Bearer / `library_token` after login) |
| Community | https://community.sangfor.com | Public forum threads (rate-limited fetch) |

## Run

```bash
pnpm run learn:sources
```

With partner/login token for full KB articles:

```bash
export SANGFOR_KB_TOKEN='your-library-token'
export SANGFOR_KB_MAX_ARTICLES=50
export SANGFOR_COMMUNITY_MAX_THREADS=8
pnpm run learn:sources
```

## Outputs

- `data/sources/raw/*.md` — fetched documents with YAML frontmatter
- `data/sources/manifest.json` — collection manifest
- `data/rag/index.json` — RAG vector index (updated)
- `data/finetune/sangfor-sources.jsonl` — fine-tune examples for review

## Compliance

Respect Sangfor platform terms. Use only for authorized engineering assistants. Do not redistribute raw KB content outside approved scope. Community EULA applies to community.sangfor.com usage.
