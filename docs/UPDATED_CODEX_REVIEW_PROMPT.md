# Codex Review Prompt — Sangfor Engineer MCP High-Risk Scope

You are a security-focused senior reviewer. Review `sangfor-engineer-mcp` with special attention to the newly included high-risk features.

## Required review commands

```bash
npm install
npm test
npm run lint
npm run build
```

## Review areas

1. Real Sangfor device execution
   - Confirm non-dry-run live execution is blocked without `SANGFOR_ALLOW_REAL_EXECUTION=true`.
   - Confirm production execution is blocked without `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true`.
   - Confirm approval token, approver, change ticket, and rollback plan are required.
   - Confirm no credentials are stored.

2. PDF/RAG
   - Confirm PDF/Markdown/TXT/HTML ingestion exists.
   - Confirm chunks are indexed in local vector index.
   - Confirm search works by product/version/query.
   - Confirm ingestion handles duplicate chunks.

3. GitHub Wiki / Obsidian
   - Confirm wiki updates are proposal-based.
   - Confirm apply is blocked before approval.
   - Confirm Obsidian writes to a local vault path.
   - Confirm GitHub Wiki uses a git-backed wiki repo and does not hardcode tokens.

4. Fine-tuning
   - Confirm JSONL dataset generation exists.
   - Confirm dataset validation checks structure and obvious sensitive information.
   - Confirm job manifest creation does not auto-submit to any provider.

5. MCP surface
   - Confirm new tools are listed:
     - `sangfor.ingest_document`
     - `sangfor.rag_search`
     - `sangfor.rag_index_summary`
     - `sangfor.read_live_console_state`
     - `sangfor.execute_console_action_live`
     - `sangfor.apply_obsidian_wiki_update`
     - `sangfor.apply_github_wiki_update`
     - `sangfor.create_finetune_dataset`
     - `sangfor.validate_finetune_dataset`
     - `sangfor.create_finetune_job_spec`

## Reject criteria

Reject if any of these are true:

- Production write can run without explicit env flags and approval payload.
- Approval token is not checked.
- Password/OTP/MFA/license key is stored.
- Wiki proposal can be applied before approval.
- Fine-tune dataset can include obvious secrets without failing validation.
- Tests do not cover at least RAG ingestion, Obsidian write, fine-tune dataset, and approval blocking.
