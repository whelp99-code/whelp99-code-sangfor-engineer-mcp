# 01 — Discovery · Baseline

모든 항목에 상태 라벨(CONFIRMED / INFERRED / ASSUMED / UNKNOWN)과 파일:라인 근거.

## A. 제공자 (engineer-mcp) — CONFIRMED

### A1. 실존 명령 (package.json)
| 목적 | 명령 | 근거 |
|---|---|---|
| 테스트 | `pnpm test` (= `vitest run --config vitest.config.ts`) | package.json:15 |
| 린트/타입 | `pnpm run lint` (= `tsc -p tsconfig.json --noEmit`) | package.json:17 |
| 빌드 | `pnpm run build` (= `tsc -p tsconfig.json`) | package.json:18 |
| operator-console 기동(:3502) | `pnpm run dev:operator-console` (또는 `dev:web`, 동일) | package.json:13-14 |
| 시드 코퍼스 적재 | `pnpm run learn:ingest-seeds` (인자 없음 → `data/rag/index.json`) | package.json:23 |
| 단일 문서 적재 | `pnpm run ingest:docs <filePath> <product> [version]` | package.json:38, scripts/ingest-documents.ts:5 |
| 인덱스 재임베딩(in-place) | `pnpm run rag:reembed [indexPath] [rawDir]` | package.json:35, scripts/rag-reembed.ts:26 |
| 임베딩 provider 헬스체크 | `pnpm run check:embedding-providers` (실패 시 exit 1) | package.json:34, scripts/check-embedding-providers.ts:47 |

**Makefile 없음** (CONFIRMED: `test -f Makefile` → 없음). 계획서 어디서도 `make up`을 쓰지 않는다.

### A2. `/api/rag-search` 현재 계약 (CONFIRMED)
- 핸들러 `postRagSearch` — `apps/operator-console/src/api.ts:54-63`, 등록 `apps/operator-console/src/server.ts:104-107`.
- **요청**: `{ query: string(required), product?: string, version?: string, limit?: number(default 10) }`.
- **현재 응답**: `RagSearchHit[]` — **bare JSON 배열**(엔벨로프 없음). 각 hit = `{id, sourceType, product, version?, title, section?, text, trustLevel, score, rerankScore?, vector:number[], contentHash, filePath, embeddingBackend, embeddingModel?, vectorDims}` (index.ts:30-56, shared:176-185).
- **결함 1 (CONFIRMED)**: 빈/누락 query → `Error('query is required')`(api.ts:55)가 서버 blanket try/catch에 잡혀 **HTTP 500** 반환(server.ts:141) — 400이어야 함.
- **결함 2 (CONFIRMED)**: 응답이 각 hit마다 **원본 임베딩 벡터(384 floats)** 를 그대로 노출(api.ts:56-63, 필드 스트립 없음). 대역폭 낭비 + 소비자 불필요.
- **결함 3 (CONFIRMED, cross-repo)**: 소비자 `engineerConsole.ragSearch` 반환 타입은 `RagSearchResult = {query?, results?: RagHit[]}`(sangfor-os `packages/infra/src/engineer-console.ts:28-32`) — **`.results` 엔벨로프 기대**. 제공자는 bare 배열 반환 → 소비자가 `result.results`를 읽으면 `undefined`. **통합 시 결과가 항상 비어 보인다.** → ADR-001.

### A3. RAG 적재/임베딩 상태 (CONFIRMED — `data/rag/index.json` 파싱)
- 인덱스: `data/rag/index.json`, 35MB, **4,756 chunks**, `version:1`, `updatedAt 2026-07-01`.
- 제품별: IAG 853 / NDR 566 / ENDPOINT_SECURE 462 / HCI 2478 / CYBER_COMMAND 397. 전부 `sourceType:manual`.
- **임베딩 backend: 100% `hash`** (4,756/4,756). 실 시맨틱 벡터가 한 번도 생성된 적 없음 — 적재 시점(2026-07-01) provider 미도달로 해시 폴백. 검색 품질이 현재 해시 수준(저품질). 근거: hash-embedding.ts:4-14(384 dims).
- 임베딩 provider 선택: `SANGFOR_EMBEDDING_PROVIDER`(default `rapid-mlx` / `mimo`/`hash`/`litellm`), `SANGFOR_EMBEDDING_FORCE_HASH=1`이면 강제 해시. 비-hash는 `SANGFOR_EMBEDDING_INIT_TIMEOUT_MS`(default 5000) 헬스체크 실패 시 조용히 해시 폴백. 근거: embedding-provider.ts:12-59.
- **OpenAI 호환 seam (CONFIRMED)**: `openai-embeddings-client.ts:9-48`가 `${baseUrl}/embeddings`로 `{model,input}` POST, `{data:[{embedding}]}` 기대. `rapid-mlx`(base `SANGFOR_RAPID_MLX_BASE_URL` default `http://127.0.0.1:8000/v1`)·`litellm`(`SANGFOR_LITELLM_BASE_URL` default `http://127.0.0.1:4000/v1`) 둘 다 이 클라이언트 재사용. **ollama가 OpenAI 호환 `/v1/embeddings`를 제공하므로 base URL을 ollama로 지정 가능** — 단 이는 INFERRED(실기동 ollama 대조 미검증). → ADR-002 + 조정지점.
- `rag:reembed`(인자 없음): `data/sources/raw` 부재(CONFIRMED)라 **저장된 `.text`로 전 청크 in-place 재임베딩**, provider가 hash 아니면 `index.version=2`로 bump. 근거: rag-reembed.ts:76-89.

### A4. 환류 스키마·write 경로 (CONFIRMED)
- Prisma `SangforFeedbackEvent`(schema:52-61): `{id, product, feedbackType, severity, feedbackText, sourceRole, status(default "new"), createdAt}`. `SangforWikiUpdateProposal`(schema:63-71): `{id, targetPage, title, beforeText, afterText, status(default "pending"), createdAt}`.
- **`SangforWikiUpdateProposal`에 대한 write 함수 없음** (CONFIRMED: grep 결과 schema 밖 0건). Prisma 모델은 고아/죽음.
- **실사용 위키 제안은 파일 기반** `WikiUpdateProposal`(`packages/sangfor-wiki/src/index.ts:91-100`, status enum `pending|approved|rejected|applied`), JSONL `data/wiki/proposals.jsonl`(root `SANGFOR_WIKI_ROOT`). 라이프사이클: `proposeWikiUpdate({lessonTitle,lessonBody,targetPage?,adapter?})`(~185, `status:"pending"` 하드코딩 191) → `approveWikiUpdate()`(HMAC `SANGFOR_WIKI_APPROVAL_SECRET`, ~211) → `applyWikiUpdateWithAdapter()`(~238). → PR-004는 이 경로를 쓴다. (라인은 ~10줄 드리프트 가능 — ADJ-4로 실행 시 확인.)
- 피드백 write: `persistFeedbackEvent({product,feedbackType,severity,feedbackText,sourceRole})→Promise<string|null>`(sangfor-store:40-60, DB 없으면 no-op). operator-console `postFeedback`(api.ts:108)에서 호출.
- 위키 어댑터: `ObsidianVaultAdapter`(로컬 vault write), `GitHubWikiGitAdapter`(git clone+commit+**push**, 되돌리기 어려움) — `applyWikiUpdateWithAdapter`에서만 실행. 근거: sangfor-wiki index.ts:107-159.

### A5. 아키텍처·안전 제약 (CONFIRMED)
- 계층 하향 의존, `@sangfor/rag`=L1, 앱은 상대경로 import. Postgres는 optional bridge(`DATABASE_URL`+`SANGFOR_DB_ENABLED!=0`일 때만), 주 상태는 파일. ARCHITECTURE.md:27-38,85.
- 안전 불변식(AGENTS.md:47-52): read-only 기본, write는 `SANGFOR_ALLOW_REAL_EXECUTION`+HMAC action-bound 승인, fail-closed, 시크릿 마스킹 후 영속.

### A6. Baseline (실행 결과 — CONFIRMED)
- `pnpm test` → **exit 0**, 71 files pass/1 skip, 432 tests pass/2 skip, 2.66s. 기존 실패 0.
- `pnpm run lint` → **exit 0**, 진단 0.
- DB(5432): 미기동(`nc -z localhost 5432` exit 1), `.env`에 `DATABASE_URL` 없음 → `isStoreEnabled()` false, 모든 Prisma write no-op (CONFIRMED). 이 환경에서 DB row 실측 불가(UNKNOWN — 런타임 관측).

## B. 소비자 (sangfor-os) — CONFIRMED

### B1. `/api/engineer/rag` 계약
- `apps/web/src/app/api/engineer/rag/route.ts:1-32`: POST, `assertApiAccess`(L8, 실패 401), body `{query,product,limit}`, query 비-string/빈문자 → 400 `{error:"query is required"}`(L16-17), 성공 시 `engineerConsole.ragSearch({query,product,limit})` 결과 verbatim `Response.json`(L20-25), 실패 → 502 `{error:"rag_search_failed", results:[]}`(L27-30).
- `engineerConsole.ragSearch(body, opts)`(`packages/infra/src/engineer-console.ts:95`): POST `/api/rag-search`, base `WHELP99_OPERATOR_CONSOLE_URL ?? getUrl("WHELP99_OPERATOR_CONSOLE")`(port 3502, ports.ts:35), timeout 30s, retry 2(5xx+network, 4xx 재시도 안 함), 반환 `RagSearchResult={query?,results?:RagHit[]}`(L28-32). `RagHit={id?,text?,score?,source?,product?}`(L20-27).

### B2. engineer 도메인 AI 주입 seam (CONFIRMED 제약)
- `runDomainStage`(`packages/business/src/domain-ai/domain-agent-runtime.ts:133-207`): recall(L147)→`buildDomainPrompt`(L151)→`generate({domain,case,recalled,prompt})`(L152)→게이트→기록→학습→영속.
- `generate` 입력(`DomainGenerator`, L50-55): `{domain, case:DomainCase, recalled, prompt}`. `DomainCase`(L35-40)=`{id,subject,tags:string[],content?}` — **product 필드 없음**. `DomainRuntimeDeps`(L64-82)엔 `generate?/evaluateGate?/projectSlug?/recallTopK?/...` — **rag 필드 없음**.
- **business는 `@sangfor/infra`(engineerConsole 소재) import 불가** (CONFIRMED: business/package.json:39-41은 shared/db/mail-intelligence만; business/AGENTS.md:6-7 "Do not import @sangfor/infra"). → RAG 조회는 **web 계층**에서. 주입은 (A) web이 커스텀 `DomainGenerator`를 `deps.generate`로 주입, 또는 (B) web이 RAG 텍스트를 `DomainCase.content`에 사전 주입(`buildDomainPrompt` L118이 content를 프롬프트에 넣음 — 최소 변경). → ADR-003.
- **engineer 도메인 실행이 web에 전혀 연결 안 됨** (CONFIRMED: `runDomainStage`/`runDomainPipeline` web 호출 grep 0). PR-003은 이 연결을 처음 만드는 그린필드.

### B3. `/support` 화면 (CONFIRMED)
- `apps/web/src/app/(portal)/support/page.tsx:1-102`: 서버 컴포넌트, `prisma.supportCase.findMany`(L23), status 5단계 칸반. **`support/[id]` 상세 라우트 없음**(CONFIRMED, 부재), `/api/support*` 없음.
- `SupportCase`(`packages/db/prisma/schema.prisma:2319-2334`): `{id,customerId,subject,severity,status,slaDeadline?,assignedTo?,customer,vendorEscalations}`. **자유서술 본문 없음 — `subject`가 유일 텍스트.** 연관 `VendorEscalation`(2336-2348)에 `reason`/`resolution`.

### B4. 명령·Baseline (CONFIRMED)
- 머지 게이트: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`(AGENTS.md:40). business: `tsc -p tsconfig.json --noEmit`(package.json:32-35), `vitest run`. web: `eslint . && tsc ...`(package.json:10-12). DB 통합테스트는 `CI_INTEGRATION=1` 게이트.
- Baseline: `cd packages/business && npx tsc -p tsconfig.json --noEmit` → **exit 0**(CONFIRMED 2026-07-12).
- 플래키 격리: domain-proposal/mail-candidates-convert는 `CI_INTEGRATION` skipIf 게이트(CONFIRMED). daily-report 격리는 파일 내 게이트 부재로 **미확인(UNKNOWN)**.

## C. 조사가 계획에 미친 핵심 영향 (요약)
1. bare-array vs `{results}` 계약 불일치 → PR-001에서 제공자가 엔벨로프로 정합(ADR-001). **미수정 시 통합이 조용히 빈 결과.**
2. 인덱스 100% 해시 → PR-001에서 ollama nomic-embed 재임베딩(ADR-002). **미수정 시 관련지식 품질 낮음.**
3. 위키 Prisma 모델 죽음 → PR-004는 파일 기반 `proposeWikiUpdate` 사용(ADR-005).
4. engineer 도메인 web 미연결 → PR-003은 그린필드(도메인 실행+RAG 주입 동시).
5. SupportCase 본문 없음 → RAG 쿼리는 subject 기반(ADR-004, 무마이그레이션).
