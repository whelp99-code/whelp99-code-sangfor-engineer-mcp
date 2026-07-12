# 02 — Requirements · Acceptance

1 요구 = 1 관찰 결과. MUST 전부에 Given–When–Then(정상+실패). 우선순위 P0(차단)~P4.

## 제공자 (engineer-mcp)

### REQ-PROV-001 — rag-search 응답 엔벨로프 정합
Priority P0 / MUST. Actor: sangfor-os 소비자. Trigger: `POST /api/rag-search`. Input: `{query,product?,version?,limit?}`. Processing: `ragSearch()` 결과를 `{query, results}` 엔벨로프로 감싸 반환. Output: `{query:string, results:RagHitPublic[]}`. State Change: 없음(read). Failure: 검색 예외 시 500 대신 표준 오류(REQ-PROV-003과 별개는 아님). Acceptance: ACCEPT-PROV-001. Excluded: 소비자 측 변경(제공자만 수정). Dependencies: 없음.

### REQ-PROV-002 — 응답에서 원본 벡터 스트립
Priority P1 / MUST. 각 hit에서 `vector`(및 `contentHash` 등 내부 필드) 제거, 소비자가 쓰는 필드만 노출: `{id, product, version?, title, section?, text, trustLevel, score, rerankScore?, source(filePath 유래)}`. Acceptance: ACCEPT-PROV-002.

### REQ-PROV-003 — 빈 query는 400
Priority P1 / MUST. query 누락/빈문자 → HTTP 400 `{error:{code:"VALIDATION_ERROR", message}}`(현재 500). Acceptance: ACCEPT-PROV-003.

### REQ-PROV-004 — 실 임베딩 재생성
Priority P0 / MUST. `data/rag/index.json`의 전 청크를 실 시맨틱 임베딩(ollama nomic-embed)으로 재생성, `embeddingBackend != "hash"`, `index.version` bump. Acceptance: ACCEPT-PROV-004. Dependencies: MANUAL-1(ollama 기동, `03-ARCHITECTURE-CONTRACTS.md` §MANUAL).

## 소비자 (sangfor-os)

### REQ-UI-001 — 케이스 상세 라우트
Priority P0 / MUST. `/support/[id]` 서버 컴포넌트 신설, 케이스 필드(subject/severity/status/customer/slaDeadline/vendorEscalations) 렌더. 없는 id → notFound(404). Acceptance: ACCEPT-UI-001.

### REQ-UI-002 — 관련 지식 패널
Priority P0 / MUST. 케이스 상세에서 `subject`(+ vendorEscalation.reason 있으면 결합)로 `/api/engineer/rag` 조회 → 상위 3개 청크(title/section/text 발췌 + source) 렌더. 결과 0건 또는 조회 실패 → **패널 숨김**(빈 패널 금지). Acceptance: ACCEPT-UI-002 (정상+실패).

### REQ-DOM-001 — 도메인 제안에 RAG 주입
Priority P1 / MUST. web 라우트 `POST /api/engineer/domain-proposal`가 케이스로 engineer 도메인 제안을 생성하되, 생성 전에 `engineerConsole.ragSearch`로 얻은 상위 청크를 `DomainCase.content`에 주입(스파인·게이트 로직 불변). 응답에 제안 + 주입된 RAG 출처 목록. Acceptance: ACCEPT-DOM-001.

### REQ-DOM-002 — RAG 컨텍스트 조립 순수 함수
Priority P2 / SHOULD. `assembleRagContext(hits, opts)` 순수 함수를 business에 추가(infra import 없이 hits 배열 → 프롬프트 텍스트). 유닛 테스트. Acceptance: ACCEPT-DOM-002.

## 환류 (engineer-mcp)

### REQ-FB-001 — 해결 케이스 → 피드백 + 위키 제안
Priority P1 / MUST. 케이스 해결책 입력으로 `persistFeedbackEvent`(피드백 이벤트) + `proposeWikiUpdate`(파일 기반 위키 제안, `data/wiki/proposals.jsonl`) 생성. operator-console에 `POST /api/case-resolution` 신설. Acceptance: ACCEPT-FB-001.

### REQ-FB-002 — 위키 제안은 자동 반영 금지 (fail-closed)
Priority P0 / MUST. 제안 생성은 `proposeWikiUpdate`의 초기 상태 `status:"pending"`까지만(코드가 하드코딩, sangfor-wiki/src/index.ts). 실제 위키 write(`applyWikiUpdateWithAdapter`, git push 포함)는 `SANGFOR_WIKI_APPROVAL_SECRET` HMAC 승인 없이는 실행 안 됨. Acceptance: ACCEPT-FB-002 (실패 경로).

---

## 인수 기준 (Given–When–Then)

### ACCEPT-PROV-001 (REQ-PROV-001)
- Given operator-console 기동(:3502), 인덱스에 chunk 존재
- When `POST /api/rag-search {query:"IAG 802.1X"}`
- Then 200 And 본문이 `{query, results:[...]}` 객체(배열 아님) And `results`는 배열
- **실패경로**: Given 검색 내부 예외 / When 동일 요청 / Then 500 표준 오류 And 응답이 bare 배열이 아님

### ACCEPT-PROV-002 (REQ-PROV-002)
- Given 인덱스 chunk 존재 / When rag-search 호출 / Then 각 result에 `vector` 키 없음 And `text`·`score`·`source` 존재
- **실패경로**: Given result에 벡터가 없어야 하는데 있으면 / Then 계약 위반(테스트 실패로 검출)

### ACCEPT-PROV-003 (REQ-PROV-003)
- Given 기동 / When `POST /api/rag-search {}`(query 없음) / Then **400** And `{error.code:"VALIDATION_ERROR"}` And ragSearch 미호출
- **실패경로**: Given query가 공백문자열 " " / When 호출 / Then 400 (500 아님)

### ACCEPT-PROV-004 (REQ-PROV-004)
- Given ollama가 `nomic-embed-text` 서빙(:11434), `SANGFOR_EMBEDDING_PROVIDER`가 ollama로 지정
- When `pnpm run rag:reembed`
- Then 종료 0 And 재작성된 `data/rag/index.json`의 모든 chunk `embeddingBackend != "hash"` And `version >= 2`
- **실패경로**: Given ollama 미도달 / When rag:reembed / Then provider 헬스체크 실패로 hash 폴백 → chunk가 여전히 hash → **인수 실패로 검출**(억지 통과 금지); 이 경우 MANUAL-1 미충족으로 BLOCKED 보고

### ACCEPT-UI-001 (REQ-UI-001)
- Given 존재하는 caseId / When `/support/{id}` 방문 / Then 200 And subject·severity·customer 렌더
- **실패경로**: Given 없는 id / When 방문 / Then 404(notFound)

### ACCEPT-UI-002 (REQ-UI-002)
- Given 케이스 상세, rag가 ≥1 청크 반환 / When 페이지 로드 / Then "관련 지식" 패널에 상위 3개 청크 title+발췌+source 표시
- **실패경로 1**: Given rag가 0건 반환 / Then 패널 미렌더(빈 패널 없음)
- **실패경로 2**: Given `/api/engineer/rag` 502 / Then 패널 미렌더 And 케이스 상세 본문은 정상 렌더(패널만 숨김)

### ACCEPT-DOM-001 (REQ-DOM-001)
- Given 케이스 + rag ≥1 청크 / When `POST /api/engineer/domain-proposal {caseId}` / Then 200 And 제안 텍스트 존재 And 응답 `ragSources`에 주입된 청크 출처 ≥1 And 서버 로그/응답에 RAG 컨텍스트가 프롬프트에 포함됐음이 관측됨
- **실패경로**: Given rag 0건 또는 502 / When 호출 / Then 200 And 제안은 생성됨(RAG 없이) And `ragSources:[]` (RAG 실패가 제안 생성을 막지 않음)

### ACCEPT-DOM-002 (REQ-DOM-002)
- Given hits 배열 / When `assembleRagContext(hits,{maxChunks:3})` / Then 상위 3개만 포함한 문자열 And 각 청크 출처 라벨 포함
- **실패경로**: Given 빈 배열 / Then 빈 문자열 반환(throw 안 함)

### ACCEPT-FB-001 (REQ-FB-001)
- Given operator-console 기동 / When `POST /api/case-resolution {product, caseSummary, resolution, targetWikiPage}` / Then 200 And `data/wiki/proposals.jsonl`에 새 제안(`status:"pending"` — proposeWikiUpdate 초기값) 1줄 추가 And 피드백 이벤트 기록 시도(DB 없으면 no-op, 오류 아님)
- **실패경로**: Given 필수 필드 누락 / Then 400 VALIDATION_ERROR And 제안 미생성

### ACCEPT-FB-002 (REQ-FB-002)
- Given 위키 제안 존재, `SANGFOR_WIKI_APPROVAL_SECRET` 미설정 또는 잘못된 HMAC / When 적용 시도 / Then 거부(적용 안 됨) And git push 미발생
- **정상경로**: Given 올바른 HMAC 승인 / When 적용 / Then 어댑터로 write(사람이 수행하는 MANUAL 단계 — 자동 안 함)
