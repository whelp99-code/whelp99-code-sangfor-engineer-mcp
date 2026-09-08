# 1차 수정안: 판정·최신성·검색 정확성 인수

GitHub 실행 단위: [#77](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/77). 프로그램 #30의 구현 보완이며 현장 인수 #47, #58, #59, #67–#73을 닫는 증거가 아니다.

## 적용 범위와 결정

로컬 기준 `9c8ea4f`에 원격 `9bd77697577a0906c38055fb97525cad1e91376c`를 별도 `codex/revision-v1` 작업 트리에서 통합했다. 원본 작업 폴더의 미추적 파일·자료·색인은 보존했다.

첨부 `004-rag-open-source-adoption-review-REVISED.md`의 기존 결함 수정, 기존 검색 기준선 확보, 외부 OSS 조사 분리 원칙을 적용한다. Haystack 또는 LightRAG를 이미 선정한 엔진으로 취급하지 않는다. 기존 B3의 모델 비교·출처·버전·고객 경계 결함은 그대로 수정 대상이다. 첨부의 시간·성능 수치는 실측 운영 SLO로 승격하지 않는다. 외부 엔진 도입·BLRO 배포·고객 장비 변경은 이번 구현에 포함하지 않는다.

## 변경 계약

| 영역 | 변경 후 동작 | 근거 |
| --- | --- | --- |
| 권한 목록 | IAG 비밀 접근의 실제 소유 함수 `evaluateIagEvidenceBootstrap`를 등록한다. RAG 삭제는 기존 파생 데이터 소유권 안에 등록한다. | authority manifest/lock 회귀 |
| HCI 수집 | 각 surface의 complete/partial/failed/unknown을 반환한다. HTTP 실패·잘못된 응답·미수집 다음 페이지를 빈 정상 목록으로 바꾸지 않는다. | `hci-inventory-completeness.test.ts` |
| HCI 건강 | 명시적 PASS/FAIL/INDETERMINATE와 volume-status 범위를 반환한다. `healthy`는 PASS에만 true다. 빈 환경은 기대 상태와 완전한 수집이 함께 있어야 스냅샷 PASS다. | `hci-ops-monitor.test.ts`, 수집 회귀 |
| 현재와 과거 | 일반 라이브러리의 기본 `comparison`은 값 비교이며 현재 최신성을 보장하지 않는다. MCP `sangfor_evaluate_config`는 기본 current다. snapshot은 명시적 평가 시각이 필요하다. | `spec-freshness.test.ts`, `spec-assessment-tool.test.ts` |
| 최신성 | current PASS에는 항목 `maxAgeSec`, 수집 완료, 유효한 수집·평가 시각이 필요하다. 미래·기한 초과·부분 수집은 판정 불가다. 확인된 FAIL은 유지한다. | 동일 회귀 및 provenance/report 회귀 |
| HCI 현재 판정 | MCP health는 current로 평가한다. `SANGFOR_HCI_VOLUME_MAX_AGE_SEC`가 없으면 정상으로 확정하지 않는다. 순수 요약 함수 기본은 수집 스냅샷이며 보고서에 명시한다. | HCI 수집 회귀 |
| 임베딩 | 모델·고정 revision·차원·정규화·전처리·질의/문서 prefix가 모두 일치해야 벡터를 비교한다. 같은 차원만으로 비교하지 않는다. | `rag-embedding-space.test.ts` |
| 대체 검색 | 미확인 공간·임베딩 장애는 BM25다. 각 hit의 `retrievalMode`와 `vectorScoreUsed`로 공개하고 UI에도 표시한다. 진단은 결과 배열별로 보존한다. | diagnostics/search-contract 회귀 |
| 고객 및 자료 범위 | 제품·정확한 버전·sourceType·trustLevel·고객 범위·ACL을 ranking 전에 적용한다. 버전 미상은 버전 지정 검색에서 제외한다. | embedding-space 및 기존 scoped/pgvector 회귀 |
| 문서 생명주기 | 같은 파일의 개정·메타데이터 변경은 기존 청크를 교체한다. 삭제는 파생 색인만 제거한다. 원본 자료는 삭제하지 않는다. | `rag-document-lifecycle.test.ts` |
| 재임베딩 | 기존 청크와 출처·신뢰도·ID를 보존하면서 벡터만 새로운 후보 파일에 기록한다. 같은 경로·기존 후보 덮어쓰기를 거부한다. raw 디렉터리에서 문서를 새로 추측하지 않는다. | `rag-reembed-cli.test.ts` |
| 검증 환경 | PG_BINDIR가 유효하면 전체 홈 탐색 없이 사용한다. UI fixture에 local authority를 명시한다. CI에 실제 Chromium과 구조 경계 검사를 추가한다. | PostgreSQL runner 회귀, 실제 Chromium UI |

현재 제품별 승인된 수집 주기·허용 지연은 제공되지 않았다. [항목별 정책 현황](../references/revision-v1/freshness-policies.json)의 null은 설정 필요를 뜻한다. 과거 pooled 수집 간격의 중앙값을 제품 운영 정책으로 대입하지 않았다. 운영자가 수집 주기, 허용 지연, 필수 관측값과 시각 출처를 승인한 뒤 제품/버전 spec의 `maxAgeSec` 및 HCI 환경 설정을 채워야 현재 PASS를 사용할 수 있다.

호환성 변경: 과거 값 비교의 PASS를 현재 상태의 PASS로 사용하던 호출자는 `assessment.mode`를 확인해야 한다. legacy 임베딩은 revision을 추정하지 않으므로 BM25로 검색된다. 의미 검색을 사용하려면 실제 모델 artifact에 대응하는 `SANGFOR_EMBEDDING_MODEL_REVISION`을 고정하고 후보 재임베딩·평가를 거친다. `rag:reembed`의 세 번째 raw-dir 위치는 호환 목적으로 예약되며 문서 수집에는 쓰지 않는다. 출력은 기본 `<index>.candidate.json`이다.

## 실제 문서 기준선

원본 66,767청크, 384차원, 의미 모델 2개와 hash가 혼재한다. 임베딩 공간 증명은 0건, 버전 메타데이터는 4청크뿐이다. 따라서 이번 측정은 명시적 BM25 기준선이다. 임베딩 서비스·외부 LLM·reranker를 호출하지 않았다.

원본 전체 크기 때문에 통합된 공통 64MiB JSON envelope가 `source_too_large`로 거부하는 문제를 실제 재현했다. RAG에 한해 320MiB/2,000,000노드의 유한한 envelope를 선언했다. 엄격한 스키마, 위험한 객체 키, 깊이, 배열 크기, 100,000청크, 중복 ID 검사는 유지한다. 이 규모를 넘으면 기존 shard/DB 경로를 평가해야 한다. 66,767개 원본 전체를 이 경계로 읽고 검색한 결과가 아래에 남는다.

최종 평가 v2는 기존 issue-15의 21개 양성 질문과 4개 버전 부정 질문을 사용한다. 질문·정답·기존 임계값은 유지하고 HCI와 SCP를 혼동한 6개 제품 필터를 원문으로 바로잡았다. 통합 코드의 NGFW/SCC 분류를 유지한 [고정 qrels v2](../../data/evals/rag/revision-v1-qrels-v2.json)를 후보 실행 전에 확정했다.

정정 기록: 최초 v1은 구형 색인의 front matter를 그대로 따라 NGFW/SCC 질문도 OTHER로 바꿨다. 통합 registry에는 NGFW/SCC가 이미 존재하므로 v1은 구형 데이터의 탐색 기록으로만 보존한다. v1의 결과나 qrels를 덮어쓰지 않고 v2를 추가했으며, 아래 최종 비교는 동일한 v2 질문을 원본과 후보 양쪽에 적용한 것이다. 임계값을 결과에 맞춰 바꾸지 않았다.

| 측정 | 보정된 기존 검색 / 원본 색인 | 원문 기반 분류 후보 v2 |
| --- | --- | --- |
| Recall@5 / HitRate@5 | 0.6190 / 0.6190 | 0.7143 / 0.7143 |
| MRR@5 | 0.4286 | 0.5000 |
| nDCG@5 | 0.4758 | 0.5535 |
| 버전 부정 질의 반환 | 0/4 | 0/4 |
| 평균 / p95 검색 지연 | 180.6ms / 374.0ms | 204.9ms / 373.9ms |
| 최초 색인 로드 | 2442.7ms | 2429.6ms |

[원본 결과 v2](../references/revision-v1/rag-baseline-v2.json), [후보 결과 v2](../references/revision-v1/rag-candidate-v2.json), [색인 감사 v2](../references/revision-v1/corpus-audit-v2.json)에 원본·qrels 해시, 환경, 질의별 결과와 지연을 보존했다. 단일 실행 지연은 운영 p95 SLO가 아니며 통제된 QA 표본은 현장 사용자 평가나 충분한 제품별 대규모 평가를 대체하지 않는다. 기존 HitRate@5 0.85 목표에 미달하므로 후보는 **NOT_PROMOTED**다. 다른 엔진의 성능 우위를 주장하지 않는다.

원문 sourceUrl의 정확한 product_id와 제목을 함께 확인한 2,576개 문서, 8,385청크를 후보에서 재분류했다. NGFW 8,200청크, SCC 184청크, SCP 지원 사례 1청크다. [전체 근거 매핑](../references/revision-v1/reclassification-v2.json)에 원문 경로·해시·URL·제목·변경 전후 제품을 기록했다. 원본 색인과 원문은 변경하지 않았다. VDI/SASE 등 미등록 제품이나 불확실한 자료는 OTHER로 유지하여 후보에도 OTHER 35,547청크가 남는다.

이번 표본에서 분류 정비만으로 Recall@5가 9.52%p 증가했다. 원문 기반 버전 추출, 한국어 회수 품질, 고정 revision 의미 검색과 로컬 reranker를 다음 품질 개선 항목으로 둔다. 외부 OSS는 이 기준선과 동일한 질문·출처·권한·인덱싱 비용·삭제 재현성으로 비교한 뒤 결정한다. 최초 [v1 결과](../references/revision-v1/rag-baseline.json)와 [v1 후보](../references/revision-v1/rag-candidate.json)는 감사 이력으로 남긴다.

재현 명령:

```bash
TMPDIR=/short/task-tmp pnpm --silent run rag:eval:corpus /path/to/index.json data/evals/rag/revision-v1-qrels-v2.json
```

원문과 대형 후보 색인은 로컬 자료로 유지한다. 후보 생성 시 전체 근거 매핑의 sourceSha256을 원문과 확인하고 일치하는 filePath의 product만 수정한다. 커밋된 결과에는 문서 본문·벡터·고객 비밀을 포함하지 않는다.

## 역량과 추적 상태

| 영역 | 구현 | 자동 검증 | 실장비 | 운영 적용 |
| --- | --- | --- | --- | --- |
| HCI 관측·판정 | 수정 구현 | 로컬 회귀 | 이번 변경으로 미실행 | 미배포; TTL 설정 필요 |
| IAG 승인·단일 dispatch·독립 readback | 원격 기존 구현 통합 | 기존 안전 회귀 및 필수 PG 프로필 | #47/#59의 현장 조건 유지 | 이번 작업으로 미승격 |
| 증거·권한·역량 승격 | 기존 fail-closed 구현 통합 | manifest/active evidence/nonce 회귀 | 현장 증거가 없으면 미확인 | 대체율을 추정하지 않음 |
| RAG | 공간 분리·필터·수정/삭제 구현 | 실제 원본 평가 및 회귀 | 검색 QA 표본만 측정 | 후보 NOT_PROMOTED |
| Control Tower | 기존 구현 + UI fixture 보완 | 실제 Chromium UI | 이번 작업으로 미실행 | 미배포 |

실제 stdio inventory는 118개(쓰기 분류 54, destructive 분류 8)다. 분류는 실제 장비 쓰기 허용을 뜻하지 않는다. GitHub 부모 #30에 누락돼 있던 보조 구현 #75와 이번 #77을 명시적으로 연결했다. 기존 43개 핵심 인수 작업을 바꾸거나 현장 이슈를 닫지 않고 live tracker 45개 자식 검증을 통과했다.

## 검증 및 남은 인수

로컬 Node 24.19.0 / pnpm 10.28.1. `/tmp` quota와 긴 Unix 소켓 경로를 피하기 위해 짧은 전용 TMPDIR를 사용한다. Ubuntu 26.04에서는 Playwright가 제공하는 Ubuntu 24.04용 matching Chromium 1223으로 UI를 실행했다. 테스트의 게이트나 판정 assertion은 완화하지 않았다.

최종 로컬 회귀와 해당 커밋의 Node 22/24 및 PostgreSQL 16 + pgvector 0.8.1 CI 결과는 PR 검증 기록에 연결한다. 기본 테스트의 환경 의존 제외는 필수 PostgreSQL 완료를 대신하지 않는다. 로컬 PG에는 pgvector 0.8.1이 준비되지 않아 실제 DB 검증은 CI의 격리된 필수 프로필에서 수행한다.

후속 C/D 조건: 승인된 IAG 장비·firmware·작업 창·세 번의 사이클, 개별 서명·단일 dispatch·독립 readback, 별도 원복 승인, 증거 승격 검토, 원격 실제 토폴로지의 장애·복원, 배포·운영 수집 SLO 인수가 필요하다. 전체 16/16 대체율·현장 완료·운영 자동 배포를 이번 수정 완료와 동일시하지 않는다.

로컬 최종 검증: `TMPDIR=/home/jm/.cache/sfr-v1-tmp pnpm test --maxWorkers=2`가 411파일 / 3,149개 통과, 15파일 / 97개 환경 의존 제외로 종료했다. lint, MCP smoke(118개), live inventory(118/54/8), live tracker(45개 자식), browser/data 경계와 hygiene가 통과했다. CI와 브라우저/DB 환경별 결과는 해당 PR의 검사 기록이 정본이다.
