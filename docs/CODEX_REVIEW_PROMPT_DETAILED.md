# Codex Review Prompt

너는 MCP, 보안 자동화, Sangfor 구축 자동화, TypeScript monorepo 관점의 시니어 리뷰어다.

리뷰 대상: `sangfor-engineer-mcp`

리뷰 목표:
이 프로젝트가 Sangfor 제품 전용 시니어 엔지니어 MCP 서버 MVP로 안전하고 확장 가능한 구조인지 검증한다.

반드시 실행:

```bash
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

검토 항목:
1. 제품 우선순위가 HCI -> IAG -> Endpoint Secure -> Cyber Command로 반영됐는가
2. MCP-style `initialize`, `tools/list`, `tools/call`이 정상 동작하는가
3. 각 tool의 inputSchema와 output 구조가 일관적인가
4. 프로젝트 분석 결과에 missingInputs, assumptions, recommendedKnowledgeQueries가 포함되는가
5. config plan에 precheck, steps, rollbackPlan, validationPlan, references가 포함되는가
6. HCI plan에 MTU precheck가 포함되는가
7. IAG plan에 current policy export와 emergency bypass가 포함되는가
8. Endpoint Secure plan에 pilot group rollout이 포함되는가
9. Cyber Command plan에 NTP/time sync validation이 포함되는가
10. 위험 작업은 approval_required 또는 blocked 처리되는가
11. `dryRun=false` 위험 작업이 승인 없이 실행되지 않는가
12. 위키 업데이트는 승인 전 apply되지 않는가
13. feedback -> lesson -> wiki proposal -> eval case 흐름이 구현되어 있는가
14. 실제 Sangfor 고객 장비 연결 코드가 없는가
15. 비밀번호/OTP/MFA/license key 저장 코드가 없는가
16. 임의 shell execution, file deletion, production deploy tool이 없는가
17. 테스트가 정상/실패/위험작업/위키승인/플래너 eval을 포함하는가
18. AIOS 병합 전 독립 실행 가능한가

보안 중점:
- MCP tool handler가 외부 입력을 shell command로 넘기지 않는지 확인
- 위험 액션 키워드 우회 가능성이 있는지 확인
- tool result에 민감정보가 포함될 수 있는지 확인
- stdout/stderr에 secret이 출력될 가능성이 있는지 확인
- 실제 장비 write action이 MVP에 숨어 있지 않은지 확인

리뷰 결과 형식:
1. 최종 판정: PASS / CONDITIONAL PASS / FAIL
2. 치명적 문제
3. 보안 위험
4. Sangfor 도메인 설계 문제
5. MCP 호환성 문제
6. 테스트 누락
7. 수정 지시
8. AIOS 병합 가능 여부
9. 다음 티켓 제안
