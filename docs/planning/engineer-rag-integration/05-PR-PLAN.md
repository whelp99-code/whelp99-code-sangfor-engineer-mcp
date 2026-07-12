# 05 — PR Plan · Dispatch · Tracking

수직 슬라이스 순서: `기준선 → 공통 계약(PR-001) → Walking Skeleton(PR-002) → 흐름 슬라이스(PR-003, PR-004)`.
각 PR에 `[repo:...]` 라벨. 실행 에이전트는 해당 저장소에서만 작업.

## PR 의존 그래프
```
PR-001 [engineer-mcp] 제공자 계약·임베딩 하드닝  (공통 계약)
   └─► PR-002 [sangfor-os] /support/[id] + 관련지식 패널  (walking skeleton)
   └─► PR-003 [sangfor-os] 도메인 제안 RAG 주입           (흐름 슬라이스)
PR-004 [engineer-mcp] 케이스 해결 → 위키 제안 환류        (독립 흐름, PR-002 UI가 트리거)
```
순환 없음. PR-002·PR-003은 PR-001의 응답 계약에 의존. **PR-004는 PR-001과 `apps/operator-console/src/server.ts`를 공유**(PR-001=검증 400 매핑, PR-004=라우트 등록 1줄) → File Ownership 충돌 방지를 위해 **PR-001 후 순차(SEQUENTIAL)**. 실행 순서: PR-001 → {PR-002, PR-003(둘은 sangfor-os 내 파일 무겹침이라 PARALLEL_SAFE), PR-004}.

---

## PR-001 [repo:engineer-mcp] — RAG 제공자 계약·임베딩 하드닝
Risk: R3(R-1,R-2,R-3) / Execution: SEQUENTIAL(선행) / Related REQ: PROV-001..004.
Purpose: 소비자와 정합된 엔벨로프 응답 + 실 임베딩으로 하위 PR이 실데이터를 받게 한다.
Predecessors: 없음. Successors: PR-002, PR-003.

[출력] 
- MODIFY: `apps/operator-console/src/api.ts`(postRagSearch: 엔벨로프·벡터스트립·검증), `apps/operator-console/src/server.ts`(400 매핑 필요 시)
- CREATE: `apps/operator-console/src/__tests__/rag-search-contract.test.ts`(또는 기존 테스트 디렉터리 관례 따름 — ADJ)
- 산출물(코드 아님): 재작성된 `data/rag/index.json`(rag:reembed)
- 새 Symbol: `toPublicHit(hit)` 순수 매퍼(벡터 스트립)

[금지] `packages/sangfor-rag/src/index.ts`(엔진 로직 불변 — 계약은 콘솔 계층에서), `packages/shared/**`, prisma/schema.prisma, 기존 테스트 전부.

[Change Budget] 수정 ≤4 / 신규 ≤2 / 논리 ≤200줄 / Migration 0. ✔ 예산 내.

[검증 명령] (engineer-mcp 루트)
- Typecheck/Lint: `pnpm run lint` → exit 0
- Unit: `pnpm test` → exit 0, 신규 계약 테스트 통과, 기존 432 무회귀
- 재임베딩(MANUAL-1 후): `pnpm run rag:reembed` → exit 0
- 통합 스모크(MANUAL-2 후): `pnpm run dev:operator-console` & `curl -s -XPOST localhost:3502/api/rag-search -H 'content-type: application/json' -d '{"query":"IAG 802.1X"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!Array.isArray(j.results))throw new Error('no results array');if(j.results[0]&&'vector'in j.results[0])throw new Error('vector leaked');console.log('OK',j.results.length)})"` → "OK N"

[완료 기준] REQ-PROV-001..004 구현 · 계약 테스트 통과 · 기존 테스트 무파괴 · 재임베딩 후 backend!=hash(MANUAL-1 충족 시).

### PR-001-SUB-001 — 응답 엔벨로프 + 벡터 스트립 + 400 검증
Related REQ: PROV-001,002,003.
[대상] MODIFY: `apps/operator-console/src/api.ts`(엔벨로프·스트립), `apps/operator-console/src/server.ts`(rag-search 블록 400 검증 — PR-004와 공유 파일, 순차). READ_ONLY: `packages/sangfor-rag/src/index.ts`(타입 참조). FORBIDDEN: 엔진 로직, shared.
[구현 순서]
- STEP 1 (api.ts): `toPublicHit(hit)` 추가 — `{id,product,version,title,section,text,trustLevel,score,rerankScore, source: hit.filePath}`만 반환(`vector`/`contentHash`/`embedding*`/`vectorDims` 제외). 위치: `postRagSearch` 상단 모듈 스코프. 검증: 반환 객체에 `vector` 키 없음.
- STEP 2 (server.ts): `/api/rag-search` 라우트 블록에서, `postRagSearch` 호출 **전에** 기존 관용구로 검증 — `if (!body?.query || !String(body.query).trim()) return error(res, "query is required")`. **`error(res, msg)`는 기본 status 400**(server.ts:35 관용구, 다른 라우트와 동일 — 실제 시그니처는 ADJ로 확인). sentinel 반환 설계는 쓰지 않는다. 기존 정상 경로·다른 라우트 무변경.
- STEP 3 (api.ts postRagSearch): 정상 시 `return { query, results: hits.map(toPublicHit) }`. (검증은 STEP 2가 server.ts에서 선행하므로 postRagSearch는 엔벨로프·스트립만 담당.)
- STEP 5 (test): `rag-search-contract.test.ts` — (a) 결과가 `{query,results}` 객체 (b) result에 vector 없음 (c) 빈 query→400. `ragSearch`를 스텁하거나 소형 인덱스 fixture 사용(기존 테스트 관례 따름).
[계약] `toPublicHit: (RagSearchHit) => RagHitPublic`. postRagSearch 반환: `{query:string, results:RagHitPublic[]}` | 400 오류. Exceptions: 내부 검색 예외는 500(기존). External: `ragSearch()`(무변경).
[검증] `pnpm run lint && pnpm test` → exit 0, 신규 3 케이스 통과.
[완료] 엔벨로프·스트립·400 구현, vector 미노출, 기존 무회귀.

### PR-001-SUB-002 — ollama nomic-embed 재임베딩
Related REQ: PROV-004. 사전조건: MANUAL-1(ollama+nomic-embed 기동).
[대상] MODIFY: `.env`(임베딩 provider env — 커밋 금지, 로컬만). READ_ONLY: `scripts/rag-reembed.ts`, `packages/sangfor-rag/src/{embedding-provider,litellm-provider,openai-embeddings-client}.ts`. FORBIDDEN: 엔진 로직.
[구현 순서]
- STEP 1: `data/rag/index.json` 백업(`cp data/rag/index.json data/rag/index.json.bak`).
- STEP 2: `.env`에 `SANGFOR_EMBEDDING_PROVIDER=litellm`, `SANGFOR_LITELLM_BASE_URL=http://127.0.0.1:11434/v1`, 모델 env(ADJ-2로 정확한 이름 확인 후 `nomic-embed-text`). 
- STEP 3: `pnpm run check:embedding-providers` → exit 0(도달 확인). 실패면 BLOCKED(MANUAL-1).
- STEP 4: `pnpm run rag:reembed` → exit 0.
- STEP 5: 검증 — `node -e "const i=require('./data/rag/index.json');const b=[...new Set(i.chunks.map(c=>c.embeddingBackend))];const d=[...new Set(i.chunks.map(c=>c.vectorDims))];if(b.includes('hash'))throw new Error('still hash');console.log('backends',b,'dims',d,'version',i.version)"` → hash 없음, dim 균일, version≥2. (chunk 필드명은 실제 인덱스 확인 후 맞춤 — ADJ)
[계약] 산출: 재작성 `data/rag/index.json`. Side effects: 파일 재작성(백업 존재). External: ollama `/v1/embeddings`.
[검증] STEP 5 스크립트 → backend에 "hash" 없음, version≥2.
[완료] 전 청크 실 임베딩, 백업 존재.

**디스패치 프롬프트 (PR-001):**
```text
TASK: PR-001 — engineer-mcp RAG 제공자 계약·임베딩 하드닝

사전 조건: SUB-002는 MANUAL-1(ollama+nomic-embed :11434) 완료 확인 후. 미충족이면 SUB-001만 하고 SUB-002는 BLOCKED 보고.

DELIVERABLE:
- 변경 diff (apps/operator-console/src/api.ts, server.ts, 신규 계약 테스트)
- `pnpm run lint && pnpm test` 출력(종료 0)
- (SUB-002) rag:reembed 후 backend 검증 스크립트 출력
- 조정 지점 보고 (ADJ-1..ADJ-2 확인 결과, 없으면 "없음")

SCOPE:
- 먼저 읽기: docs/planning/engineer-rag-integration/05-PR-PLAN.md의 PR-001, 03-ARCHITECTURE-CONTRACTS.md의 rag-search 계약·ADR-001/002·ADJ-1/2
- 수정 허용: apps/operator-console/src/api.ts, apps/operator-console/src/server.ts, apps/operator-console/src/__tests__/*(신규), .env(로컬, 커밋 금지)
- 수정 금지: packages/sangfor-rag/src/index.ts(엔진), packages/shared/**, prisma/**, 기존 테스트
- 계획과 실제가 다르면 질문 말고 grep/read로 맞추고 보고. 계약 모순이면 BLOCKED.
- 테스트 우회 금지(skip/삭제/ts-ignore/빈 catch 금지).

VERIFY: `pnpm run lint && pnpm test` → 종료 0, 신규 계약 테스트 통과, 기존 432 무회귀. SUB-002는 재임베딩 후 인덱스에 embeddingBackend "hash" 부재.
보고: WORKING / BLOCKED.
```

---

## PR-002 [repo:sangfor-os] — /support/[id] + 관련지식 패널 (Walking Skeleton)
Risk: R2 / Execution: SEQUENTIAL(PR-001 후) / Related REQ: UI-001,002.
Purpose: 엔지니어가 케이스 상세에서 실제 매뉴얼 청크를 보는 가장 얇은 가시 흐름.
Predecessors: PR-001. Successors: 없음.

[출력] CREATE: `apps/web/src/app/(portal)/support/[id]/page.tsx`, `apps/web/src/components/support/related-knowledge-panel.tsx`(서버 or 클라 — ADJ-3). MODIFY: `apps/web/src/app/(portal)/support/page.tsx`(카드에 상세 링크 1줄).
[금지] `packages/business/**`, `packages/infra/**`, `/api/engineer/rag/route.ts`(기존 계약 사용만), prisma/schema.prisma.
[Change Budget] 수정 ≤2 / 신규 ≤2 / 논리 ≤250줄 / Migration 0. ✔
[검증 명령] (sangfor-os) `cd apps/web && npx tsc -p tsconfig.json --noEmit` → exit 0; `cd apps/web && npx eslint .` → exit 0. 통합 스모크(MANUAL-2): dev 서버 + 실제 케이스 id로 `/support/{id}` 렌더 스크린샷(패널에 청크 표시), rag 0건 케이스에서 패널 숨김 확인.
[완료 기준] UI-001/002 구현, 패널이 결과 있으면 표시·없으면 숨김, 케이스 상세는 rag 실패와 무관하게 렌더.

### PR-002-SUB-001 — 케이스 상세 라우트
[대상] CREATE: `support/[id]/page.tsx`. READ_ONLY: `support/page.tsx`(패턴 참고), SupportCase 스키마.
[구현 순서] STEP1 `findUnique({where:{id:params.id}, include:{customer,vendorEscalations}})`, 없으면 `notFound()`. STEP2 케이스 필드 렌더(기존 카드 스타일 재사용). STEP3 `<RelatedKnowledgePanel caseSubject={...} product={...}/>` 삽입.
[계약] 서버 컴포넌트 `async function SupportCaseDetail({params:{id}})`. 404 = `notFound()`.
[검증] `npx tsc --noEmit`(apps/web) exit 0.
[완료] 라우트 존재, 없는 id 404.

### PR-002-SUB-002 — 관련지식 패널
[대상] CREATE: `related-knowledge-panel.tsx`. READ_ONLY: `/api/engineer/rag/route.ts`(계약), `packages/infra/src/engineer-console.ts`(RagHit 타입).
[구현 순서] STEP1 케이스 subject(+reason)로 `/api/engineer/rag`에 POST(서버 컴포넌트면 `engineerConsole.ragSearch` 직접 — ADJ-3) `{query, product, limit:5}`. STEP2 `results`(엔벨로프!) 상위 3개 렌더: title·section·text 발췌(≤200자)·source. STEP3 results 빈배열/오류 → `return null`(패널 숨김).
[계약] props `{caseSubject:string, product?:string}`. 반환: JSX | null. External: `/api/engineer/rag`(PR-001 엔벨로프 계약 의존).
[검증] `npx tsc --noEmit` exit 0.
[완료] 결과 있으면 3청크, 없으면 null.

**디스패치 프롬프트 (PR-002):**
```text
TASK: PR-002 — sangfor-os /support/[id] 상세 + 관련지식 패널

사전 조건: PR-001 머지(응답 엔벨로프 계약). MANUAL-2(operator-console :3502)는 통합 스모크에만 필요, 타입/구현은 무관.

DELIVERABLE:
- 신규/수정 diff
- `cd apps/web && npx tsc -p tsconfig.json --noEmit && npx eslint .` 출력(종료 0)
- (가능 시) /support/{id} 렌더 스크린샷 2장: 청크 표시 / 패널 숨김
- 조정 지점 보고(ADJ-3, ADJ-5, 없으면 "없음")

SCOPE:
- 먼저 읽기: 05-PR-PLAN.md PR-002, 02-REQUIREMENTS ACCEPT-UI-001/002, 03 계약(/support/[id], ADJ-3)
- 수정 허용: apps/web/src/app/(portal)/support/[id]/**(신규), apps/web/src/components/support/**(신규), support/page.tsx(링크 1줄)
- 수정 금지: packages/**, /api/engineer/rag/route.ts, prisma/**
- 빈 패널 금지: 결과 0/오류면 패널 자체를 렌더하지 않는다.
- 계획과 실제가 다르면 grep/read로 맞추고 보고.

VERIFY: apps/web tsc+eslint 종료 0. 관련지식 패널이 results 배열(엔벨로프)을 읽어 상위 3개 렌더, 0건이면 숨김.
보고: WORKING / BLOCKED.
```

---

## PR-003 [repo:sangfor-os] — 도메인 제안 RAG 주입
Risk: R2 / Execution: SEQUENTIAL(PR-001 후, PR-002와 PARALLEL_SAFE — 파일 겹침 없음) / Related REQ: DOM-001,002.
Purpose: engineer 도메인 제안이 RAG 컨텍스트에 근거하게. (engineer 도메인 web 미연결 → 이 PR이 첫 연결, 최소 walking skeleton.)
Predecessors: PR-001. Successors: 없음.
[출력] CREATE: `apps/web/src/app/api/engineer/domain-proposal/route.ts`, `packages/business/src/domain-ai/rag-context.ts`(`assembleRagContext` 순수함수)+test. MODIFY: 없음(기존 스파인 불변).
[금지] `domain-agent-runtime.ts`(스파인 불변 — content 주입만), 게이트 로직, prisma/schema.prisma.
[Change Budget] 수정 0 / 신규 3 / 논리 ≤200줄 / Migration 0. ✔
[검증 명령] `cd packages/business && npx tsc --noEmit && npx vitest run src/domain-ai/rag-context.test.ts` → exit 0; `cd apps/web && npx tsc --noEmit` → exit 0. 통합(MANUAL-2): `POST /api/engineer/domain-proposal {caseId}` → 200 + ragSources.
[완료 기준] DOM-001/002, RAG 실패해도 제안 생성(ragSources:[]).
[SUB 목록] DECOMPOSITION: PENDING — 사유: PR-001의 엔벨로프 실계약과 `runDomainStage` engineer 도메인 실호출 동작(그린필드)을 PR-001·PR-002 랜딩 후 실측해 seam(ADR-003 option B)을 확정한 뒤 DETAIL 분해한다. 현재 카드/계약/검증까지는 확정.

---

## PR-004 [repo:engineer-mcp] — 케이스 해결 → 위키 제안 환류
Risk: R2(R-4) / Execution: SEQUENTIAL(PR-001 후 — server.ts 공유) / Related REQ: FB-001,002.
Purpose: 해결 케이스를 피드백+파일 기반 위키 제안으로 환류(사람 승인 후 반영).
Predecessors: PR-001(server.ts 공유). Successors: 없음.
[출력] CREATE: `apps/operator-console/src/case-resolution.ts`(핸들러) + 라우트 등록(server.ts 1줄) + test. 
[금지] `packages/sangfor-wiki/src/index.ts`(기존 API 사용만), `applyWikiUpdateWithAdapter` 자동 호출 절대 금지, prisma/schema.prisma.
[Change Budget] 수정 ≤1 / 신규 ≤2 / 논리 ≤150줄 / Migration 0. ✔
[검증 명령] `pnpm run lint && pnpm test` → exit 0(신규 핸들러 테스트: propose만 호출·apply 미호출 단정). 통합: `POST /api/case-resolution` → `data/wiki/proposals.jsonl`에 status:"pending"(proposeWikiUpdate 초기값) 1줄.
[완료 기준] FB-001/002, apply/git-push 미발생(테스트로 증명).
[SUB 목록] DECOMPOSITION: PENDING — 사유: `proposeWikiUpdate` 실제 시그니처(ADJ-4)와 operator-console 라우트 등록 관례를 실행 시 확인 후 DETAIL 분해. 카드/계약/안전단정(apply 금지)은 확정.

---

## 요구사항 추적표
| REQ | Acceptance | PR | SUB | 구현 파일 | 검증 명령 | 상태 |
|---|---|---|---|---|---|---|
| PROV-001 | ACCEPT-PROV-001 | PR-001 | SUB-001 | api.ts | pnpm test | PLANNED |
| PROV-002 | ACCEPT-PROV-002 | PR-001 | SUB-001 | api.ts(toPublicHit) | pnpm test | PLANNED |
| PROV-003 | ACCEPT-PROV-003 | PR-001 | SUB-001 | api.ts,server.ts | pnpm test | PLANNED |
| PROV-004 | ACCEPT-PROV-004 | PR-001 | SUB-002 | data/rag/index.json | rag:reembed+검증 | PLANNED(MANUAL-1) |
| UI-001 | ACCEPT-UI-001 | PR-002 | SUB-001 | support/[id]/page.tsx | apps/web tsc | PLANNED |
| UI-002 | ACCEPT-UI-002 | PR-002 | SUB-002 | related-knowledge-panel.tsx | apps/web tsc + 스모크 | PLANNED |
| DOM-001 | ACCEPT-DOM-001 | PR-003 | PENDING | api/engineer/domain-proposal/route.ts | business+web tsc | PLANNED |
| DOM-002 | ACCEPT-DOM-002 | PR-003 | PENDING | domain-ai/rag-context.ts | vitest | PLANNED |
| FB-001 | ACCEPT-FB-001 | PR-004 | PENDING | operator-console/case-resolution.ts | pnpm test | PLANNED |
| FB-002 | ACCEPT-FB-002 | PR-004 | PENDING | (동일) | pnpm test(apply 미호출) | PLANNED |

## ASSUMED 전체 목록
- **ASM-1**: ollama가 OpenAI 호환 `/v1/embeddings`로 nomic-embed 서빙 가능(INFERRED, 실기동 대조 미검증). 근거: sangfor-os M5에서 동일 endpoint 사용. 영향: PROV-004 재임베딩 경로. 롤백: FORCE_HASH.
- **ASM-2**: `/api/rag-search` 유일 HTTP 소비자는 sangfor-os. 근거: mcp-server는 ragSearch() 직접 사용. 영향: 엔벨로프 변경 안전성. 롤백: 양립 응답. (ADJ-1로 실행 시 확정)
- **ASM-3**: engineer 도메인 키 `"engineer"`가 GtmDomain에 존재. 영향: PR-003. 확인: ADJ-5.
- **ASM-4**: web `apps/web`이 `@sangfor/infra` 의존(서버에서 engineerConsole 직접 호출 가능). 근거: sangfor-os apps/web/package.json:20-26. 영향: ADJ-3 패널 데이터 경로.

## REVIEW LOG

### 기계 검사 (2026-07-12, 실행됨)
- 모호어: 1건 검출 → "나머지는 정상 렌더"의 오탐, 문구 정정으로 0건.
- TBD/TODO/FIXME: 0건.
- DECOMPOSITION: PENDING: 2건(PR-003, PR-004) 전부 사유 동반.
- 명령 실존: engineer-mcp 참조 명령 전부 package.json 실존. `pnpm typecheck`는 sangfor-os측 명령(cross-repo)으로 정상(root `pnpm -r typecheck`).

### 적대적 리뷰 (fresh 서브에이전트, 체크리스트 대조) — 소견 7건, 전부 조치
| Finding | Sev | 문제 | 조치 |
|---|---|---|---|
| F-1 | CRITICAL | 위키 제안 초기 상태를 `"proposed"`로 못박음 — 실제 enum은 `pending`이고 `proposeWikiUpdate`가 `pending` 하드코딩, PR-004는 sangfor-wiki 수정 금지라 인수 충족 불가 | `"proposed"`→`"pending"`으로 02·03·05 전부 정정, 라이프사이클 `pending→approved→applied`로 수정 |
| F-2 | HIGH | PR-001·PR-004가 같은 `server.ts` 편집인데 "겹침 없음·PARALLEL_SAFE"라 거짓 → File Ownership 충돌 | PR-004를 SEQUENTIAL(PR-001 후), Predecessors=PR-001, 그래프 노트에 server.ts 공유 명시 |
| F-3 | MEDIUM | 03("직접호출 금지")과 05("직접호출")이 패널 데이터 경로에서 모순 | 서버 컴포넌트 직접 호출로 확정, 03·ADJ-3 정정(05와 일치) |
| F-4 | MEDIUM | 400 검증을 비관용 sentinel(`__status`)로 설계 — server.ts는 `error(res,...)` 관용구 사용 | STEP2/4를 server.ts의 `error(res,"query is required")`(기본 400) 관용구로 재작성 |
| F-5 | LOW | `proposeWikiUpdate` 인자 표기 오류(`{targetPage,title,afterText}`) | 실제 `{lessonTitle,lessonBody,targetPage}`로 03 정정 |
| F-6 | LOW | sangfor-wiki 라인 인용 ~10줄 드리프트 | 01 A4 라인 근사치+ADJ-4 주석으로 정정 |
| F-7 | LOW | `persistFeedbackEvent` 전 필드 필수인데 sourceRole 선택 표기 | 03에 `sourceRole ?? "engineer"` 기본값 명시 |

**결과: CRITICAL 0 / HIGH 0** (F-1·F-2 정정 완료). MEDIUM/LOW도 결과 분기 방지 위해 전부 정정. 납품 가능.
