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

## 6. UI 데모 (선택, 다른 브랜치)

Operator Console 등 UI는 `cursor/ui-demo-data-expand-2b33` 브랜치:

```bash
pnpm run dev:operator-console   # :3500
pnpm run dev:mock-console       # :3400
pnpm run seed:demo
```

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
| `pnpm run learn:finalize` | 검증·완료 리포트 |
| `pnpm run dev:mcp` | MCP stdio 서버 |

## 9. 문제 해결

- **`pnpm install` 실패** → `npm` 대신 `pnpm` 사용 (`.npmrc` 확인)
- **토큰 무효** → `pnpm run login:one` 다시 실행
- **KB 본문 없음** → `kbTokenUsed: false` 정상(카탈로그만). ONE에서 KB 진입 후 capture
- **fine-tune 검증 실패** → `pnpm run learn:rebuild-finetune`

자세한 수집 정책: [SANGFOR_SOURCE_LEARNING.md](./SANGFOR_SOURCE_LEARNING.md)
