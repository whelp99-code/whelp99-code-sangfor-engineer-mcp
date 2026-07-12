# 00 — Intake · Scope (Engineer RAG 통합)

**Plan ID:** engineer-rag-integration
**Date:** 2026-07-12
**Author agent:** Fable 5 (planning)
**Tier:** L (근거: §티어 판정 in `04-RISKS.md`)
**Primary repo (문서 보관):** `/Users/jmpark/Playground/whelp99-code-sangfor-engineer-mcp` (branch `docs/fable-doctrine-agents`)
**Second repo (cross-repo):** `/Users/jmpark/Playground/sangfor-os` (branch `dev-clean`)

> 이 계획은 **두 저장소에 걸친 하나의 통합**을 다룬다. 각 PR은 `[repo:engineer-mcp]` 또는 `[repo:sangfor-os]` 라벨로 어느 저장소에서 실행되는지 명시한다. 실행 에이전트는 해당 라벨의 저장소에서만 작업한다.

## 요구 유형
Feature integration (cross-repo). 기존에 각자 존재하는 RAG 제공자(engineer-mcp)와 소비 앱(sangfor-os)을 **실사용 흐름으로 연결**한다.

## 목적 (한 문단)
Sangfor 필드 엔지니어가 지원 케이스를 다룰 때, **관련 제품 매뉴얼 지식이 화면에 뜨고(소비)**, **engineer 도메인 AI 제안이 그 지식에 근거하며(주입)**, **해결된 케이스가 위키 갱신 제안으로 환류(피드백)**되는 상태를 만든다. 성공은 데모가 아니라 "실 케이스 1건에서 관련지식 패널이 실제 매뉴얼 청크를 보여주고, engineer 도메인 제안 로그에 RAG 컨텍스트가 포함됨"으로 검증한다.

## 대상 사용자
Sangfor 필드 엔지니어 / 프리세일즈 (sangfor-os 포털 `/support` 사용자). 내부 운영자(engineer-mcp operator-console).

## 핵심 흐름 (통합 후 목표 상태)
1. 엔지니어가 `/support/{caseId}` 케이스 상세를 연다.
2. "관련 지식" 패널이 케이스 제목/증상으로 RAG를 조회해 상위 3개 매뉴얼 청크 + 출처를 보여준다.
3. 엔지니어가 도메인 AI 제안을 요청하면, 제안 생성 시 동일 RAG 컨텍스트가 프롬프트에 주입된다.
4. 케이스 해결 후, 해결책이 피드백 이벤트 + 위키 갱신 제안으로 적재된다(사람 HMAC 승인 후에만 실제 위키 반영).

## 연결 구조 (런타임 실경로 — CONFIRMED)
```
[sangfor-os]                                  [engineer-mcp]
/support/[id] (UI)                            operator-console :3502
  └─ POST /api/engineer/rag                     └─ POST /api/rag-search
       route.ts:20 engineerConsole.ragSearch ──────► api.ts:54 postRagSearch
       (WHELP99_OPERATOR_CONSOLE_URL, :3502)          └─ ragSearch() @sangfor/rag
                                                          └─ data/rag/index.json (4,756 chunks)
```
근거: `apps/web/src/app/api/engineer/rag/route.ts:20`, `packages/infra/src/engineer-console.ts:58-95` (sangfor-os); `apps/operator-console/src/server.ts:104`, `apps/operator-console/src/api.ts:54-63`, `packages/sangfor-rag/src/index.ts:246` (engineer-mcp).

## IN_SCOPE
- **PR-001 [engineer-mcp]**: RAG 제공자 하드닝 — API 응답 계약 정합(`{query,results}` 엔벨로프), 벡터 원본 스트립, query 검증(400), 실 임베딩 재생성(ollama nomic-embed).
- **PR-002 [sangfor-os]**: `/support/[id]` 케이스 상세 화면 + "관련 지식" 패널 (walking skeleton — 가장 얇은 가시 흐름).
- **PR-003 [sangfor-os]**: engineer 도메인 제안에 RAG 컨텍스트 주입 (web에서 도메인 실행 + content 주입 seam). **engineer 도메인이 현재 web에 미연결이므로 이 PR이 그 연결을 처음 만든다(그린필드).**
- **PR-004 [engineer-mcp]**: 지식 환류 — 해결 케이스 → 피드백 이벤트 + **파일 기반** 위키 갱신 제안(`proposeWikiUpdate`), HMAC 승인 게이트 유지.

## OUT_OF_SCOPE (이번에 안 하는 것 — 명시)
- **위키 자동 반영/자동 git push.** 제안 생성까지만. 실제 위키 write(`applyWikiUpdateWithAdapter`)는 사람 HMAC 승인 후 별도 수동 — 안전 불변식(AGENTS.md:47-52) 준수.
- **죽은 Prisma RAG 스키마 활성화.** `SangforRagDocument`/`SangforRagChunk`/`SangforWikiUpdateProposal`(prisma) 테이블은 파이프라인 미사용(호출자 0). 이번 계획은 실사용 경로인 **JSON 인덱스 + 파일 기반 위키 제안**만 쓴다. DB 마이그레이션으로 이 테이블들을 살리는 것은 범위 밖.
- **SupportCase 스키마 확장.** 케이스 본문 필드 추가는 하지 않는다(현재 `subject`만 존재). RAG 쿼리는 `subject`(+연관 `VendorEscalation.reason`)로 구성. 근거·대안은 ADR-004.
- **실장비/VPN.** RAG는 로컬 코퍼스라 실장비 불필요.
- **멀티벤더 RAG 확장, 파인튜닝, 대체율 KPI** — engineer-mcp 6개월 로드맵(별도 문서)의 M2/M5 소관.
- **embedding provider를 MLX/litellm 원본으로 복구.** 이번엔 ollama nomic-embed 정합만.

## 사용자의 기존 변경 (충돌 방지 — PHASE 00)
- engineer-mcp: `git status` clean, HEAD `d83e9d1`(시크릿 제거). 미커밋 변경 없음 (CONFIRMED).
- sangfor-os: branch `dev-clean`. 이번 세션에 PR #129(임베딩)·#130(계측) main 머지됨. `/api/engineer/rag`·`/support`·engineer 도메인은 이번 세션에서 미변경 — 충돌 없음 (CONFIRMED).

## 관련 문서
- 소비자 측 원 계획: sangfor-os `docs/master-plan/07-enhancement-phase-5.md:20-29` (M5 Task 2).
- 제공자 측 로드맵: engineer-mcp `docs/superpowers/plans/2026-07-08-six-month-roadmap.md` (이 통합과 별개, 참고).
