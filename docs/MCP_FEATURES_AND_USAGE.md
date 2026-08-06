# Sangfor Engineer MCP 기능 및 사용 가이드

기준: `feat/customer-ready-mcp-scorecard` (2026-07-31, 도구명 `sangfor_*` snake_case 전환 + 디스커버리 2종 추가)
MCP 표면: **96 tools = 읽기 47 + 로컬 쓰기/장비 읽기 42 + 파괴적 7** · mcp-scorecard **96/100 (grade A)**

이 문서는 현재 실행 코드의 `listTools()` 결과를 기준으로 작성한 사용자용 가이드다. 도구 이름·입력 스키마·안전 분류의 정본은 [MCP server registry](../apps/mcp-server/src/index.ts)이며, HTTP 동작의 정본은 [HTTP bridge](../apps/http-bridge/src/server.ts)와 [tool guard](../apps/http-bridge/src/tool-guard.ts)다.

## 1. 무엇을 할 수 있나

Sangfor Engineer MCP는 다음 업무를 하나의 MCP 서버에서 제공한다.

- HCI/SCP 인벤토리, 상태 진단, 볼륨 생성 계획·승인 실행·read-back 검증
- HCI, IAG, Endpoint Secure, Cyber Command 프로젝트 요구사항 분석과 설정 계획
- FortiOS 및 Cisco IOS-XE read-only 자문
- 매뉴얼·Wiki·로컬 RAG 검색과 문서 수집
- Excel 요구사항을 기반으로 설정/운영 가이드 DOCX·PPTX 생성
- Mock/Playwright 운영 세션, dry-run, 승인된 live action
- 설정 스펙 평가, RCA, sizing, 버전·통합 가이드, 대체율 계산
- PM engagement, 작업 항목, 장비 잠금, 감사 이벤트와 보고서
- 피드백→lesson→Wiki proposal→eval/fine-tune 데이터 흐름
- Learning Strategy 검색·관측 세션·암호화 capture·fact 수집·검증·승격
- Control Tower 플레이북 조립·실행·리포트·분석 (상세 절차: [PLAYBOOK_RUNBOOK.md](./PLAYBOOK_RUNBOOK.md))

현재 서버는 SDK transport가 아니라 newline-delimited JSON-RPC stdio를 직접 처리한다. 지원 메서드는 `initialize`, `tools/list`, `tools/call`이다. 응답은 text content와 원본 `structuredContent`를 함께 반환한다. 근거: [stdio handler](../apps/mcp-server/src/index.ts).

## 2. 빠른 시작

### 2.1 설치와 검증

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run db:generate
pnpm run smoke:mcp
```

기본 실행:

```bash
pnpm run dev:mcp
```

정상 기동 시 stderr에 다음 문구가 출력되고, stdin에서 JSON-RPC 한 줄씩 기다린다.

```text
sangfor-engineer-mcp stdio server started
```

### 2.2 Cursor 등 MCP client 연결

저장소의 [.cursor/mcp.json.example](../.cursor/mcp.json.example)을 복사하거나 다음처럼 절대 경로를 지정한다.

```json
{
  "mcpServers": {
    "sangfor-engineer": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/absolute/path/to/whelp99-code-sangfor-engineer-mcp",
        "run",
        "dev:mcp"
      ]
    }
  }
}
```

클라이언트를 재시작한 뒤 `sangfor_products` 또는 `sangfor_search_manuals`처럼 읽기 도구부터 확인한다.

### 2.3 JSON-RPC로 직접 확인

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-test","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sangfor_products","arguments":{}}}' \
  | pnpm run dev:mcp
```

도구 handler 오류는 대체로 JSON-RPC transport error가 아니라 `result.content[0].text`와 `isError:true`로 반환된다. 자동화에서는 HTTP 상태나 process exit만 보지 말고 `isError`와 `structuredContent`를 확인한다.

## 3. HTTP bridge 사용

HTTP bridge는 전용 제품 REST API가 아니라 MCP의 범용 프록시다. 제공 route는 다음 세 개뿐이다.

| Method | Route | 설명 |
|---|---|---|
| `GET` | `/health` | MCP child 연결 상태. 인증 없음 |
| `GET` | `/tools` | 96-tool schema/annotation 조회 |
| `POST` | `/tools/call` | `{name, arguments, approval?}` 호출 |

실행:

```bash
export SANGFOR_API_TOKEN='<strong-random-token>'
pnpm run dev:http-bridge
```

기본 주소는 `http://127.0.0.1:3600`이다. `PORT` 또는 `WHELP99_HTTP_BRIDGE_PORT`로 포트를 바꿀 수 있다.

```bash
curl http://127.0.0.1:3600/health

curl -H "Authorization: Bearer $SANGFOR_API_TOKEN" \
  http://127.0.0.1:3600/tools

curl -X POST http://127.0.0.1:3600/tools/call \
  -H "Authorization: Bearer $SANGFOR_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "sangfor_search_manuals",
    "arguments": {"product": "IAG", "version": "13.0.120", "query": "Web Authentication", "limit": 5}
  }'
```

비-loopback bind는 `SANGFOR_API_TOKEN`이 없으면 기동 단계에서 거부된다. 원격 write는 유효한 signed approval 외에도 `SANGFOR_ALLOW_REMOTE_WRITE=true`가 필요하다. `WHELP99_ENFORCE_SAFE_TOOLS=false`로 안전 allowlist를 끄는 방식은 운영 사용법으로 권장하거나 지원하지 않는다.

## 4. 안전 등급과 승인

| 등급 | 수 | 의미 |
|---|---:|---|
| 읽기 | 45 | annotation `readOnlyHint:true`; 원칙상 외부 상태를 변경하지 않음 |
| 쓰기 | 42 | 로컬 파일·세션·데이터셋 변경 또는 장비 read/capture를 동반함 |
| 파괴적 | 7 | 장비·외부 Wiki·실행 상태를 변경할 수 있음 |

실장비 non-dry-run write는 [Security](./SECURITY.md)의 모든 조건을 통과해야 한다.

```bash
export SANGFOR_ALLOW_REAL_EXECUTION=true
export SANGFOR_OPERATOR_APPROVAL_SECRET='<server-side-hmac-secret>'

# production session에서만 추가
export SANGFOR_ALLOW_PRODUCTION_EXECUTION=true
```

Signed approval 필드:

```json
{
  "approvedBy": "engineer@example",
  "approvalToken": "<hmac-sha256-hex>",
  "changeTicketId": "CHG-1234",
  "rollbackPlanId": "RB-1234",
  "nonce": "<single-use-random-value>",
  "expiresAt": "2026-07-30T12:00:00.000Z"
}
```

HCI approval 생성 예:

```bash
SANGFOR_OPERATOR_APPROVAL_SECRET='<secret>' \
pnpm exec tsx scripts/mint-hci-approval.ts \
  --type hci.create-volume \
  --target 127.0.0.1:demo-volume \
  --approvedBy engineer \
  --ticket CHG-1234 \
  --rollback RB-1234 \
  --ttlSec 300
```

승인은 action type과 exact target에 결합되고, 만료되며, nonce는 한 번만 소비된다. HCI write를 HTTP bridge로 호출하면 bridge용 approval과 tool argument의 HCI action approval이라는 두 게이트가 적용될 수 있다. Control Tower를 통하지 않고 직접 조합할 때는 [control-tower design approval flow](./superpowers/specs/2026-07-03-control-tower-design.md)를 먼저 확인한다.

### HTTP bridge에서 destructive tool의 실제 계약

이전 판에서 "SECURITY.md는 항상 거부라고 하는데 코드는 허용한다"고 적었던 불일치는
문서 쪽 오류였다. 코드와 테스트가 일치하는 계약은 다음과 같다
([tool guard](../apps/http-bridge/src/tool-guard.ts), `tests/http-bridge-approval-guard.test.ts`).

| 상황 | 결과 |
|---|---|
| annotation 누락 | 403 (fail closed) — approval로도 우회 불가 |
| destructive, approval 없음 | 무조건 거부. whitelist 토글·loopback bind 등 어떤 조건도 이를 완화하지 못한다 |
| destructive/write + 유효한 `{type:'bridge.tool-call', target:<tool 이름>}` approval | 그 1회에 한해 허용. Control Tower가 승인된 run을 실행하는 유일한 경로다 |
| write, non-loopback bind | `SANGFOR_ALLOW_REMOTE_WRITE=true` 없으면 유효한 approval이 있어도 거부 |

nonce는 모든 검사를 통과한 **마지막**에 소비되므로, 거부된 호출이 단일사용 승인을 태우지 않는다.

HCI destructive는 HTTP에서 **승인 2개**가 필요하다: bridge-level `bridge.tool-call` approval과
tool argument의 action-bound approval(`hci.delete-volume`). 여기에 non-loopback(실장비) target은
`SANGFOR_ALLOW_REAL_EXECUTION=true`와 `auto_allowed` 안전등급을 추가로 요구하는데,
`volume_create`/`volume_delete`는 M4 실장비 슬라이스까지 `human_only`이므로 **실장비에서는 여전히 거부된다**.

핵심 불변식:

- HTTP 2xx는 장비 변경 성공이 아니다. read-back `PASS`만 성공이다.
- `INDETERMINATE`는 PASS가 아니다.
- 실패 시 자동 rollback하지 않고 `FAILED_HALT` 후 사람에게 넘긴다.
- 비밀값은 persistence 전에 masking한다.
- 모호한 UI target, 누락된 service catalog, 손상된 nonce/ledger는 추측하지 않고 거부한다.

## 5. 대표 업무별 사용 예

### 5.1 매뉴얼 검색

```json
{
  "name": "sangfor_search_manuals",
  "arguments": {
    "product": "IAG",
    "version": "13.0.120",
    "query": "802.1X Access Control",
    "limit": 5
  }
}
```

검색 결과의 chunk id를 `sangfor_get_manual_section`에 전달해 본문을 조회한다.

### 5.2 고객 요구사항에서 설정 계획 생성

```json
{
  "name": "sangfor_analyze_project",
  "arguments": {
    "customerName": "Demo Customer",
    "product": "HCI",
    "version": "6.11",
    "projectType": "migration",
    "requirements": ["VMware workload migration", "3-node cluster"]
  }
}
```

분석 결과를 검토한 뒤 `sangfor_generate_config_plan`으로 계획을 생성하고, `sangfor_validate_config_plan`으로 precheck·rollback·validation·reference 존재 여부를 확인한다.

### 5.3 IAG 설정 진단

```json
{
  "name": "sangfor_evaluate_config",
  "arguments": {
    "product": "IAG",
    "version": "13.0.120",
    "observed": {
      "logRetentionDays": 180,
      "webAuthEnabled": true,
      "credentialWebAuthEnabled": true,
      "dot1xEnabled": false,
      "securityEventsCount": 0
    }
  }
}
```

관측하지 않은 값을 임의로 채우지 않는다. 누락된 항목은 `INDETERMINATE`로 남겨야 한다. 현재 generic `evaluate_config`는 모든 bare value의 provenance를 전역 강제하지 않으므로 호출자가 source와 observedAt을 별도 증거에 보존해야 한다.

### 5.4 FortiOS/Cisco read-only 자문

```json
{
  "name": "sangfor_advisor_fortios_advanced",
  "arguments": {
    "host": "https://firewall.example.invalid",
    "username": "<runtime-user>",
    "password": "<runtime-secret>",
    "specVersion": "7.4"
  }
}
```

FortiOS는 HTTP GET, Cisco IOS-XE는 RESTCONF GET만 사용한다. credential을 문서·로그·Git에 저장하지 않는다.

### 5.5 HCI volume 계획→실행→검증

1. `sangfor_hci_plan_create_volume`에 `name`, `sizeGb`를 전달한다.
2. 반환된 `clientToken`과 exact target으로 short-lived approval을 생성한다.
3. 승인된 환경에서만 `sangfor_hci_apply_create_volume`을 호출한다.
4. `sangfor_hci_verify_volume`으로 독립 read-back을 실행한다.
5. 결과가 `PASS`가 아니면 성공으로 기록하지 않는다.

Mock 기본 endpoint는 `http://127.0.0.1:3400/openstack/identity/v2.0`이다. 실장비는 `SANGFOR_HCI_IDENTITY_URL`, `SANGFOR_HCI_TENANT`, `SANGFOR_HCI_USER`, `SANGFOR_HCI_PASSWORD`를 환경변수로 제공한다.

### 5.6 Learning observer capture

기존 Chrome의 loopback CDP page에만 attach한다. 먼저 observer profile을 제공한다.

```bash
export SANGFOR_OBSERVER_PROFILES_JSON='[
  {
    "product":"IAG",
    "expectedOrigin":"https://iag.example.invalid",
    "cdpPort":9342,
    "firmwareTruthId":"<verified-truth-id>",
    "deviceScope":"<opaque-device-scope>"
  }
]'
```

호출 순서:

1. `sangfor_attach_observation_session`
2. `sangfor_manage_learning_capture` with `action:"start"`
3. passive observation
4. `sangfor_manage_learning_capture` with `action:"stop"` and `captureId`

최종 bundle은 `data/captures/*.enc`, staging은 `data/runtime/learning-captures`를 사용한다. credential·response body 원문을 bundle에 저장하는 용도가 아니다.

### 5.7 플레이북 협업 루프

Control Tower를 띄우면 기본 플레이북이 멱등하게 시드된다(장비 0대면 `타워 자체 점검` 1건,
등록 장비마다 `장비 정기 점검` 1건). rev 1은 `draft`이므로 UI에서 승인해야 실행된다.

```bash
export SANGFOR_API_TOKEN='<타워와 동일한 토큰>'
export SANGFOR_TOWER_URL=http://127.0.0.1:3700
pnpm run dev:control-tower     # 기동 로그: 기본 플레이북 시드: N건 생성
```

에이전트 쪽 호출 순서:

1. `sangfor_playbook_agent_tasks` — UI가 올린 `assemble`/`revise`/`analyze` 작업을 집는다
2. `sangfor_playbook_create` 또는 `sangfor_playbook_add_revision` — draft 제출
3. `sangfor_playbook_close_agent_task` — `{playbookId, note}` 기록 후 종료
4. (사람이 UI에서 rev 승인)
5. `sangfor_playbook_execute` → `sangfor_playbook_run_status`
6. `sangfor_playbook_submit_analysis` — 관찰·권고 제출, 사람이 UI에서 채택/기각

```json
{
  "name": "sangfor_playbook_create",
  "arguments": {
    "name": "FortiOS 정책 감사",
    "goal": "정책 감사 항목만 좁혀 확인",
    "authoredBy": "agent:claude",
    "blocks": [
      {"id": "audit", "type": "tool", "toolId": "sangfor_advisor_fortios", "deviceId": "<registry deviceId>", "args": {}},
      {"id": "rep", "type": "report"}
    ]
  }
}
```

블록 인자에는 앞 블록 결과를 `{{blocks.<blockId>.result.<dot.path>}}`로 끼울 수 있다.
리포트는 `outputs/playbooks/<playbookRunId>.md`에 쓰이고, FAIL 표와 함께
**미확인(INDETERMINATE) 항목**을 별도로 싣는다 — 근거가 없어 판정하지 못한 항목을
통과로 읽으면 안 된다.

## 6. 전체 98개 도구

표의 필수 입력은 top-level JSON Schema의 `required`만 표시한다. optional field와 enum은 `tools/list` 결과를 확인한다.

### 6.1 HCI/SCP — 6

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_hci_inventory` | 읽기 | - | volume/server/image 인벤토리 조회 |
| `sangfor_hci_health_report` | 읽기 | - | HCI 운영 상태 요약과 한국어 진단 보고서 |
| `sangfor_hci_plan_create_volume` | 읽기 | `name`, `sizeGb` | 입력 검증, client token, 승인 target 생성 |
| `sangfor_hci_apply_create_volume` | 쓰기 | `name`, `sizeGb`, `clientToken`, `approval` | idempotent create 후 read-back state machine 실행 |
| `sangfor_hci_verify_volume` | 읽기 | `name`, `sizeGb` | volume 기대값과 독립 read-back 비교 |
| `sangfor_hci_delete_volume` | 파괴적 | `volumeId`, `approval` | exact volume reverse operation |

### 6.2 제품·프로젝트·변경 계획 — 17

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_products` | 읽기 | - | 지원 제품 우선순위 조회 |
| `sangfor_discover_product_console` | 읽기 | - | 제품별 console/API/login/menu 전략 탐색 |
| `sangfor_collect_product_config` | 읽기 | - | API-first/WebUI-first read-only 설정 수집 또는 수집 계획 |
| `sangfor_analyze_customer_requirements` | 읽기 | `requirements` | 요구사항을 제품 설정 작업·위험·승인 gate로 분해 |
| `sangfor_generate_product_change_plan` | 쓰기 | `requirements` | 제품 변경 계획과 rollback/validation 생성 |
| `sangfor_import_excel_requirement_list` | 쓰기 | `filePath` | ITAC Excel 행을 요구사항으로 정규화 |
| `sangfor_map_requirements_to_products` | 읽기 | `rows` | Excel 요구사항을 제품 또는 수동 처리로 매핑 |
| `sangfor_generate_excel_based_change_plan` | 쓰기 | - | Excel 기반 multi-product dry-run 계획 생성 |
| `sangfor_dry_run_product_change` | 읽기 | `plan` | Save/Apply/Delete 직전까지 변경 preview |
| `sangfor_apply_approved_product_change` | 파괴적 | `plan` | 승인된 제품 변경 실행 |
| `sangfor_verify_product_change` | 읽기 | `plan` | 변경 후 read-only 재수집·증거 요구사항 검증 |
| `sangfor_analyze_project` | 읽기 | `customerName` | 프로젝트 위험·누락 입력·지식 query 분석 |
| `sangfor_generate_config_plan` | 쓰기 | `customerName`, `product` | precheck/step/rollback/validation 설정 계획 생성 |
| `sangfor_validate_config_plan` | 읽기 | - | plan 필수 구획과 reference 검증 |
| `sangfor_request_approval` | 쓰기 | `text` | 텍스트/행동 위험과 승인 필요성 분류 |
| `sangfor_verify_result` | 읽기 | - | 계획 결과의 수동 validation checklist 반환 |
| `sangfor_generate_evidence_report` | 쓰기 | - | Markdown 증적 보고서 생성 |

### 6.3 문서·보고서·스크린샷 — 10

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_generate_setting_guide_docx` | 쓰기 | `filePath` | Excel 기반 설정 가이드 DOCX |
| `sangfor_generate_setting_guide_pptx` | 쓰기 | `filePath` | Excel 기반 설정 가이드 PPTX |
| `sangfor_generate_operations_guide_pptx` | 쓰기 | - | 일/주/월 운영 가이드 PPTX |
| `sangfor_generate_operations_guide_docx` | 쓰기 | - | 운영·장애·보안 절차 DOCX |
| `sangfor_generate_comprehensive_setting_guide_docx` | 쓰기 | `filePath` | 상세 설정·복구·FAQ DOCX |
| `sangfor_generate_comprehensive_operations_guide_docx` | 쓰기 | - | 상세 운영·백업·성능·FAQ DOCX |
| `sangfor_capture_screenshots` | 쓰기 | `product` | Chrome CDP로 제품 화면 캡처 |
| `sangfor_generate_all_guides` | 쓰기 | `filePath` | 설정/운영 DOCX·PPTX 일괄 생성 |
| `sangfor_validate_office_document` | 읽기 | `filePath` | officecli로 .docx/.xlsx/.pptx OpenXML 스키마 사전 검증 |
| `sangfor_build_evidence_package` | 쓰기 | `title`, `customer`, `dateStamp`, `items` | 표지·요약표·항목별 증적 섹션을 officecli로 조립한 고객 제출용 증적 패키지 DOCX 생성 (`captureRunId` 지정 시 증적 무결성 섹션 포함) |

### 6.4 지식·RAG — 8

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_search_manuals` | 읽기 | `product` | 제품·버전·query로 manual chunk 검색 |
| `sangfor_get_manual_section` | 읽기 | `id` | manual chunk 단건 조회 |
| `sangfor_search_wiki` | 읽기 | `product` | 내부 Wiki chunk 검색 |
| `sangfor_ingest_document` | 쓰기 | `filePath`, `product` | PDF/HTML/Markdown/TXT chunking·indexing |
| `sangfor_rag_search` | 읽기 | `query` | 로컬 RAG index 검색 |
| `sangfor_rag_index_summary` | 읽기 | - | index 규모와 embedding 상태 요약 |
| `sangfor_store_health` | 읽기 | - | `DATABASE_URL`이 있을 때 Prisma/PostgreSQL 상태 확인 |
| `sangfor_learn_sources` | 쓰기 | - | KB/Community/demo docs 수집과 RAG·fine-tune 갱신 |

### 6.5 Operator session — 6

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_start_operator_session` | 쓰기 | `product` | mock/lab/poc/customer session 생성 |
| `sangfor_read_console_state` | 읽기 | `sessionId` | mock console state 조회 |
| `sangfor_execute_console_action` | 파괴적 | `sessionId`, `action` | mock action 실행 또는 dry-run |
| `sangfor_read_live_console_state` | 읽기 | `sessionId` | Playwright live console snapshot |
| `sangfor_execute_console_action_live` | 파괴적 | `sessionId`, `action` | 승인된 real Playwright action |
| `sangfor_kill_session` | 쓰기 | `sessionId` | operator session 취소 |

### 6.6 피드백·Wiki·eval·fine-tune — 12

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_submit_feedback` | 쓰기 | `product`, `feedbackType`, `severity`, `feedbackText`, `sourceRole` | 제품/plan/session 피드백 저장 |
| `sangfor_extract_lesson` | 쓰기 | `feedbackId` | 피드백에서 lesson 추출 |
| `sangfor_propose_wiki_update` | 쓰기 | `lessonTitle`, `lessonBody` | Wiki 변경 proposal 생성 |
| `sangfor_approve_wiki_update` | 쓰기 | `proposalId`, `decision` | proposal 승인 또는 거절 |
| `sangfor_apply_wiki_update` | 파괴적 | `proposalId` | 승인된 내부 Wiki 변경 적용 |
| `sangfor_apply_obsidian_wiki_update` | 파괴적 | `proposalId`, `vaultPath` | Obsidian vault 변경 적용 |
| `sangfor_apply_github_wiki_update` | 파괴적 | `proposalId`, `repoUrl` | GitHub Wiki repository 변경 적용 |
| `sangfor_create_eval_case_from_feedback` | 쓰기 | `product`, `name`, `requiredText` | planner regression case 생성 |
| `sangfor_create_finetune_dataset` | 쓰기 | `product`, `taskType`, `examples` | 검토된 example을 JSONL로 생성 |
| `sangfor_validate_finetune_dataset` | 읽기 | `path` | dataset 구조·민감정보 검사 |
| `sangfor_create_finetune_job_spec` | 쓰기 | `datasetPath`, `product`, `taskType` | 제출하지 않는 job manifest 생성 |
| `sangfor_run_planner_eval` | 쓰기 | - | built-in planner eval 실행 |

### 6.7 진단·자문 — 13

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_evaluate_config` | 읽기 | `observed` | IntendedSpec과 관측값 비교, 한국어 advisory 생성 |
| `sangfor_list_spec_coverage` | 읽기 | - | 지원 product/version spec 조회 |
| `sangfor_advisor_fortios` | 읽기 | `host`, `username`, `password` | FortiOS 정책·interface·routing GET 진단 |
| `sangfor_advisor_fortios_advanced` | 읽기 | `host`, `username`, `password` | FortiOS health·HA·policy·IPS 심화 진단 |
| `sangfor_advisor_cisco_iosxe` | 읽기 | `host`, `username`, `password` | IOS-XE interface·routing·ACL RESTCONF 진단 |
| `sangfor_advisor_cisco_iosxe_advanced` | 읽기 | `host`, `username`, `password` | IOS-XE CPU·memory·VRF·policy 심화 진단 |
| `sangfor_collect_device_config` | 읽기 | `product`, `version`, `poolPath` | captured XHR pool을 ConfigState와 advisory로 변환 |
| `sangfor_capability_safety` | 읽기 | - | capability safety class·maturity 확인 |
| `sangfor_field_engineer_coverage` | 읽기 | - | automatable + field_verified 대체율 계산 |
| `sangfor_suggest_rca` | 읽기 | `symptom` | manual-grounded RCA 후보와 점검 단계 |
| `sangfor_recommend_sizing` | 읽기 | `product` | scale driver 기반 tier 추천, exact BOM은 사람에게 위임 |
| `sangfor_integration_guide` | 읽기 | - | AD/LDAP, RADIUS, SIEM/syslog 통합 절차 |
| `sangfor_check_version` | 읽기 | - | min/recommended version 요구사항 자문 |

### 6.8 PM·장비 점유 — 7

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_pm_create_engagement` | 쓰기 | `customer`, `product` | 고객 engagement 생성 |
| `sangfor_pm_add_work_item` | 쓰기 | `engagementId`, `title` | 작업 항목 추가 |
| `sangfor_pm_status` | 읽기 | `engagementId` | 진행률과 장비 점유 요약 |
| `sangfor_pm_events` | 읽기 | `engagementId` | hash-chain event timeline 조회 |
| `sangfor_pm_report` | 읽기 | `engagementId` | 기록된 event 기반 한국어 보고서 |
| `sangfor_pm_acquire_device` | 쓰기 | `deviceId`, `engagementId`, `holder` | engagement별 exclusive 장비 lock 획득 |
| `sangfor_pm_release_device` | 쓰기 | `deviceId`, `engagementId` | 장비 lock 해제와 audit event 기록 |

### 6.9 Learning Strategy Observer — 8

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_list_learning_strategies` | 읽기 | - | strategy revision filter·pagination |
| `sangfor_resolve_learning_strategy` | 읽기 | `scope`, `context` | exact strategy 또는 miss/canary/drift/ambiguity 반환 |
| `sangfor_attach_observation_session` | 쓰기 | `product`, `expectedOrigin`, `cdpPort`, `firmwareTruthId` | profile registry의 exact loopback CDP page attach |
| `sangfor_manage_learning_capture` | 쓰기 | `action` | passive capture 시작/종료와 encrypted bundle 승격 |
| `sangfor_collect_facts` | 쓰기 | `scope`, `context`, `factIds` | complete/partial/conflict/unavailable fact 수집 |
| `sangfor_research_learning_strategy` | 쓰기 | `strategyId`, `vendor`, `scope`, `registryDigest`, `versionTruthRecord`, `officialCitation`, `pageVerified` | 공식 출처 기반 immutable draft 생성 |
| `sangfor_validate_learning_strategy` | 쓰기 | `strategyId`, `revisionId` | evidence와 다음 lifecycle state 검증 |
| `sangfor_promote_learning_strategy` | 쓰기 | `strategyId`, `revisionId`, `toState`, `approvalPayload`, `approvalToken`, `evidenceRoot` | 서명·nonce 기반 immutable revision 승격 |

### 6.10 플레이북 (Control Tower 프록시) — 9

이 9개는 자체 로직이 아니라 Control Tower(`:3700`) REST API를 프록시한다. 플레이북 상태의
기록자는 타워 하나이므로 다른 프로세스가 `data/registry/playbooks.json`을 직접 쓰면 안 된다.
타워 주소는 `SANGFOR_TOWER_URL`(기본 `http://127.0.0.1:3700`), 인증은 `SANGFOR_API_TOKEN`이다.
타워가 떠 있지 않으면 예외가 아니라 실행 힌트를 담은 `{error, towerUrl, hint}`를 반환한다.

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_playbook_list` | 읽기 | - | 목록 + 활성 rev + 최근 실행 상태 |
| `sangfor_playbook_get` | 읽기 | `playbookId` | 리비전·블록 전체 |
| `sangfor_playbook_run_status` | 읽기 | `playbookRunId` | 유도 상태 + 블록별 runId + 제출된 분석 |
| `sangfor_playbook_agent_tasks` | 읽기 | - | `open` 작업 큐 조회 (일감 수령) |
| `sangfor_playbook_create` | 쓰기 | `name`, `goal`, `authoredBy`, `blocks` | draft rev 1 생성 |
| `sangfor_playbook_add_revision` | 쓰기 | `playbookId`, `authoredBy`, `blocks` | 수정 루프 — 새 draft rev 추가 |
| `sangfor_playbook_execute` | 쓰기 | `playbookId` | 승인된 활성 rev 실행 |
| `sangfor_playbook_submit_analysis` | 쓰기 | `playbookRunId`, `playbookId`, `summary`, `authoredBy` | append-only 분석(개선·제안) 제출 |
| `sangfor_playbook_close_agent_task` | 쓰기 | `taskId` | 작업을 done으로 닫고 산출물 기록 |

의도된 경계:

- **리비전 승인/반려는 MCP에 없다.** 승인은 타워 UI에서 사람이 한다. 도구가 승인을 대신하지 않는다.
- `playbook_execute`는 장비를 직접 바꾸지 않는다. 읽기 블록은 즉시 실행되고, 첫 write/destructive
  블록에서 `pending_approval` run을 만들고 멈춘다. 재개는 사람의 승인 이후다.
- 블록의 `toolId`로 `sangfor_playbook_*`를 쓰면 400이다. 플레이북 중첩 실행은 설계 비범위다.

### 6.11 디스커버리 (agent self-onboarding) — 2

에이전트가 서버를 스스로 탐색하는 읽기 전용 도구다. MCP 리소스(`sangfor://agent-manifest`,
`sangfor://capabilities`, `sangfor://safety/posture`)로도 같은 내용을 구독할 수 있다.

| Tool | 등급 | 필수 입력 | 기능 |
|---|---|---|---|
| `sangfor_agent_manifest` | 읽기 | - | 추천 첫 호출 + 표준 도구 그룹 + 안전 posture |
| `sangfor_capabilities` | 읽기 | - | 카테고리별 도구 수, 벤더/제품, 실행 posture, 게이트 |

## 7. 환경변수 요약

전체 목록과 빈 template은 [.env.example](../.env.example)을 사용한다.

| 목적 | 주요 변수 |
|---|---|
| HTTP | `SANGFOR_API_TOKEN`, `PORT`, `WHELP99_HTTP_BRIDGE_PORT`, `SANGFOR_ALLOW_REMOTE_WRITE` |
| 실실행 | `SANGFOR_ALLOW_REAL_EXECUTION`, `SANGFOR_ALLOW_PRODUCTION_EXECUTION`, `SANGFOR_OPERATOR_APPROVAL_SECRET`, `SANGFOR_NONCE_STORE_PATH` |
| HCI | `SANGFOR_HCI_IDENTITY_URL`, `SANGFOR_HCI_TENANT`, `SANGFOR_HCI_USER`, `SANGFOR_HCI_PASSWORD` |
| Observer | `SANGFOR_OBSERVER_PROFILES_JSON`, `SANGFOR_CAPTURE_ROOT`, `SANGFOR_CAPTURE_STAGING_ROOT` |
| 장비 수집 | `SANGFOR_EPP_URL/PASSWORD`, `SANGFOR_IAG_URL/PASSWORD`, `SANGFOR_CC_URL/PASSWORD`, `SANGFOR_DEVICE_SCOPE` |
| Knowledge | `SANGFOR_ONE_ACCESS_TOKEN`, `SANGFOR_KB_TOKEN`, `SANGFOR_RAG_INDEX_PATH` |
| Embedding | `SANGFOR_EMBEDDING_PROVIDER`, `SANGFOR_LITELLM_*`, `SANGFOR_RAPID_MLX_*`, `SANGFOR_ALLOW_CLOUD_RAG` |
| Persistence | `DATABASE_URL`, `SANGFOR_RUNS_ROOT`, `SANGFOR_FEEDBACK_ROOT`, `SANGFOR_EVALS_ROOT`, `SANGFOR_WIKI_ROOT` |
| Audit | `SANGFOR_CHANGE_LEDGER_SECRET`, `SANGFOR_PM_CHAIN_SECRET`, `SANGFOR_WIKI_APPROVAL_SECRET` |
| 플레이북 | `SANGFOR_TOWER_URL`, `SANGFOR_REGISTRY_ROOT`, `SANGFOR_TOWER_SEED_PLAYBOOKS`(`0`=기동 시 시드 해제) |

실제 secret은 `.env` 또는 process environment에서만 주입하고 MCP argument, shell history, 보고서, Git에 넣지 않는다.

## 8. 운영 점검

```bash
pnpm run smoke:mcp          # 96 tools
pnpm run check:mcp-scorecard
pnpm run lint
pnpm run build
pnpm test
```

`pnpm test`는 추적된 PPTX를 재생성할 수 있으므로 dirty checkout이 아니라 clean task-owned worktree에서 실행한다.

관련 문서:

- [Architecture](../ARCHITECTURE.md)
- [Security](./SECURITY.md)
- [Reliability](./RELIABILITY.md)
- [Local setup](./LOCAL_SETUP.md)
- [Device diagnosis runbook](./DEVICE_DIAGNOSIS_RUNBOOK.md)
- [Learning observer runbook](./LEARNING_STRATEGY_OBSERVER_RUNBOOK.md)
- [현재 전체 계획·미완료 범위](./superpowers/2026-07-29-full-plan-review-checklist.md)

## 9. 현재 알려진 경계

- 범용 HTTP bridge는 존재하지만 `/api/v1/...` 전용 REST/OpenAPI는 아직 없다.
- 일부 Learning Method는 synthetic/fixture 또는 미연결 상태다. tool 존재가 실장비 maturity 완료를 의미하지 않는다.
- CC/IAG/FortiOS/cinder/PostgreSQL pilot는 현재 evidence가 없으면 `BLOCKED` 또는 `NOT_RUN`이다.
- generic `evaluate_config`의 전역 provenance 강제는 추가 hardening 대상이다.
- 실제 장비 write는 환경 flag만으로 열리지 않는다. action-bound approval, nonce, safety class, read-back이 모두 필요하다.
- 플레이북은 선형 순차 실행만 지원한다. 조건 분기·병렬·루프 블록, 스케줄 실행, 플레이북 중첩 호출은 설계 비범위다.
- 타워는 LLM을 내장하지 않는다. 조립·분석은 외부 에이전트가 하고, **에이전트 작업 큐를 자동으로 폴링하는 상주 데몬도 비범위다** — 폴링 주체는 에이전트다.
- HCI `volume_create`/`volume_delete`는 `human_only` 안전등급이므로 실장비 실행이 거부된다. M4 실장비 슬라이스의 증거 확보 후에만 승격된다.

