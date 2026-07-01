# Sangfor Engineer MCP — 프로젝트 종합 아키텍처 문서

> 작성일: 2026-07-01
> 대상 커밋: `c15ad49` (branch `chore/standalone-adoption`)
> 범위: `apps/*`, `packages/*`, `prisma/`, `scripts/`, 빌드/배포 설정 전체를 코드 단위로 분석한 결과

---

## 1. 개요 (Executive Summary)

`sangfor-engineer-mcp`는 Sangfor 보안/인프라 제품군에 대한 **"제품 특화 시니어 엔지니어" MCP 서버**다.
고객 요구사항(또는 ITAC 감사 체크리스트 Excel)을 입력받아 → 제품별 설정 변경 계획을 생성하고 →
위험도 분류 및 승인 게이트를 적용하고 → (mock/lab/실장비) 콘솔을 Playwright로 조작하며 →
근거(evidence) 리포트, 운영/설정 가이드(DOCX/PPTX)를 산출하고 →
지식(RAG)·위키·피드백·파인튜닝 파이프라인으로 학습을 누적하는 통합 시스템이다.

**우선순위 제품 (README 기준):** HCI → IAG → Endpoint Secure → Cyber Command

**핵심 설계 철학:**
1. **Dry-run 기본값(safe-by-default)** — 모든 변경은 기본적으로 미리보기만 수행.
2. **다중 환경변수 게이트** — 실제 실행은 `SANGFOR_ALLOW_REAL_EXECUTION`, 운영은 `SANGFOR_ALLOW_PRODUCTION_EXECUTION` 필요.
3. **승인 페이로드 강제** — 고위험 작업은 `approvedBy`/`approvalToken`/`changeTicketId`/`rollbackPlanId` 4개 필드 모두 요구.
4. **읽기 전용 스냅샷** — 설정 수집은 항상 `{ readOnly: true, mutationBlocked: true }`.
5. **휴먼-인-더-루프** — 피드백→레슨→위키 제안은 사람 검토 후에만 반영(`pending_review`).
6. **로컬 우선(local-first)** — RAG/임베딩은 로컬 우선, 클라우드는 `SANGFOR_ALLOW_CLOUD_RAG=1` 게이트.

---

## 2. 기술 스택 & 모노레포 구조

| 항목 | 내용 |
|------|------|
| 언어 | TypeScript (ESM, `"type": "module"`), Node 20/22 |
| 패키지 매니저 | **pnpm 10.28.1** (workspace) — `npm`도 가능하나 비권장 |
| 런타임 실행 | `tsx` (소스 직접 실행, 빌드 산출물 아닌 TS 그대로) |
| 핵심 의존성 | `@modelcontextprotocol/sdk`, `@prisma/client`, `playwright`, `pdf-parse`, `zod`, `pptxgenjs` |
| 테스트 | Vitest (`tests/*.test.ts`, 10개 스위트) |
| DB | PostgreSQL (Prisma) — 선택적(없으면 graceful degrade) |
| 코드 규모 | apps ≈ 1,263줄 / packages ≈ 8,823줄 (TS) + 55개 scripts |

**워크스페이스 (`pnpm-workspace.yaml`):** `apps/*`, `packages/*`

```
apps/
  mcp-server/          MCP stdio JSON-RPC 서버 (핵심 진입점, 도구 레지스트리)
  http-bridge/         stdio MCP를 REST로 감싸는 브리지 (port 3600)
  operator-console/    웹 UI + REST API 대시보드 (port 3502/3500)
  mock-sangfor-console/ 가짜 HCI 콘솔 (port 3400, 테스트용)
packages/
  shared/              공통 타입/유틸 (모든 패키지의 기반)
  sangfor-planner/     프로젝트 분석 + 설정 계획 생성
  sangfor-approval/    텍스트/액션 위험도 분류 + 승인 판정
  sangfor-verifier/    계획 검증 + 실장비 라이브 검증(Chrome)
  sangfor-evidence/    근거 리포트(Markdown/JSON) 생성
  sangfor-evals/       플래너 회귀 평가(품질 게이트)
  sangfor-feedback/    피드백 수집 + 레슨 추출
  sangfor-operator/    operator 세션 + mock/live 콘솔 조작
  sangfor-chrome/      Chrome CDP 생명주기 + 로그인/메뉴/폼/OCR
  sangfor-screenshot/  제품 콘솔 스크린샷 자동 수집
  sangfor-collector/   KB/커뮤니티 수집 + ONE OAuth + 학습 파이프라인
  sangfor-rag/         임베딩 제공자 + 벡터 인덱스 + RAG 검색/리랭크
  sangfor-knowledge/   시드 지식(매뉴얼/운영절차/제품가이드)
  sangfor-wiki/         위키 검색 + Obsidian/GitHub 어댑터
  sangfor-store/        Prisma 영속화(graceful degrade)
  sangfor-finetune/     파인튜닝 데이터셋/잡 + 시크릿 차단 검증
  sangfor-product-adapters/ 제품 콘솔 디스커버리 + Excel + 변경계획 + DOCX
  sangfor-pptx/         PPTX 가이드 생성
prisma/                schema.prisma (10개 모델)
scripts/               55개 운영/학습/수집/캡처 스크립트
```

---

## 3. 컴포넌트 아키텍처 (런타임 토폴로지)

```
                    ┌──────────────────────────────────────┐
  Cursor/Claude ───▶│  apps/mcp-server (stdio JSON-RPC)     │  ← 36개 sangfor.* 도구
   (MCP client)     │  readline 루프, tools/list, tools/call│
                    └───────────────┬──────────────────────┘
                                    │ import (직접 ../../packages)
       ┌────────────────────────────┼─────────────────────────────┐
       ▼                            ▼                              ▼
  planner/approval/          product-adapters /            rag / knowledge /
  verifier/evidence/         pptx / docx-builder /          wiki / store /
  evals/feedback             screenshot / operator          collector / finetune
                                    │
                                    ▼
                             chrome (CDP) ──▶ 실장비/ mock 콘솔

  AIOSv2 Portal ──REST──▶ apps/http-bridge (3600) ──spawn──▶ mcp-server(stdio)
                          (SAFE_TOOL_WHITELIST 강제)

  운영자(웹) ────────────▶ apps/operator-console (3502) ──▶ api.ts ──▶ packages
                          (대시보드 HTML + /api/* REST)

  Docker: docker-entrypoint.sh → operator-console(3502) + http-bridge(3600) 동시 기동
```

세 진입점이 동일한 `packages/*` 도메인 로직을 공유한다. apps는 얇은 어댑터이고, 모든 비즈니스 로직은 packages에 있다.

---

## 4. MCP 서버 (`apps/mcp-server/src/index.ts`, ~620줄)

stdio 기반 JSON-RPC 2.0 서버. `readline`으로 한 줄씩 요청을 받아 처리한다.

**프로토콜 처리 (`handle()`):**
- `initialize` → `protocolVersion: '2025-06-18'`, serverInfo `sangfor-engineer-mcp v0.1.0`
- `tools/list` → 등록된 도구 66개 메타 반환(readOnly/destructive annotations 포함)
- `tools/call` → 핸들러 실행, 결과를 `content[{type:text}]` + `structuredContent`로 포장
- 에러는 `isError: true`로 변환 (예외를 throw하지 않고 결과로 감쌈)

**플랜 캐시:** `const plans = new Map<string, any>()` — `generate_config_plan`이 생성한 플랜을 메모리에 보관해 `validate_config_plan`/`verify_result` 등에서 `planId`로 재참조.

### 4.1 등록된 MCP 도구 (카테고리별 발췌 — 정본 목록은 코드 레지스트리 `apps/mcp-server/src/index.ts`의 66개)

**제품 디스커버리/수집 (product-adapters):**
| 도구 | 기능 |
|------|------|
| `sangfor.products` | 우선순위 순 지원 제품 목록 |
| `sangfor.discover_product_console` | 제품 콘솔 전략/로그인·API 가능성/메뉴·역량 |
| `sangfor.collect_product_config` | 읽기 전용 설정 수집 계획 (HCI/SCP=API-first, IAG/EPP=WebUI-first, NDR=hybrid) |
| `sangfor.analyze_customer_requirements` | 요구사항 문자열 → 제품별 작업(메뉴/API/위험/승인) |
| `sangfor.generate_product_change_plan` | 변경 계획(메뉴/API/롤백/검증) |

**Excel 기반 (ITAC 체크리스트):**
| 도구 | 기능 |
|------|------|
| `sangfor.import_excel_requirement_list` | ITAC Excel → 정규화 요구사항/증적/우선순위 |
| `sangfor.map_requirements_to_products` | 행 → HCI/IAG/EPP/NDR/external 매핑 |
| `sangfor.generate_excel_based_change_plan` | 멀티 제품 dry-run 변경 계획 |

**문서 생성 (DOCX/PPTX):**
| 도구 | 기능 |
|------|------|
| `sangfor.generate_setting_guide_docx` | 설정 가이드 Word |
| `sangfor.generate_setting_guide_pptx` | 설정 가이드 PPT |
| `sangfor.generate_operations_guide_pptx` | 운영 가이드 PPT |
| `sangfor.generate_operations_guide_docx` | 운영 가이드 Word |
| `sangfor.generate_comprehensive_setting_guide_docx` | 종합 설정 가이드(상세+스크린샷) |
| `sangfor.generate_comprehensive_operations_guide_docx` | 종합 운영 가이드 |
| `sangfor.capture_screenshots` | EPP/IAG/CC 콘솔 스크린샷(CDP) |
| `sangfor.generate_all_guides` | 전체 가이드 세트 일괄 생성(try/catch로 부분 실패 허용) |

**변경 실행 (게이트):**
| 도구 | 기능 |
|------|------|
| `sangfor.dry_run_product_change` | Save/Apply/Delete 직전까지 미리보기 |
| `sangfor.apply_approved_product_change` | 승인+env 게이트 통과 시에만 적용 |
| `sangfor.verify_product_change` | 읽기 전용 재수집 검증 체크리스트 |

**지식/RAG:**
| 도구 | 기능 |
|------|------|
| `sangfor.search_manuals` / `get_manual_section` | 시드 매뉴얼 검색/조회 |
| `sangfor.search_wiki` | 시드 위키 검색 |
| `sangfor.ingest_document` | PDF/HTML/MD/TXT/DOCX/PPTX/XLSX 인제스트 → 벡터 인덱스 |
| `sangfor.rag_search` / `rag_index_summary` | 로컬 RAG 검색/요약 |
| `sangfor.store_health` | Prisma 연결 상태 |
| `sangfor.learn_sources` | KB 카탈로그+커뮤니티+데모독 → RAG+파인튜닝 JSONL |

**플래너/검증/근거:**
`analyze_project`, `generate_config_plan`(DB 영속화 시도), `validate_config_plan`, `request_approval`, `verify_result`, `generate_evidence_report`(Excel 플랜은 `workPlan`→`ConfigPlan` 정규화), `run_planner_eval`.

**operator 세션:**
`start_operator_session`(기본 mock), `read_console_state`, `execute_console_action`(mock, 고위험 비-dryrun 차단), `read_live_console_state`, `execute_console_action_live`(실 Playwright, 승인+env 필요), `kill_session`.

**피드백/학습/위키:**
`submit_feedback`(DB 영속화), `extract_lesson`, `propose_wiki_update`, `approve_wiki_update`, `apply_wiki_update`, `apply_obsidian_wiki_update`, `apply_github_wiki_update`, `create_eval_case_from_feedback`.

**파인튜닝:**
`create_finetune_dataset`(시크릿 차단), `validate_finetune_dataset`, `create_finetune_job_spec`(자동 제출 안 함).

---

## 5. 다른 진입점 앱

### 5.1 HTTP Bridge (`apps/http-bridge`, port 3600)
- AIOSv2 Portal이 기대하는 REST 형태로 stdio MCP를 감싼다.
- `mcp-server`를 `pnpm exec tsx`로 **child process spawn**, stdin/stdout JSON-RPC로 통신. 응답은 `pending` Map + 30초 타임아웃으로 매칭.
- 엔드포인트: `GET /health`, `GET /tools`, `POST /tools/call`.
- **보안 핵심: MCP annotations 기반 인가(`tool-guard.ts`의 `authorizeToolCall`, 단일 소스).** 규칙: 주석 없음→403(fail-closed), `destructiveHint`→403(항상, 토글 무관), read-only 아님(write)→기본 403, `WHELP99_ENFORCE_SAFE_TOOLS="false"`일 때만 write 허용(destructive는 여전히 거부). 정적 화이트리스트가 아니라 `tools/list`가 보고하는 annotations를 신뢰한다.

### 5.2 Operator Console (`apps/operator-console`, port 3502/3500)
- `server.ts`: 순수 Node `http` 서버. `/api/summary`, `/api/products`, `/api/knowledge`, `/api/health/store`, `/api/health/embeddings`, `/api/analyze-project`, `/api/generate-config-plan`, `/api/rag-search`, `/api/discover-console`, `/api/analyze-requirements`, `/api/import-excel`(base64 업로드 지원), `/api/feedback`.
- `api.ts`: 각 엔드포인트를 packages 함수로 위임. RAG 인덱스 기본값 `data/rag/index.json`. `getEmbeddingHealth()`는 임베딩 제공자/LiteLLM/MiMo 리랭크 상태를 종합 진단.
- `ui.ts`: 다크 테마 SPA 대시보드 HTML(334줄)을 문자열로 반환.

### 5.3 Mock Sangfor Console (`apps/mock-sangfor-console`, port 3400)
- 25줄짜리 가짜 콘솔. URL에 `iag`/`endpoint`/`cyber` 포함 여부로 제품명 결정. `/state`는 고정 elements JSON 반환. Save/Apply 버튼은 `danger` 클래스. 실장비 없이 operator 경로 테스트용.

---

## 6. 도메인 패키지 상세

### 6.1 shared — 공통 기반
- **타입:** `ProductCode`(HCI_SCP|HCI|IAG|ENDPOINT_SECURE|NDR|CYBER_COMMAND), `ProjectType`, `RiskLevel`(low|medium|high|critical), `ApprovalStatus`, `KnowledgeChunk`, `ConfigStep`(phase: precheck|configure|validate|rollback), `ConfigPlan`, `ConsoleAction`, `ApprovalDecision`.
- **유틸:** `normalizeProduct(input)` — 별칭/대소문자/공백 정규화, 미매칭 시 기본값 `'HCI'`. `nowId(prefix)` — `prefix_timestamp_randomhex` 감사 추적용 ID.
- **상수:** `PRODUCT_PRIORITY`, `PRODUCTS`(code/name/priority/aliases/mvpScope 메타).

### 6.2 sangfor-approval — 위험도 분류
- `classifyTextRisk(text)`: 소문자 키워드 매칭.
  - **critical:** delete, shutdown, factory reset, drop, format, endpoint isolation, isolate endpoint, soar response, response action, vm delete
  - **high:** `DANGEROUS_TERMS`(21개: apply, save, reboot, failover, migration start, cutover, enable policy, activate license, password, otp, mfa, production, agent deployment, route/nat/interface change, vm power/migrate, security policy 등)
  - **medium:** network, policy, storage, migration, route, nat, interface
  - **low:** 그 외
- `requiresApprovalForText(text)` / `requiresApprovalForAction(action)`: 위험도 high|critical이면 `required=true`.

### 6.3 sangfor-planner — 계획 생성
- `analyzeProject(input)`: 제품 정규화 + `inferProjectType()`(키워드 휴리스틱, 한국어 '장애' 포함) + 제품별 필수 환경필드 검증(HCI: nodeCount/managementNetwork/storageNetwork/licenseStatus 등) + 위험도 + 누락입력 + RAG 권장 쿼리.
- `generateConfigPlan(input)`(동기, hash RAG) / `generateConfigPlanAsync(input)`(비동기 시맨틱 RAG): precheck/configure/validate/rollback 4단계 step 생성. 핵심 변경 step은 `approvalRequired=true`.
- `validateConfigPlan(plan)`: precheck/steps/rollback/validation 비어있지 않고 manual+wiki 참조 ≥1 검증.
- `buildKnowledgeQueries(product, type)`: 제품별 RAG 쿼리 템플릿.

### 6.4 sangfor-verifier — 검증
- `verifyResult(input)`: 동기 스텁, `validateConfigPlan` + 수동 검증 체크리스트.
- `verifyResultLive(input)`: 비동기 실장비 검증. mode `dry`(기본)/`observe`/`apply`. 장비 기본값 env(`SANGFOR_EQUIPMENT_HOST/PORT/USER/PASS`, 폴백 `10.80.1.106:443`). step별 `verifyStepLive()` → Chrome 기동→CAPTCHA OCR→로그인→메뉴 이동→스크린샷/스냅샷. apply는 env 게이트.
- `getProductMenuPath()`/`getProductFormFields()`: 제품·stepId별 메뉴 경로/폼 필드.

### 6.5 sangfor-evidence — 근거 리포트
- `generateEvidenceReport({plan, verification, format})`: Markdown(기본)/JSON. 헤더/precheck/steps(`[APPROVAL REQUIRED]`/`[DRY-RUN OK]` 배지)/rollback/validation/references/verification 섹션.

### 6.6 sangfor-evals — 품질 게이트
- `runPlannerEval(plan)`: 제품별 하드코딩 규칙 — HCI는 'MTU' 포함, IAG는 'Export', EPP는 'pilot', CC는 'NTP' 포함 여부를 플랜 JSON에서 검사.
- `createEvalCaseFromFeedback(input)`: 피드백→신규 평가 규칙 동적 추가(in-memory `evalCases`).

### 6.7 sangfor-feedback — 피드백/레슨
- `submitFeedback()` → `nowId('feedback')`, status `new`, in-memory Map.
- `extractLesson(id)`: 레슨 생성. rootCause/recommendedAction/antiPattern 포함, `approvalStatus='pending_review'`(사람 검토 필수). `listLessons()`.

### 6.8 sangfor-operator — 콘솔 조작
- 타입: `OperatorMode`(mock|lab|poc|customer_readonly|customer_write|production), `OperatorSession`, `LiveExecutionApproval`, `LiveConsoleActionInput`.
- **mock 경로:** `readConsoleState`(고정 elements), `executeConsoleAction`(dryRun 기본 true, 고위험 비-dryrun은 `waiting_approval`).
- **live 경로:** `readLiveConsoleState`(Playwright 스냅샷+스크린샷+CAPTCHA 처리), `executeLiveConsoleAction`(navigate/click/type/select/scroll/wait + 폼필드).
- **핵심 게이트 `assertRealExecutionAllowed()`:** 비-dryRun인데 ① `SANGFOR_ALLOW_REAL_EXECUTION !== 'true'` ② production 모드인데 `SANGFOR_ALLOW_PRODUCTION_EXECUTION !== 'true'` ③ approval 4필드 누락 ④ `approvalToken !== SANGFOR_OPERATOR_APPROVAL_TOKEN` 중 하나라도 해당하면 throw.
- `ensureLivePage()`: Chrome CDP 자동 기동→`connectOverCDP`→실패 시 Playwright launch 폴백. CDP 연결은 세션 재사용 위해 유지.

### 6.9 sangfor-chrome — 브라우저 자동화
- 상수: `DEFAULT_CDP_PORT=9333`, `CHROME_USER_DATA_DIR=/tmp/chrome-sangfor-debug`, `CHROMIUM_PATHS`.
- 생명주기: `ensureChromeRunning()`(stale 프로세스 kill→spawn→`/json/version` 폴링), `stopChrome()`, `getWsUrl()`.
- **OCR `ocrCaptcha()`:** 다단계 폴백 — Tesseract(로컬, PSM 7, 영숫자 화이트리스트) → LM Studio(:1234) → OpenAI(gpt-4o-mini) → Hermes Vision. 첫 성공(≥3자) 반환.
- `detectCaptcha()`: EPP `randcode`, CC `req_captcha` 등 셀렉터 탐지. **중요 주석: 필드 채우기 전 CAPTCHA 먼저 읽기(리프레시 방지).**
- `loginToConsole()`: CAPTCHA 먼저 감지/OCR → 모든 필드 한번에 채움 → 즉시 제출 → URL에 'login' 없으면 성공, 아니면 재시도(기본 3회).
- `navigateMenu()`(ExtJS SPA 텍스트 매칭 클릭), `fillFormFields()`(text/select/combobox, ExtJS 트리거 처리), `takeScreenshot()`, `getPageSnapshot()`.

### 6.10 sangfor-screenshot — 스크린샷 수집
- `PRODUCT_CONFIGS`: EPP(`10.80.1.106`, port 9333), IAG(`10.80.1.108`, 9334), CC(`10.80.1.107`, 9335) 별 기본 URL/계정/메뉴.
- `captureProductScreenshots(options)`: dryRun이면 Chrome 없이 계획만 반환. 아니면 CDP 연결→로그인→대시보드+메뉴별 스크린샷(한글 파일명 보존). 결과: captured/failed/totalScreenshots/timestamp.

### 6.11 sangfor-collector — 수집/학습
- `index.ts`: 커뮤니티 포럼(`DEFAULT_FORUM_IDS=[156,157,158,167,89,92,137,138]`) 스크래핑 + KB 카탈로그. `htmlToText`, `parseCommunityThread`(노이즈 필터), `parseKbCategoryNavigation`, `fetchKbArticleMarkdown`(토큰 필요), `sanitizeForFineTune`(이메일/전화/비밀번호 редак트), `docsToFineTuneExamples`, `contentHash`(SHA256).
- `one-session.ts`: Sangfor ONE OAuth. `exchangeOneOAuthCode()`, `resolveKbTokenFromOne()`(2개 엔드포인트 시도), `resolveAuthTokens()`(폴백 체인 + sources 감사로그), `verifyOneSession()`.
- `learn-pipeline.ts`: `runLearnSourcesPipeline()` — env/auth 로드 → 커뮤니티+KB 수집 → manifest 저장 → RAG 인제스트 → 데모독 → 파인튜닝 JSONL 생성/검증. 기본 경로 `data/sources/raw`, `data/rag/index.json`, `data/finetune/sangfor-sources.jsonl`.
- `load-env.ts`: `loadEnvFile()`(기존 env 미덮어쓰기), `parseCollectionLimit()`('all'/0→무제한).
- `demo-docs.ts`: `DEMO_DOC_PRODUCTS` 파일명→제품 매핑, `listDemoDocTargets()`.

### 6.12 sangfor-rag — 임베딩/벡터 검색
- **인덱스:** `RagIndex`(v1/v2, chunks[]), `RagDocumentChunk`(vector/contentHash/filePath/embeddingBackend).
- **인제스트 `ingestDocument()`:** 파일 텍스트 추출(PDF=pdf-parse→pdftotext→latin1 폴백, DOCX/PPTX/XLSX=unzip+XML) → `chunkText()`(최대 1400자, 180자 오버랩, 문단 경계 우선) → 임베딩 → contentHash 중복 제거 → JSON 인덱스 저장.
- **임베딩 제공자 (폴백 체인):**
  - `HashEmbeddingProvider`(384차원, 결정론적, 한국어 토큰화, 네트워크 불필요)
  - `LitellmEmbeddingProvider`(OpenAI 호환 `/embeddings`, 1536차원 기본)
  - `RapidMlxEmbeddingProvider`(로컬 MLX, 768차원)
  - `getEmbeddingProvider()`: `SANGFOR_EMBEDDING_FORCE_HASH=1`→hash, 요청 백엔드 5초 타임아웃 초기화 실패 시 hash 폴백, 전역 캐시.
- **검색 `ragSearch()`:** 제품/버전/trustLevel 필터(customer는 `SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER=1` 시만) → 쿼리 임베딩 → 코사인 유사도 → 상위 40 후보 → 선택적 MiMo 리랭크(5초 타임아웃, 실패 시 벡터 only) → 상위 8 반환. `ragSearchSync()`는 hash 전용(테스트).
- **MiMo 리랭크:** `MimoRerankProvider`(LLM 기반 relevance JSON), `createMimoRerankFromEnv()`(`SANGFOR_MIMO_RERANK_ENABLED!=0` && (LiteLLM 경유 || `SANGFOR_ALLOW_CLOUD_RAG=1`) && API키). 빌링: `tp-` 키→token-plan(클러스터 cn/sgp/ams), 아니면 payg.

### 6.13 sangfor-knowledge — 시드 지식
- `MANUAL_CHUNKS`: 12개 공식 매뉴얼(HCI precheck/migration/storage/DR, IAG policy/auth/audit, EPP rollout/EDR/update, CC collection/alert/siem), 모두 `trustLevel='official'`. `searchManuals()`(BM25 유사 스코어, 상위 5), `getManualSection(id)`, `listSeedManuals()`.
- `operations-procedures.ts`: daily/weekly/monthly/incident/troubleshooting/backup_recovery 6 카테고리 운영 절차. `getAllOperationsProcedures()`, `getOperationsProcedure(category)`.
- `product-guides.ts`: EPP(v6.0.4)/IAG(v13.0.120)/CC(v3.0.98C) 설정 가이드 각 6섹션(실장비 검증 기반). `getProductSettingGuide()`, `getAllProductSettingGuides()`.

### 6.14 sangfor-wiki — 위키
- `WIKI_CHUNKS`: 8개 내부 레슨(`trustLevel='internal'`). `searchWiki()`, `listSeedWiki()`.
- 제안 워크플로: `proposeWikiUpdate()`(status pending) → `approveWikiUpdate()` → `applyWikiUpdate()`(in-memory 마킹).
- 어댑터: `ObsidianVaultAdapter`(안전 경로/.md), `GitHubWikiGitAdapter`(clone/pull→write→commit→push). `applyObsidianWikiUpdate()`, `applyGitHubWikiUpdate()`.

### 6.15 sangfor-store — Prisma 영속화
- `isStoreEnabled()`: `SANGFOR_DB_ENABLED=0`이면 false, `DATABASE_URL` 있으면 true. `getPrisma()`(lazy 싱글톤, 비활성 시 null).
- `persistConfigPlan()`/`persistFeedbackEvent()`/`upsertRagDocumentMeta()`: 비활성 시 null 반환(graceful degrade). `storeHealthCheck()`(`SELECT 1`).

### 6.16 sangfor-finetune — 파인튜닝
- `FineTuneTaskType`: config_planning|risk_classification|lesson_extraction|wiki_update_writing.
- `buildFineTuneExample()`: 시스템 프롬프트(Sangfor 엔지니어 페르소나, 안전 제약) + system/user/assistant 메시지.
- `createFineTuneDataset()`: JSONL 작성(`data/finetune/{product}-{taskType}.jsonl`).
- **`validateFineTuneDataset()`: 시크릿 차단** — `/(password|otp|mfa|license key|secret)/i` 패턴 발견 시 에러.
- `createFineTuneJobSpec()`: 검증 통과 후 `status='ready_for_review'`(자동 제출 안 함) + 안전 노트 3종.

### 6.17 sangfor-product-adapters — 어댑터/Excel/DOCX (가장 큰 패키지)
- **어댑터 레지스트리 `ADAPTERS`:** HCI_SCP(api-first, 4역량), IAG(webui-first, 3역량), ENDPOINT_SECURE(webui-first, 7역량), NDR(hybrid, 3역량). 각 역량은 menuPath/apiEndpointCandidates/riskLevel/approvalRequired 보유. SOAR response·VM delete 등은 critical.
- **엔드포인트 카탈로그:** `HCI_SCP_ENDPOINTS`(Janus/OpenStack), `IAG_WEBUI_ROUTES`, `ENDPOINT_SECURE_WEBUI_ROUTES`, `NDR_API_ENDPOINTS`.
- **함수:** `discoverProductConsole`, `collectProductConfig`(읽기 전용 스냅샷), `analyzeCustomerRequirements`(요구사항→역량 키워드 스코어), `generateProductChangePlan`, `dryRunProductChange`(Save/Apply 직전 정지), `applyApprovedProductChange`(승인 4필드+env 게이트), `verifyProductChange`.
- **Excel 파싱(외부 라이브러리 없음):** `unzip` CLI + 정규식 XML 파싱. `importExcelRequirementList`(헤더행 자동 탐지, 부분표시 △→high 우선순위), `mapRequirementsToProducts`(키워드 분류, external_or_manual 포함), `generateExcelBasedChangePlan`(콘솔/수동 항목 분리).
- **DOCX(`docx-builder.ts`, raw XML+zip):** `buildSettingGuideDocx`, `buildOperationsGuideDocx`, `buildComprehensiveSettingGuideDocx`(스크린샷 임베드, EMU 변환), `buildComprehensiveOperationsGuideDocx`. 스타일: Calibri/맑은고딕, 제목/본문/표/불릿 스타일. 표 5항목 청크. 1년 로그 보존 등 규정 반영.

### 6.18 sangfor-pptx — PPTX 생성
- **PptxGenJS** 사용. `buildSettingGuidePptx()`(타이틀/요약+막대차트/제품별 색상 슬라이드/수동증적/dry-run절차/체크리스트), `buildOperationsGuidePptx()`(7슬라이드: 일일모니터링/주월간/장애대응 6단계/보안정책).
- 제품 색상: EPP=녹색, IAG=파랑, NDR=주황, HCI_SCP=보라, external=회색. 10×7.5in 레이아웃.

---

## 7. 데이터 모델 (`prisma/schema.prisma`)

PostgreSQL, 10개 모델:

| 모델 | 용도 |
|------|------|
| `SangforProduct` | 제품 메타(code unique, priority) |
| `SangforManual` | 매뉴얼 메타(trustLevel 기본 needs_review) |
| `SangforProject` | 고객 프로젝트 |
| `SangforConfigPlan` | 설정 계획(planJson Json) |
| `SangforFeedbackEvent` | 피드백 이벤트 |
| `SangforWikiUpdateProposal` | 위키 제안(before/after) |
| `SangforRagDocument` ↔ `SangforRagChunk` | RAG 문서/청크(contentHash unique, vector Json) |
| `SangforFineTuneDataset` | 파인튜닝 데이터셋 |
| `SangforFineTuneJob` | 파인튜닝 잡(status 기본 ready_for_review) |

DB는 선택적이며, 없으면 모든 영속화 호출이 null을 반환하고 in-memory로 동작한다.

---

## 8. 보안·안전 게이트 종합

### 8.1 환경변수 게이트 (계층)
| 게이트 | 변수 | 효과 |
|--------|------|------|
| 실제 실행 | `SANGFOR_ALLOW_REAL_EXECUTION=true` | 없으면 비-dryRun 액션 throw |
| 운영 실행 | `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true` | production 모드 비-dryRun 추가 요구 |
| 승인 토큰 | `SANGFOR_OPERATOR_APPROVAL_TOKEN` | approval.approvalToken과 일치 검증 |
| 클라우드 RAG | `SANGFOR_ALLOW_CLOUD_RAG=1` | MiMo 리랭크/클라우드 임베딩 허용 |
| 고객 문서 | `SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER=1` | customer trustLevel 검색 포함 |
| HTTP 화이트리스트 | `WHELP99_ENFORCE_SAFE_TOOLS` | 브리지가 읽기 전용 6도구만 허용 |

### 8.2 승인 페이로드
고위험/critical 작업은 `approvedBy` + `approvalToken` + `changeTicketId` + `rollbackPlanId` 4개 모두 필요. `applyApprovedProductChange`/`executeLiveConsoleAction`에서 검증.

### 8.3 기타 안전장치
- Dry-run 기본값(operator/adapters), 읽기 전용 스냅샷(mutationBlocked).
- 파인튜닝 시크릿 차단 정규식, 수집 시 PII 새니타이즈.
- 레슨/위키 제안 `pending_review` → 사람 검토 필수.
- CAPTCHA 먼저 읽기(리프레시 방지) 등 로그인 순서 강제.

---

## 9. 테스트 & CI/CD

**테스트(Vitest, 10개 스위트):** collector, load-env, one-session, planner, store, product-adapters, rag-embedding, ops-docx-builder, pptx-builder, screenshot-collector. DOCX/PPTX 테스트는 임시 ITAC xlsx fixture를 unzip 형식으로 생성해 실제 파일 산출을 검증.

**CI (`.github/workflows/`):**
- `ci.yml`: main/feature/** push, PR. lint(tsc --noEmit) → test → build → `smoke:mcp` → `check:mcp-scorecard`.
- `pr-validation.yml`: PR 검증.
- `cd.yml`: main push 시 build/test, Docker 빌드/푸시·docs 배포는 스텁(`if: false`).

**검증 명령:** `pnpm test` / `pnpm run lint` / `pnpm run build` / `pnpm run smoke:mcp`.

---

## 10. 운영 스크립트 (`scripts/`, 55개)

`package.json`에 매핑된 주요 그룹:
- **학습:** `learn:sources`, `learn:all`, `learn:nightly`, `learn:finalize`, `learn:kb:full`.
- **수집/인제스트:** `ingest:docs`, `ingest:attachments`, `ingest:product-tables`, `ingest:browser`, `crawl:kb:browser`, `crawl:one:browser`.
- **인증/세션:** `login:one`, `login:one:capture`(Chrome 토큰 추출), `login:one:safari`, `verify:one`.
- **RAG:** `rag:reembed`, `check:embedding-providers`, `check:glass-cdp`.
- **파인튜닝:** `export:finetune`, `learn:rebuild-finetune`.
- **부트스트랩/DB:** `local:bootstrap`, `seed:demo`, `db:generate/migrate/push/studio`.
- **MCP 점검:** `smoke:mcp`(`smoke-mcp-tools.mjs`), `check:mcp-scorecard`.
- **캡처(실장비):** `capture-*.ts`(v2~v6), `capture-audit-screenshots.ts`, `audit-menu-check.ts` 등 다수.
- `automation/*.plist`: macOS launchd 일일 학습 자동화.

---

## 11. 빌드 & 배포

- **Dockerfile:** node:20-alpine, pnpm. deps 스테이지에서 워크스페이스 manifest만 복사(install 캐시 안정화) → runner 스테이지에서 전체 소스 복사 후 심볼릭 링크 재생성(`pnpm install --offline`). `tsx`로 소스 직접 실행(빌드 산출물 아님). EXPOSE 3600(브리지)/3502(콘솔).
- **docker-entrypoint.sh:** operator-console(3502) 백그라운드 + http-bridge(3600) 포그라운드 동시 기동.
- **Dockerfile.mock:** mock 콘솔용 별도 이미지.

---

## 12. 전형적 워크플로우 (End-to-End)

```
1. ITAC Excel 입력
   └▶ import_excel_requirement_list (헤더 자동탐지, 우선순위)
       └▶ map_requirements_to_products (HCI/IAG/EPP/NDR/external 분류)
           └▶ generate_excel_based_change_plan (콘솔/수동 분리, 게이트)
2. 산출물
   └▶ generate_all_guides → 설정/운영 DOCX+PPTX + 종합 가이드(+스크린샷)
3. 검증/실행
   └▶ start_operator_session (mock 기본)
       └▶ dry_run_product_change (Save 직전 미리보기)
           └▶ [승인 4필드 + SANGFOR_ALLOW_REAL_EXECUTION] apply_approved_product_change
               └▶ verify_product_change (읽기 전용 재수집)
                   └▶ generate_evidence_report (근거 Markdown)
4. 학습 루프
   └▶ submit_feedback → extract_lesson(pending_review) → propose_wiki_update
       → approve_wiki_update → apply_github_wiki_update
   └▶ learn_sources → RAG 인덱스 + 파인튜닝 JSONL 갱신
```

---

## 13. 알려진 갭 / 주의사항 (코드 근거 기반)

1. **실제 실행기 미통합:** `applyApprovedProductChange`/`dryRunProductChange`는 게이트·미리보기까지만 수행하며, operator `sessionId`가 외부에서 제공되지 않으면 실 콘솔 변경(mutation)을 실제로 수행하지 않는다.
2. **API 카탈로그 일부 미구현:** IAG/EPP는 webui-first로 `apiCatalogStatus`가 ready여도 실제 API 호출 코드는 미완.
3. **승인 토큰 단순 비교:** `approvalToken`은 외부 인증 서비스가 아닌 환경변수 단순 일치 비교.
4. **in-memory 상태:** feedback/lessons/wiki proposals/eval cases/plans는 DB 미사용 시 프로세스 메모리에만 존재(재시작 시 소실).
5. **CD 파이프라인 스텁:** Docker push/docs 배포는 `if: false`로 비활성.
6. **하드코딩 실장비 IP/계정:** screenshot/verifier 기본값에 `10.80.1.106~108`, `admin/sangfor` 등이 포함(env로 override 가능).

---

## 14. 핵심 상수 빠른 참조

| 상수 | 값 | 위치 |
|------|----|----|
| MCP 프로토콜 버전 | 2025-06-18 | mcp-server |
| HTTP 브리지 포트 | 3600 | http-bridge |
| Operator 콘솔 포트 | 3502/3500 | operator-console |
| Mock 콘솔 포트 | 3400 | mock-console |
| 기본 CDP 포트 | 9333(EPP)/9334(IAG)/9335(CC) | chrome/screenshot |
| RAG 청크 | 최대 1400자, 180자 오버랩 | rag |
| Hash 임베딩 차원 | 384 | rag |
| LiteLLM/RapidMLX 차원 | 1536 / 768 | rag |
| 리랭크 후보 풀 | 40 → 상위 8 | rag |
| 승인 페이로드 필드 | 4개 필수 | operator/adapters |
| 감사 로그 보존 | 최소 1년 | knowledge/docx |
| 위험도 순서 | low<medium<high<critical | shared/approval |

---

*본 문서는 2026-07-01 기준 `c15ad49` 커밋의 소스 코드를 apps/packages 전 파일 단위로 분석하여 작성되었다. 코드 변경 시 본 문서도 함께 갱신할 것.*
