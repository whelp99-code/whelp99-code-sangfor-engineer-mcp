# 03 — Architecture · Contracts · ADR

## 현 구조 → 목표 구조
- **현재**: 제공자 RAG 엔진·검색·인덱스는 있으나(엔진 L1) 응답 계약이 소비자와 어긋나고 인덱스가 해시 임베딩. 소비자는 `/api/engineer/rag` 라우트만 있고 이를 호출하는 UI/도메인/환류가 전무.
- **목표**: 제공자가 정합된 엔벨로프 + 실 임베딩으로 응답 → 소비자 `/support/[id]`가 관련지식 표시, `/api/engineer/domain-proposal`이 RAG 주입 제안 생성, 해결 케이스가 파일 기반 위키 제안으로 환류.

## ADR (고정 결정)

### ADR-001 — 계약 불일치를 제공자에서 엔벨로프로 해소
Status: Accepted. Related: REQ-PROV-001, PR-001.
Context: 소비자 `RagSearchResult={query?,results?}` vs 제공자 bare 배열.
Options: (A) 제공자가 `{query,results}` 엔벨로프 반환 / (B) 소비자가 bare 배열 언랩.
Decision: **(A)**. Reason: 소비자 타입이 이미 sangfor-os에 배포된 안정 계약이고, 제공자 응답을 엔벨로프화하면 벡터 스트립(REQ-PROV-002)도 같은 자리에서 처리. Consequences: `/api/rag-search`의 다른 소비자가 있으면 깨질 수 있음 → 조정지점 ADJ-1에서 확인. Rollback: `postRagSearch` 한 함수 revert.

### ADR-002 — 임베딩 backend를 ollama nomic-embed로 정합
Status: Accepted. Related: REQ-PROV-004, PR-001. INFERRED(ollama 호환).
Context: 인덱스 100% hash. sangfor-os는 M5에서 ollama `nomic-embed-text`(:11434, 768d) 채택. 제품군 전체 임베딩 정합이 검색 품질·재현성에 유리.
Options: (A) ollama nomic-embed(제로비용 로컬, sangfor-os와 동일) / (B) 원래 rapid-mlx/litellm 복구(인프라 필요) / (C) hash 유지(저품질).
Decision: **(A)** via `SANGFOR_EMBEDDING_PROVIDER=litellm` + `SANGFOR_LITELLM_BASE_URL=http://127.0.0.1:11434/v1` + 모델 env(`nomic-embed-text`) → `pnpm run rag:reembed`.
Reason: sangfor-os 도메인 recall과 engineer RAG가 동일 임베딩 공간을 쓰게 됨. Consequences: hash 384d → nomic 768d 차원 변경이라 **전 인덱스 재임베딩 필수**(부분 혼합 시 코사인 0). 재임베딩은 4,756청크라 시간 소요. Rollback: `SANGFOR_EMBEDDING_FORCE_HASH=1` + rag:reembed로 hash 복귀. 조정지점 ADJ-2(litellm provider의 모델 env 이름 확인).

### ADR-003 — RAG 주입은 web 계층, `DomainCase.content` 경유 (option B)
Status: Accepted. Related: REQ-DOM-001, PR-003.
Context: business는 infra(engineerConsole) import 불가. generate 입력에 content 필드 존재.
Options: (A) web이 커스텀 DomainGenerator를 deps.generate로 주입 / (B) web이 RAG 텍스트를 DomainCase.content에 사전 주입.
Decision: **(B)**. Reason: 스파인 8단계·게이트·기본 생성기 체인을 전혀 수정하지 않는 최소 변경(`buildDomainPrompt`가 content를 이미 프롬프트에 넣음). Consequences: content에 원 케이스 본문 + RAG 컨텍스트를 합쳐야 함(포맷은 `assembleRagContext`가 담당). Rollback: 주입 라인 제거.

### ADR-004 — SupportCase 스키마 미확장, subject로 쿼리
Status: Accepted. Related: REQ-UI-002, ADR. 
Context: SupportCase에 본문 필드 없음(subject만).
Options: (A) content 컬럼 추가(마이그레이션) / (B) subject(+vendorEscalation.reason)로 쿼리.
Decision: **(B)**. Reason: 데이터 보존·가역성 우선, 마이그레이션 0. Consequences: 쿼리 텍스트가 짧을 수 있음(subject만). 필요 시 후속에서 content 컬럼 추가. Rollback: N/A(추가 안 함).

### ADR-005 — 위키 환류는 파일 기반 경로, Prisma 모델 미사용
Status: Accepted. Related: REQ-FB-001, PR-004.
Context: `SangforWikiUpdateProposal`(prisma) write 경로 없음(죽음). 실사용은 파일 기반 `proposeWikiUpdate`(JSONL).
Decision: PR-004는 `packages/sangfor-wiki`의 `proposeWikiUpdate` 사용, JSONL 영속. Reason: 실동작 경로 사용, DB 불필요(로컬-first 아키텍처 일치). Consequences: Prisma 모델은 계속 고아(정리는 범위 밖). Rollback: 신규 라우트 제거.

## 계약 (PHASE 08)

### [API] POST /api/rag-search (engineer-mcp operator-console :3502) — MODIFY
- AuthN/AuthZ: `checkAuth(authorization, SANGFOR_API_TOKEN)` (미설정 시 no-op) — 기존 유지.
- Body: `{query:string(1..), product?:string, version?:string, limit?:number(default 10)}`.
- 성공 200: `{query:string, results: RagHitPublic[]}` where `RagHitPublic = {id, product, version?, title, section?, text, trustLevel, score, rerankScore?, source}` (`source` = 기존 hit의 `filePath`). **`vector`/`contentHash`/`embedding*` 제외.**
- 400 VALIDATION_ERROR: query 누락/공백. Body `{error:{code:"VALIDATION_ERROR", message}}`.
- 500 INTERNAL_ERROR: 검색 예외. Body `{error:{code:"INTERNAL_ERROR", message}}` (bare 배열 금지).
- 멱등: GET-유사 read, 부작용 없음. Timeout: 소비자 30s.

### [API] GET (page) /support/[id] (sangfor-os) — CREATE
- 서버 컴포넌트. Entry: 로그인 세션(포털). Data Source: `prisma.supportCase.findUnique({where:{id}, include:{customer, vendorEscalations}})` + **서버 컴포넌트에서 `engineerConsole.ragSearch` 직접 호출**(결정: apps/web이 `@sangfor/infra` 의존(ASM-4)이므로 서버 컴포넌트 직접 호출이 self-fetch 안티패턴을 피하는 정본 경로. 클라이언트 컴포넌트가 필요할 때만 `/api/engineer/rag` 경유). 상태: INITIAL/SUCCESS/EMPTY(패널 숨김)/NOT_FOUND(404). 접근성: 패널에 heading + list 시맨틱.

### [API] POST /api/engineer/domain-proposal (sangfor-os) — CREATE
- AuthN/AuthZ: `assertApiAccess(request)` (mutating 아님이지만 도메인 실행/기록 유발 → 게이트). 
- Body: `{caseId:string, product?:string}`. Validation: caseId 필수.
- 처리: 케이스 로드 → `engineerConsole.ragSearch({query:subject, product, limit:5})` → `assembleRagContext` → `runDomainStage("engineer", {id,subject,tags,content: 원본+RAG}, deps)` → 아티팩트 반환.
- 200: `{proposal:{...}, ragSources: string[]}`. 400: caseId 누락. 502→**삼키고** ragSources:[]로 진행(제안은 생성). 
- 상태 전이: 도메인 결정 기록은 기존 스파인이 담당(무변경).

### [API] POST /api/case-resolution (engineer-mcp operator-console) — CREATE
- Body: `{product:string, caseSummary:string, resolution:string, targetWikiPage:string, sourceRole?:string}`.
- 처리: `persistFeedbackEvent({product, feedbackType:"resolution", severity:"info", feedbackText:resolution, sourceRole: sourceRole ?? "engineer"})`(모든 필드 필수 — sangfor-store:40, sourceRole 기본값 지정) + `proposeWikiUpdate({lessonTitle:caseSummary, lessonBody:resolution, targetPage:targetWikiPage})`(실제 시그니처 `{lessonTitle, lessonBody, targetPage?, adapter?}` — sangfor-wiki index.ts:185, ADJ-4로 최종 확인).
- 200: `{feedbackId:string|null, proposalId:string}`. 400: 필수 필드 누락. 
- 부작용: `data/wiki/proposals.jsonl` append(가역 — 파일 라인). **git push 없음**(applyWikiUpdate는 별도 HMAC 승인).

### [오류] 표준 매핑
`{error:{code, message(안전), requestId?, details?}}`. 400 VALIDATION_ERROR / 401 UNAUTHORIZED / 404 NOT_FOUND / 500 INTERNAL_ERROR. Stack/secret 노출 금지. (소비자 sangfor-os는 `apiError` 사용 — api-auth.ts:74.)

### [데이터] N/A — 신규 테이블·마이그레이션 없음 (ADR-004/005). 파일 산출물: `data/rag/index.json`(재작성), `data/wiki/proposals.jsonl`(append).

### [이벤트] 위키 제안 라이프사이클(실제 enum `pending|approved|rejected|applied`): `pending`(PR-004 생성, `proposeWikiUpdate` 하드코딩 초기값) → `approved`(HMAC, MANUAL) → `applied`(어댑터 write, MANUAL). Producer: /api/case-resolution. Consumer: 사람(승인) + `applyWikiUpdateWithAdapter`.

### [UI] /support/[id] 상태: INITIAL→SUCCESS(케이스+패널)/EMPTY(패널만 숨김)/NOT_FOUND(404)/에러(패널만 숨김, 케이스는 렌더).

## 알려진 조정 지점 (Known Adjustment Points)
| # | 계획의 가정 | 다를 수 있는 이유 | 실행 에이전트 확인 방법 |
|---|---|---|---|
| ADJ-1 | `/api/rag-search`의 유일 소비자는 sangfor-os | mcp-server/다른 앱이 HTTP 엔드포인트를 쓸 수 있음 | engineer-mcp에서 `grep -rn "/api/rag-search\|postRagSearch" apps packages --include=*.ts`; 다른 소비자 있으면 그 계약도 엔벨로프로 갱신 후 보고 |
| ADJ-2 | litellm provider가 모델을 `nomic-embed-text`로 보냄 | provider가 다른 모델 env를 읽을 수 있음 | `packages/sangfor-rag/src/litellm-provider.ts` 및 `openai-embeddings-client.ts` 읽어 모델 env 이름 확인, `.env`에 정확히 지정 |
| ADJ-3 | (결정됨) `/support/[id]` 패널은 **서버 컴포넌트에서 `engineerConsole.ragSearch` 직접 호출** | apps/web의 infra 의존 여부만 재확인 필요 | `apps/web/package.json`에 `@sangfor/infra` 있는지 확인(있음: 20-26). 없으면 그때만 `/api/engineer/rag` fetch로 폴백하고 보고 |
| ADJ-4 | `proposeWikiUpdate` 시그니처가 `{targetPage,title,afterText,...}` | 실제 필드명이 다를 수 있음 | engineer-mcp `packages/sangfor-wiki/src/index.ts:198` 읽어 실제 인자에 맞춤 |
| ADJ-5 | engineer 도메인 키가 `"engineer"` | GtmDomain 열거가 다를 수 있음 | sangfor-os `packages/shared/src/modes`에서 GtmDomain 확인 |

**지시**: 위 지점에서 실제 코드가 계획과 다르면 **질문하지 말고 grep/read로 실제를 확인해 맞추고, 조정 내용을 결과 보고에 포함하라.** 단 계약 자체가 모순이면(예: 소비자·제공자 타입이 양립 불가) 중단하고 BLOCKED 보고.

## AUTONOMOUS / MANUAL 분리
- **[AUTONOMOUS]** PR-001의 코드 변경(엔벨로프·벡터스트립·400), PR-002 전체, PR-003 전체, PR-004 전체. 검증 명령 실행·테스트.
- **[MANUAL-1] ollama + nomic-embed 기동** — 누구: 사람/환경. 언제: **PR-001의 재임베딩(REQ-PROV-004) STEP 전**. 없으면: rag:reembed가 hash 폴백 → REQ-PROV-004 BLOCKED(코드 변경분은 진행 가능하나 임베딩 재생성은 대기). 확인: `curl -s http://127.0.0.1:11434/v1/models` 또는 `pnpm run check:embedding-providers`. (sangfor-os 세션에서 이미 ollama launchd 등록됨 — `com.jmpark.sangfor.ollama`, 참고.)
- **[MANUAL-2] operator-console(:3502) 기동** — 언제: PR-002/PR-003의 통합 검증(실 rag 응답 확인) 전. 없으면: UI/도메인 통합 스모크 BLOCKED(유닛/타입은 무관). 확인: `pnpm run dev:operator-console` 후 `curl -s -XPOST localhost:3502/api/rag-search -d '{"query":"IAG"}'`.
- **[MANUAL-3] 위키 제안 실제 승인·반영** — 언제: 전체 완료 후, 사람이 HMAC 승인. 자율 구간은 제안 생성까지만(REQ-FB-002).
