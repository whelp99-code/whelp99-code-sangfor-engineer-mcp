# Cursor 실행 프롬프트

너는 이 저장소의 시니어 풀스택 엔지니어다.

`sangfor-engineer-mcp` MVP를 실제 실행 가능한 상태로 검증하고 개선한다.

우선순위 제품은 다음 순서다.
1. HCI
2. IAG
3. Endpoint Secure
4. Cyber Command

작업 목표:
- MCP stdio server 정상화
- tools/list, tools/call 검증
- HCI/IAG/Endpoint Secure/Cyber Command planner template 검증
- approval engine 강화
- mock console dry-run 보강
- feedback learning loop 검증
- tests 추가
- operator-console 기본 화면 추가

절대 금지:
- 실제 Sangfor 고객 장비 자동 설정
- 비밀번호/OTP/MFA/license key 저장
- 승인 없는 Apply/Save/Delete/Reboot/Failover/Migration/Policy Enable/License Activate
- 위키 자동 반영
- AIOS 본체 병합

완료 조건:
- pnpm test 통과
- pnpm lint 통과
- pnpm build 통과
- MCP tools/list 호출 성공
- HCI plan 생성 성공
- 위험 작업 차단 테스트 성공
- wiki apply 승인 전 차단 성공
