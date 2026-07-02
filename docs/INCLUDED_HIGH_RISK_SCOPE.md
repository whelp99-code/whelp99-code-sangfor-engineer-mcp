# Included High-Risk Scope Policy

This project intentionally includes real-operation capabilities, but they are gated.

## Included capabilities

- Real Sangfor customer device automation via Playwright Web Console runner
- Production change execution path
- PDF/HTML/Markdown/TXT parsing and local RAG indexing
- GitHub Wiki writing through git-backed wiki repository
- Obsidian vault writing through filesystem adapter
- Fine-tuning dataset and job manifest generation

## Non-negotiable controls

Real customer or production execution is never the default. A non-dry-run live action requires:

1. `SANGFOR_ALLOW_REAL_EXECUTION=true`
2. For production mode: `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true`
3. `SANGFOR_OPERATOR_APPROVAL_TOKEN` set in runtime environment
4. Tool call approval payload containing:
   - `approvedBy`
   - `approvalToken`
   - `changeTicketId`
   - `rollbackPlanId`
5. Before/after screenshot evidence
6. A rollback plan reference
7. A change ticket reference
8. Over HTTP (http-bridge): destructive tools are always refused; write tools are refused on a non-loopback bind unless `SANGFOR_ALLOW_REMOTE_WRITE=true` (and a bearer token is mandatory on any non-loopback bind).

## Why this is included this way

The target use case is a Sangfor senior engineer assistant that can eventually perform customer and production work. Blocking the feature forever would make the system incomplete. Allowing it without gates would make it unsafe. This implementation includes the function but keeps the default runtime safe.
