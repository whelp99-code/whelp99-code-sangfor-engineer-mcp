# 04 — Risks · Tier

## 티어 판정 (PHASE 06 — 근거 수치)
| 지표 | 수치 | 근거 |
|---|---|---|
| MUST 요구 | 9 (PROV-001~004, UI-001~002, DOM-001, FB-001~002) | 02-REQUIREMENTS |
| 예상 변경/신규 파일 | ~18 (제공자 3-4, 소비자 UI 3-4, 도메인 3, 환류 2-3, 테스트 4-5) | 05-PR-PLAN |
| Migration | 0 (ADR-004/005) | — |
| 저장소 | 2 (cross-repo) | 00-INTAKE |

**판정: L.** MUST 9(>3), 파일 ~18(>5), cross-repo·UI 그린필드·임베딩 재생성·게이트 write. Migration 0이라 XL은 아님.
**문서 세트 축소 근거**: L이지만 단일 통합 계획(4 PR)이라 `prs/PR-{NNN}/` 개별 폴더 대신 **M 6파일 구조 + PR-001만 DETAIL 인라인(05)** 으로 축소. 이유: 실행 에이전트가 한 디렉터리에서 통합 전체를 읽는 게 cross-repo 이해에 유리. 나머지 PR은 롤링웨이브(PR-002 SUB, PR-003/004 PENDING+사유).

## 위험 (P×I×D, D=5는 탐지 어려움)

| Risk ID | 위험 | P | I | D | 점수 | 등급 | 예방 | 복구 |
|---|---|---:|---:|---:|---:|---|---|---|
| R-1 | 계약 불일치 미해소로 통합이 조용히 빈 결과(results undefined) | 4 | 4 | 4 | 64 | R3 | PR-001에서 엔벨로프 정합 + ACCEPT-PROV-001 배열/객체 단정 테스트; 소비자에 통합 스모크 | `postRagSearch` revert, 소비자 언랩 임시 |
| R-2 | ollama 미도달로 rag:reembed가 hash 폴백(조용히) → 품질 개선 실패인데 성공처럼 보임 | 3 | 4 | 5 | 60 | R3 | ACCEPT-PROV-004가 `embeddingBackend!="hash"`를 명시 단정(폴백=인수 실패); `check:embedding-providers` 선행 | `SANGFOR_EMBEDDING_FORCE_HASH=1` 재임베딩으로 원복 |
| R-3 | 차원 혼합(384 hash ↔ 768 nomic)으로 코사인 0 → 검색 무력화 | 3 | 4 | 3 | 36 | R3 | rag:reembed는 전 청크 in-place 재임베딩(부분 금지); 재임베딩 후 backend 균일성 검증 | 전 인덱스 재임베딩(한 backend로 통일) |
| R-4 | 위키 어댑터 git push가 자동 실행돼 되돌리기 어려운 원격 변경 | 2 | 5 | 3 | 30 | R2 | REQ-FB-002: 제안 생성까지만, apply는 HMAC 승인 MANUAL; 라우트는 propose만 호출 | 원격 wiki revert(수동) |
| R-5 | RAG 청크에 고객 PII/시크릿 포함된 채 UI/로그 노출 | 2 | 4 | 4 | 32 | R2 | 코퍼스는 제품 매뉴얼(고객 데이터 아님, CONFIRMED sourceType=manual); 벡터 스트립(REQ-PROV-002); 로그에 text 전문 미기록 | 해당 청크 인덱스 제거 후 재적재 |
| R-6 | engineer 도메인 web 미연결이라 PR-003 그린필드가 예상보다 큼 | 3 | 3 | 2 | 18 | R2 | PR-003을 "1케이스 walking skeleton"으로 최소화(runDomainStage 1회 호출 + content 주입); 확장은 후속 | 라우트 미배선 상태로 되돌림(PR-002 UI는 독립 동작) |
| R-7 | `/api/rag-search` 다른 소비자 존재로 엔벨로프 변경이 그들을 깨뜨림 | 2 | 3 | 3 | 18 | R2 | ADJ-1: 실행 전 grep으로 소비자 전수; 있으면 함께 갱신 | 엔벨로프+bare 양립 응답(임시) |
| R-8 | 재임베딩 중 인덱스 손상(중단 시 부분 write) | 2 | 4 | 3 | 24 | R2 | rag:reembed 실행 전 `data/rag/index.json` 백업; 스크립트가 원자적 write인지 확인(ADJ) | 백업 복원 |

## R3 실패 모드 (36점 이상)

### R-1 (계약 불일치)
- Trigger: 소비자가 `result.results`를 읽는데 제공자가 bare 배열 반환.
- Failure: `results` undefined → UI 패널이 "결과 0건"으로 오인 → 항상 숨김. 조용한 실패.
- Detection: ACCEPT-PROV-001(응답이 객체이고 `.results` 배열인지 단정), 소비자 통합 스모크(`/support/[id]`에서 청크 렌더 확인).
- Recovery: `postRagSearch` 엔벨로프 revert 또는 소비자에 bare-array 언랩 폴백 추가.

### R-2 (조용한 hash 폴백)
- Trigger: ollama 미기동인데 rag:reembed 실행.
- Failure: provider 헬스체크 타임아웃 → hash 폴백 → 인덱스 여전히 hash인데 스크립트는 exit 0.
- Detection: ACCEPT-PROV-004가 재임베딩 후 `embeddingBackend!="hash"`를 필수 단정 → 폴백 시 인수 실패. 실행 에이전트는 이때 BLOCKED(MANUAL-1) 보고.
- Recovery: ollama 기동 후 재실행. 원복은 FORCE_HASH.

### R-3 (차원 혼합)
- Trigger: 일부만 재임베딩되고 일부는 옛 384d hash 잔존.
- Failure: `cosineSimilarity`가 길이 불일치로 0 반환(sangfor-os 동일 로직 확인됨) → 검색 무력.
- Detection: 재임베딩 후 전 청크 `vectorDims` 균일성 확인(하나의 dim만 존재).
- Recovery: 전 인덱스 단일 backend 재임베딩.

## 필수 검토 목록 점검
- 인증 우회: `/api/engineer/domain-proposal`·`/support`는 assertApiAccess/세션 게이트(REQ). rag-search는 SANGFOR_API_TOKEN(미설정 시 no-op — 로컬 전제). ✔
- SSRF: 소비자→제공자 base URL은 env 고정(WHELP99_OPERATOR_CONSOLE_URL), 사용자 입력 URL 없음. ✔
- Secret 노출: 벡터 스트립·매뉴얼 코퍼스·로그 text 미기록. ✔
- 외부 API 실패: rag 502 → 삼키고 패널 숨김/제안 계속(ACCEPT-UI-002, DOM-001 실패경로). ✔
- 데이터 손실: 재임베딩 전 인덱스 백업(R-8). ✔
- 기존 회귀: 각 PR 검증 명령이 기존 테스트 무파괴 요구(05). ✔
