# Sangfor Engineer MCP 개발 계획서

## 1. 기능 요약

`Sangfor Engineer MCP`는 Sangfor 제품 전용 시니어 엔지니어 MCP 서버다. 범용 자동 클릭기가 아니라 HCI, IAG, Endpoint Secure, Cyber Command의 매뉴얼/위키/피드백을 기반으로 고객 프로젝트를 분석하고 구성 계획, 승인, dry-run 콘솔 조작, 검증, 증적 보고서를 제공한다.

## 2. 현재 구조 영향도

AIOS와 분리된 독립 프로젝트로 개발한다. 안정화 후 AIOS에서 MCP Client로 연결한다. AIOS 본체에는 아직 DB/권한/콘솔 조작 로직을 넣지 않는다.

## 3. 추천 아키텍처

```text
AIOS/Cursor/Codex MCP Client
  -> sangfor-engineer-mcp
     -> knowledge/manual search
     -> wiki search
     -> project analyzer
     -> config planner
     -> approval engine
     -> mock console operator
     -> verifier
     -> evidence report
     -> feedback learning loop
```

MVP는 MCP stdio 서버 + mock data + mock console + dry-run 액션으로 구현한다.

## 4. 파일/폴더 변경 목록

```text
apps/mcp-server
apps/operator-console
apps/mock-sangfor-console
packages/shared
packages/sangfor-knowledge
packages/sangfor-wiki
packages/sangfor-planner
packages/sangfor-approval
packages/sangfor-operator
packages/sangfor-verifier
packages/sangfor-evidence
packages/sangfor-feedback
packages/sangfor-evals
prisma
docs
tests
scripts
```

## 5. DB 변경 사항

MVP는 in-memory로 동작한다. Prisma schema에는 향후 DB 반영을 위한 테이블 초안을 포함했다.

- SangforProduct
- SangforManual
- SangforProject
- SangforConfigPlan
- SangforFeedbackEvent
- SangforWikiUpdateProposal

## 6. API/MCP 변경 사항

주요 MCP tools:

- sangfor.products
- sangfor.search_manuals
- sangfor.get_manual_section
- sangfor.search_wiki
- sangfor.analyze_project
- sangfor.generate_config_plan
- sangfor.validate_config_plan
- sangfor.request_approval
- sangfor.start_operator_session
- sangfor.read_console_state
- sangfor.execute_console_action
- sangfor.kill_session
- sangfor.verify_result
- sangfor.generate_evidence_report
- sangfor.submit_feedback
- sangfor.extract_lesson
- sangfor.propose_wiki_update
- sangfor.approve_wiki_update
- sangfor.apply_wiki_update
- sangfor.create_eval_case_from_feedback
- sangfor.run_planner_eval

## 7. UI 변경 사항

MVP `operator-console`는 placeholder다. 다음 단계에서 아래 화면을 추가한다.

- /manuals
- /projects
- /plans
- /sessions
- /approvals
- /feedback
- /wiki-review
- /evals

## 8. Cursor 실행 프롬프트

```text
너는 이 저장소의 시니어 풀스택 엔지니어다.
현재 sangfor-engineer-mcp MVP 코드를 검토하고 다음을 진행한다.
1. pnpm install, pnpm test, pnpm lint, pnpm build 실행
2. TypeScript import 경로와 workspace 설정을 정상화
3. MCP server가 tools/list, tools/call을 정상 처리하는지 확인
4. HCI/IAG/Endpoint Secure/Cyber Command 제품 우선순위가 모든 seed, planner, eval에 반영되어 있는지 확인
5. 위험 작업 apply/save/delete/reboot/failover/migration/license activate는 approval_required 또는 blocked 상태가 되도록 수정
6. mock console은 실제 장비 연결 없이 dry-run만 수행하도록 유지
7. operator-console은 최소 UI로 manuals/projects/plans/sessions/feedback/wiki-review 화면을 추가
8. 테스트 누락 시 vitest 테스트를 추가
```

## 9. Codex 리뷰 프롬프트

```text
너는 MCP, Sangfor 구축 자동화, 보안 자동화 관점의 시니어 리뷰어다.
리뷰 대상은 sangfor-engineer-mcp MVP다.
검토 항목:
- MCP tools/list, tools/call 호환성
- 제품 우선순위: HCI, IAG, Endpoint Secure, Cyber Command
- 위험 작업 승인 차단
- dryRun=false 위험 작업 차단
- 위키 apply 전 승인 차단
- config plan에 precheck/steps/rollback/validation/reference 포함 여부
- feedback -> lesson -> wiki proposal -> eval case 구조
- 실제 고객 장비 연결 코드가 없는지
- 비밀번호/OTP/MFA/license key 저장 코드가 없는지
- pnpm test/lint/build 결과
```

## 10. 테스트 방법

```bash
pnpm install
pnpm test
pnpm lint
pnpm build
pnpm dev:mcp
pnpm dev:mock-console
```

MCP 테스트 예시:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sangfor.generate_config_plan","arguments":{"customerName":"Test","product":"HCI","environment":{"nodeCount":3},"requirements":["VMware migration"]}}}
```

## 11. 완료 조건

- MCP server 실행 가능
- tools/list 정상
- HCI config plan 생성 가능
- IAG/Endpoint Secure/Cyber Command plan 생성 가능
- 승인 정책 작동
- mock console dry-run 가능
- 위험 작업 자동 차단
- feedback/lesson/wiki proposal/eval 동작
- evidence markdown 생성 가능
- 테스트 통과

## 12. 다음 작업 티켓

1. 공식 MCP SDK 기반 서버로 전환 또는 현 stdio MCP 호환 레이어 보강
2. Markdown/GitHub Wiki Adapter 실제 구현
3. PDF/HTML 매뉴얼 업로드 및 chunking 구현
4. HCI planner template 고도화
5. IAG planner template 고도화
6. Endpoint Secure planner template 고도화
7. Cyber Command planner template 고도화
8. Playwright 기반 mock console snapshot/action 구현
9. Operator Console UI 확장
10. AIOS MCP client 병합 계약서 작성
