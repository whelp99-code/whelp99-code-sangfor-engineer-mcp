# Cursor Implementation Prompt

너는 이 저장소의 시니어 풀스택 엔지니어다.

대상 프로젝트: `sangfor-engineer-mcp`

목표:
Sangfor 제품 전용 시니어 엔지니어 MCP 서버 MVP를 실제 실행 가능한 상태로 검증하고 개선한다.

제품 우선순위:
1. HCI
2. IAG
3. Endpoint Secure
4. Cyber Command

핵심 원칙:
- 이 프로젝트는 AIOS와 별도 독립 프로젝트다.
- MCP-style stdio server를 우선 완성한다.
- 실제 Sangfor 장비에는 연결하지 않는다.
- Mock Sangfor Console과 dry-run operator만 사용한다.
- 위험 작업은 승인 전 절대 실행하지 않는다.
- 비밀번호, OTP, MFA, License Key는 저장하지 않는다.
- 위키는 propose -> approve -> apply 흐름으로만 반영한다.
- mock/stub/TODO는 명확히 표시한다.

우선 검증:
1. `pnpm install`
2. `pnpm test`
3. `pnpm lint`
4. `pnpm build`
5. `pnpm dev:mcp`
6. `tools/list` 호출
7. `sangfor.generate_config_plan` 호출
8. `sangfor.request_approval` 호출
9. `sangfor.execute_console_action` dry-run 호출
10. `sangfor.run_planner_eval` 호출

필수 수정/개선:
- TypeScript compile error가 있으면 즉시 수정한다.
- MCP tool input/output 구조를 일관되게 유지한다.
- HCI plan에는 반드시 MTU precheck를 포함한다.
- IAG plan에는 반드시 current policy export를 포함한다.
- Endpoint Secure plan에는 반드시 pilot group rollout을 포함한다.
- Cyber Command plan에는 반드시 NTP/time sync validation을 포함한다.
- 위험 작업 dryRun=false는 승인 없이는 blocked 처리한다.
- wiki apply는 approved 상태 전에는 실패해야 한다.
- feedback -> lesson -> wiki proposal -> eval 흐름을 테스트한다.

절대 금지:
- 실제 고객 장비 자동 설정
- 실제 운영 장비 변경
- OS shell command execution tool 추가
- 임의 파일 삭제/수정 tool 추가
- 승인 없는 Apply/Save/Delete/Reboot/Failover/Migration
- AIOS 본체 병합

완료 조건:
- `pnpm test` 통과
- `pnpm lint` 통과
- `pnpm build` 통과
- MCP smoke test 성공
- HCI/IAG/Endpoint Secure/Cyber Command planner eval 성공
- 위험 작업 차단 테스트 성공
- 위키 승인 흐름 테스트 성공

결과 보고 형식:
1. 수정한 파일
2. 실행한 명령
3. 테스트 결과
4. 남은 TODO
5. 보안상 보류한 항목
