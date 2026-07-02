# Cursor Implementation Prompt — High-Risk Scope Included

You are the senior full-stack engineer for `sangfor-engineer-mcp`.

The user has explicitly required the following capabilities to be included:

- Actual Sangfor customer device automation
- Actual production device change path
- Real PDF parsing and RAG indexing
- Real GitHub Wiki and Obsidian write support
- Fine-tuning data pipeline

Do not remove these capabilities. Implement and harden them.

## Mandatory safety requirements

1. All real console write actions must remain blocked unless:
   - `SANGFOR_ALLOW_REAL_EXECUTION=true`
   - `SANGFOR_OPERATOR_APPROVAL_SECRET` set (server-side HMAC key)
   - `approval.approvalToken` is a valid action-bound HMAC signature (over approvedBy/changeTicketId/rollbackPlanId/nonce/expiresAt + action type+target), unexpired, with an unused `nonce`
   - `approval.approvedBy`, `approval.changeTicketId`, `approval.rollbackPlanId`, `approval.nonce`, `approval.expiresAt` all exist
2. Production mode additionally requires:
   - `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true`
3. No password, OTP, MFA code, license key, customer secret, or private certificate may be stored.
4. Before/after screenshots must be written to `data/evidence/{sessionId}`.
5. Obsidian/GitHub Wiki writes must only apply approved proposals.
6. Fine-tuning dataset must be validated and scrubbed before job manifest creation.
7. RAG ingestion must support PDF, Markdown, TXT, HTML.
8. Cursor must keep `npm test`, `npm run lint`, and `npm run build` passing.

## Implementation focus

- Harden `packages/sangfor-operator/src/index.ts`
- Harden `packages/sangfor-rag/src/index.ts`
- Harden `packages/sangfor-wiki/src/index.ts`
- Harden `packages/sangfor-finetune/src/index.ts`
- Expand tests for live execution blocking, RAG ingestion, Obsidian write, fine-tuning validation
- Add production readiness checklist

## Do not do

- Do not make production execution default.
- Do not bypass approval gates.
- Do not add shell command tools exposed to MCP.
- Do not store credentials.
