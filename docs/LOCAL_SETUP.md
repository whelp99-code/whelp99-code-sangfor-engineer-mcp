# 로컬 개발·학습 전환 가이드

Cloud Agent VM에서 하던 작업을 **본인 PC(로컬)** 에서 이어가는 절차입니다.

## 1. 저장소 받기

```bash
git clone https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp.git
cd whelp99-code-sangfor-engineer-mcp
git checkout cursor/sangfor-source-learning-2b33
# 또는 main에 머지된 뒤: git checkout main && git pull
```

## 2. 런타임

- **Node.js** 20+ (권장 22)
- **pnpm** 10 (`corepack enable && corepack prepare pnpm@10.28.1 --activate`)

```bash
pnpm install
pnpm test
pnpm run lint
```

## 3. 환경 변수 (`.env`)

VM에 있던 `.env`는 git에 없습니다. 로컬에서 새로 만듭니다.

```bash
cp .env.example .env
```

### ONE 로그인 (ID/PW → 세션)

**방법 A — 브라우저 창 (권장)**

```bash
pnpm run login:one
```

열린 Chrome/Playwright 창에서 `https://one.sangfor.com` 에 ID/PW 로그인 → 스크립트가 `.env`에 토큰 저장.

**방법 B — 이미 로그인된 Chrome**

시스템 Chrome으로 ONE에 로그인한 뒤:

```bash
pnpm run login:one:capture
```

**방법 B2 — Safari (macOS)**

Safari에서 `one.sangfor.com` / `knowledgebase.sangfor.com` 로그인 후:

```bash
pnpm run login:one:safari
```

**방법 C — 수동**

- DevTools → Local Storage → `access_token_mh` → `SANGFOR_ONE_ACCESS_TOKEN`
- 또는 redirect URL의 `?code=` → `SANGFOR_OAUTH_CODE`

검증:

```bash
pnpm run verify:one
```

### KB 전문 (선택)

ONE에서 **Knowledge Base** 메뉴까지 들어간 다음:

```bash
pnpm run login:one:capture
pnpm exec tsx scripts/resolve-kb-token.ts
```

`hasKbToken: true` 이면 KB Markdown 전문 수집 가능.

## 4. 전체 수집·학습 (로컬에서 한 번에)

`.env`에 토큰이 있으면 한 번에:

```bash
pnpm run local:bootstrap
```

또는 단계별:

```bash
export SANGFOR_COMMUNITY_MAX_THREADS=all
export SANGFOR_KB_MAX_ARTICLES=all
export SANGFOR_FINETUNE_MAX_EXAMPLES=all

pnpm run learn:all
# (= learn:sources → ingest-seeds → rebuild-finetune → finalize)
```

완료 리포트: `data/sources/learning-complete.json`

## 5. MCP 서버 (Cursor 로컬)

프로젝트 루트의 `.cursor/mcp.json.example` 을 참고해 Cursor MCP에 등록:

```bash
mkdir -p .cursor
cp .cursor/mcp.json.example .cursor/mcp.json
```

`cwd`는 `${workspaceFolder}` 로 두면 로컬 clone 경로에 자동 맞춰집니다.

도구 `sangfor.learn_sources` 로 `.env` 기반 수집도 가능.

## 6. 웹 UI (Operator Console)

브라우저에서 Sangfor Engineer 기능을 사용합니다. MCP stdio 서버(`dev:mcp`)는 Cursor 등 다른 클라이언트용으로 그대로 둡니다.

```bash
pnpm run dev:web          # http://localhost:3502 (alias: dev:operator-console)
pnpm run dev:mock-console # http://localhost:3400 (선택, mock HCI)
pnpm run seed:demo
```

### 화면

| 탭 | API | 설명 |
|----|-----|------|
| 대시보드 | `GET /api/summary`, `/api/health/*` | RAG·Store·임베딩 상태, 문서 링크 |
| 프로젝트 분석 | `POST /api/analyze-project` | 리스크·누락 입력 분석 |
| 설정 플랜 | `POST /api/generate-config-plan` | RAG 기반 설정 플랜 |
| RAG 검색 | `POST /api/rag-search` | 로컬 인덱스 검색 |
| 제품 어댑터 | `POST /api/discover-console`, `/api/analyze-requirements`, `/api/import-excel` | 콘솔 탐색·요구사항·Excel |
| 피드백 | `POST /api/feedback` | 피드백 제출 |
| 지식 브라우저 | `GET /api/knowledge` | 시드 매뉴얼/Wiki |

## 7. git에 없는 데이터 (로컬에서 새로 생성)

| 경로 | 설명 |
|------|------|
| `.env` | 인증 (절대 커밋 금지) |
| `data/rag/index.json` | RAG 인덱스 |
| `data/sources/raw/` | 수집 원문 |
| `data/finetune/sangfor-sources.jsonl` | Fine-tune 데이터 |

VM에서 만든 인덱스를 쓰려면 위 파일들을 **scp/rsync** 로 복사해도 됩니다. 보안상 `.env`는 로컬에서 다시 발급하는 것을 권장합니다.

## 8. 자주 쓰는 명령

| 명령 | 용도 |
|------|------|
| `pnpm run verify:one` | ONE 세션 확인 |
| `pnpm run learn:sources` | Community + KB + demo → RAG + JSONL |
| `pnpm run learn:kb:full` | 제품별 URL 목록 + (가능 시) 브라우저 탐색 → 본문 크롤 → RAG |
| `pnpm run check:glass-cdp` | Glass CDP(기본 9222) + KB 탭 상태 확인 |
| `pnpm run check:embedding-providers` | Rapid-MLX / MiMo rerank 상태 확인 |
| `pnpm run rag:reembed` | RAG 인덱스 semantic 재임베딩 |
| `pnpm run learn:nightly` | learn:all + KB full crawl + reembed |
| `pnpm run db:migrate` | Prisma migrate dev (PostgreSQL) |
| `pnpm run db:generate` | Regenerate Prisma client |

### launchd (KB daily 03:00)

```bash
cp automation/com.jmpark.sangfor.learnkb.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jmpark.sangfor.learnkb.plist
launchctl print gui/$(id -u)/com.jmpark.sangfor.learnkb
```

### MiMo Token Plan

- API Key format: `tp-xxxxx` (not pay-as-you-go `sk-xxxxx`)
- Default base URL (APAC): `https://token-plan-sgp.xiaomimimo.com/v1`
- Set `SANGFOR_MIMO_BILLING=token-plan` and `SANGFOR_MIMO_TOKEN_PLAN_CLUSTER=sgp|cn|ams`

### LiteLLM (local proxy, recommended)

로컬 LiteLLM 라우터(`http://localhost:4000/v1`)에 OpenAI 호환으로 연결합니다. CrewAI와 **동일한 model / api_base / api_key**를 씁니다.

| CrewAI `llm` | Sangfor `.env` |
|--------------|----------------|
| `api_base: http://localhost:4000/v1` | `SANGFOR_LITELLM_BASE_URL` (또는 `OPENAI_API_BASE`) |
| `api_key: sk-local-master-key-2026` | `SANGFOR_LITELLM_API_KEY` (또는 `OPENAI_API_KEY`) |
| `model: openai/local-rapid` | `SANGFOR_LITELLM_EMBEDDING_MODEL=local-rapid` → `/v1/embeddings` |
| `model: openai/cloud-mimo` | `SANGFOR_LITELLM_CHAT_MODEL=cloud-mimo` + `SANGFOR_MIMO_VIA_LITELLM=1` → rerank |

CrewAI YAML의 `openai/` 접두사는 코드에서 자동 제거됩니다. `/v1/models`에 보이는 id(`local-rapid`, `cloud-mimo`)를 쓰면 됩니다.

```bash
# .env (방법 1 — 명시)
SANGFOR_EMBEDDING_PROVIDER=litellm
SANGFOR_LITELLM_BASE_URL=http://localhost:4000/v1
SANGFOR_LITELLM_API_KEY=sk-local-master-key-2026
SANGFOR_LITELLM_EMBEDDING_MODEL=openai/local-rapid
SANGFOR_MIMO_VIA_LITELLM=1
SANGFOR_LITELLM_CHAT_MODEL=openai/cloud-mimo

# 방법 2 — ~/.zshrc만 써도 base/key는 자동 fallback
# export OPENAI_API_BASE="http://localhost:4000/v1"
# export OPENAI_API_KEY="sk-local-master-key-2026"

pnpm run check:embedding-providers
pnpm run rag:reembed
```

`SANGFOR_MIMO_VIA_LITELLM=1`이면 MiMo rerank는 LiteLLM의 `openai/cloud-mimo`로 라우팅되며 `SANGFOR_ALLOW_CLOUD_RAG` 없이 동작합니다.

### Rapid-MLX (direct)

`SANGFOR_EMBEDDING_PROVIDER=rapid-mlx` + `SANGFOR_RAPID_MLX_BASE_URL` 설정 후:

```bash
pnpm run rag:reembed
```
| `pnpm run login:one:safari` | Safari ONE/KB 토큰 → `.env` |
| `pnpm run login:kb:chrome` | Chrome에서 KB 열고 `library_token` 캡처 |
| `pnpm run learn:finalize` | 검증·완료 리포트 |
| `pnpm run dev:web` | 웹 UI (Operator Console, :3502) |
| `pnpm run dev:mcp` | MCP stdio 서버 |

## 9. 문제 해결

- **`pnpm install` 실패** → `npm` 대신 `pnpm` 사용 (`.npmrc` 확인)
- **토큰 무효** → `pnpm run login:one` 다시 실행
- **KB 본문 없음** → `kbTokenUsed: false` 정상(카탈로그만). ONE에서 KB 진입 후 capture
- **전체 KB 사이트맵/본문** → `data/sources/sangfor_product_tables.md` 시드 + `pnpm run learn:kb:full`. 매일 자동화: `automation/scripts/run-learn-kb-full.sh` (CDP `http://127.0.0.1:9222` 고정). 설계: `docs/design/KB_DAILY_CDP_AUTOMATION.md`
- **RAG 검색 품질** → hash 임베딩 → Rapid-MLX + 샤오미 MiMo(리랭크) 전환 설계: `docs/design/RAG_SEMANTIC_EMBEDDINGS.md`, OSS 갭: `docs/OSS_GAP_ANALYSIS.md`
- **fine-tune 검증 실패** → `pnpm run learn:rebuild-finetune`

자세한 수집 정책: [SANGFOR_SOURCE_LEARNING.md](./SANGFOR_SOURCE_LEARNING.md)
