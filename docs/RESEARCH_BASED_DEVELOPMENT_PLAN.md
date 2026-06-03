# Sangfor Engineer MCP - Research-Based Development Plan

## 0. Project Definition

Project name: `sangfor-engineer-mcp`

Goal: Build an independent MCP-based senior engineering assistant for Sangfor products. It should analyze Sangfor customer projects, search manuals/wiki knowledge, generate configuration plans, enforce approval gates, perform mock console dry-runs, verify results, generate evidence reports, and capture feedback into lessons/evals.

Product priority:

1. HCI
2. IAG
3. Endpoint Secure
4. Cyber Command

This project must remain separate from AIOS until the MCP contract, approval policy, evidence logging, and product-specific planner templates are validated.

---

## 1. Research-Based Design Decisions

### 1.1 MCP Server as the integration boundary

Use MCP-style tools as the external contract. The server exposes model-callable tools such as `sangfor.generate_config_plan`, `sangfor.request_approval`, and `sangfor.execute_console_action`.

MVP implementation uses a lightweight JSON-RPC stdio server compatible with the MCP interaction pattern. Full SDK hardening can be added after the code skeleton passes Cursor/Codex validation.

### 1.2 Tool output must be structured

Every MCP tool should return structured output, not just text. This is required for Cursor/Codex validation and later AIOS integration.

### 1.3 Human approval gates are mandatory

The following actions must never run automatically:

- Apply
- Save
- Delete
- Reboot
- Shutdown
- Failover
- Migration Start
- Production Cutover
- Policy Enable
- License Activate
- Password/OTP/MFA entry

Default console action mode is `dryRun=true`.

### 1.4 Playwright/accessibility-first console automation

The first console automation target is a Mock Sangfor Console. Later actual Sangfor Web Console automation should prioritize DOM/accessibility snapshots over raw pixel clicking.

### 1.5 Wiki + feedback learning before fine-tuning

Do not start with fine-tuning. The correct learning loop is:

Feedback -> Lesson Learned -> Wiki Update Proposal -> Approval -> Pattern/Eval Case -> Planner Regression.

### 1.6 MCP security hardening must be built from day one

No arbitrary shell execution. No secrets in logs. No real device write actions in MVP. No direct wiki write without approval. Tool input validation and audit logging must be added before production use.

---

## 2. Architecture

```text
sangfor-engineer-mcp/
├─ apps/
│  ├─ mcp-server              # MCP-style JSON-RPC stdio tool server
│  ├─ operator-console        # lightweight local operator console placeholder
│  └─ mock-sangfor-console    # local mock UI for product console workflow tests
├─ packages/
│  ├─ shared                  # product types, schemas, shared interfaces
│  ├─ sangfor-knowledge       # manual search / chunk retrieval
│  ├─ sangfor-wiki            # wiki search / proposal / approval / apply
│  ├─ sangfor-planner         # project analysis and config-plan generation
│  ├─ sangfor-approval        # risk classification and approval decision
│  ├─ sangfor-operator        # session, console state, action dry-run
│  ├─ sangfor-verifier        # result verification scaffold
│  ├─ sangfor-evidence        # markdown evidence report generation
│  ├─ sangfor-feedback        # feedback and lesson extraction
│  └─ sangfor-evals           # regression evals from product lessons
├─ prisma/                    # future persistence schema
├─ docs/                      # execution/review instructions
├─ scripts/
└─ tests/
```

---

## 3. MVP Scope

### Included

- Independent repo/project
- MCP-style stdio server
- `tools/list` and `tools/call`
- Product priority seed: HCI, IAG, Endpoint Secure, Cyber Command
- Mock manual search
- Mock wiki search
- Project analyzer
- Config plan generator
- Plan validator
- Approval/risk engine
- Mock operator session
- Console state read
- Dry-run console action
- Dangerous action blocking
- Evidence Markdown generator
- Feedback submit
- Lesson extractor
- Wiki update proposal
- Approval before wiki apply
- Feedback-based eval case
- Built-in planner evals
- Cursor/Codex instruction docs

### Excluded

- Real Sangfor equipment login or write actions
- Real customer equipment automation
- Password/OTP/MFA/license key storage
- Direct production Apply/Save/Delete/Reboot/Failover
- Full PDF parser/RAG pipeline
- Full GitHub/Notion wiki writer
- AIOS integration
- Fine-tuning

---

## 4. Product-Specific Planner Requirements

### 4.1 HCI

Required plan items:

- Node/cluster precheck
- Management network reachability
- Storage network isolation
- Interface mapping
- MTU consistency check
- DNS/NTP check
- License status check
- Storage pool validation
- VM migration/DR rollback plan
- Cluster/VM validation plan

### 4.2 IAG

Required plan items:

- User/group source check
- AD/LDAP/authentication integration precheck
- Current policy export before changes
- Admin/emergency bypass policy
- URL/application control policy draft
- Logging/audit verification
- Rollback policy

### 4.3 Endpoint Secure

Required plan items:

- Endpoint OS compatibility
- Agent deployment method
- Pilot group rollout
- EPP/EDR baseline policy
- Exception/whitelist process
- Update/version compatibility
- Agent health validation
- Rollback uninstall package

### 4.4 Cyber Command

Required plan items:

- Event source inventory
- Collector reachability
- NTP/time sync validation
- Alert/correlation rule mapping
- Dashboard/report validation
- Endpoint Secure/IAG integration readiness
- Incident response workflow

---

## 5. Development Tickets

### Ticket 1 - Project bootstrap

Goal: Prepare pnpm workspace, TypeScript config, folder structure, README, and scripts.

Acceptance:

- `pnpm install` works
- `pnpm lint` works
- `pnpm test` works

### Ticket 2 - MCP-style server

Goal: Implement JSON-RPC stdio server with `initialize`, `tools/list`, and `tools/call`.

Acceptance:

- `tools/list` returns all Sangfor tools
- Unknown tool returns protocol/tool error
- Tool outputs include structured JSON

### Ticket 3 - Product and knowledge seed

Goal: Add product priority and manual/wiki mock chunks.

Acceptance:

- HCI/IAG/Endpoint Secure/Cyber Command order is fixed
- Manual/wiki search returns product-specific chunks

### Ticket 4 - Planner

Goal: Project analyzer and product-specific config plan templates.

Acceptance:

- HCI plan includes MTU precheck
- IAG plan includes policy export
- Endpoint Secure plan includes pilot rollout
- Cyber Command plan includes NTP/time validation

### Ticket 5 - Approval engine

Goal: Risk classification and approval decisions.

Acceptance:

- Apply/Save/Delete/Reboot/Failover/Migration/License Activate require approval
- Read-only and planning actions do not require approval

### Ticket 6 - Mock operator

Goal: Mock session, console state read, dry-run action, high-risk action blocking.

Acceptance:

- `dryRun=true` action works
- dangerous `dryRun=false` action is blocked
- kill session works

### Ticket 7 - Feedback learning

Goal: Feedback -> lesson -> wiki proposal -> approval -> eval case.

Acceptance:

- Feedback is saved in memory
- Lesson is extracted
- Wiki proposal is pending by default
- Apply is blocked until approval
- Eval can be created and run

### Ticket 8 - Evidence report

Goal: Markdown evidence report from plan and verification result.

Acceptance:

- Report includes project, precheck, steps, rollback, validation, references, verification

---

## 6. Validation Commands

```bash
cd sangfor-engineer-mcp
pnpm install
pnpm test
pnpm lint
pnpm build
pnpm dev:mcp
```

MCP smoke test:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

HCI plan smoke test:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sangfor.generate_config_plan","arguments":{"customerName":"Test Customer","product":"HCI","environment":{"nodeCount":3},"requirements":["VMware migration"]}}}
```

Dangerous action test:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sangfor.request_approval","arguments":{"text":"Apply HCI network configuration and reboot node"}}}
```

---

## 7. AIOS Merge Conditions

Do not merge into AIOS until:

- MCP tool contract is stable
- All product templates pass evals
- Approval engine blocks dangerous actions
- Evidence report is generated consistently
- Mock console dry-run is stable
- Real device write actions are still disabled by default
- Cursor and Codex both pass review

---

# High-Risk Scope Inclusion Update

The user explicitly requires the following features to be included in the project scope:

- Actual Sangfor customer device automation
- Actual production device change path
- Real PDF parsing and RAG indexing
- Real GitHub Wiki and Obsidian write support
- Fine-tuning pipeline

## Updated architecture

These features are now included through controlled modules:

```text
packages/sangfor-operator     # live Playwright runner, customer/prod mode gates
packages/sangfor-rag          # PDF/HTML/MD/TXT ingestion and local vector search
packages/sangfor-wiki         # Obsidian vault and GitHub Wiki write adapters
packages/sangfor-finetune     # dataset and fine-tuning job manifest pipeline
```

## Updated MCP tools

```text
sangfor.ingest_document
sangfor.rag_search
sangfor.rag_index_summary
sangfor.read_live_console_state
sangfor.execute_console_action_live
sangfor.apply_obsidian_wiki_update
sangfor.apply_github_wiki_update
sangfor.create_finetune_dataset
sangfor.validate_finetune_dataset
sangfor.create_finetune_job_spec
```

## Safety gate

Real execution is included, but not open-ended. It requires explicit runtime flags and approval payload. Production mode additionally requires a production-specific flag.
