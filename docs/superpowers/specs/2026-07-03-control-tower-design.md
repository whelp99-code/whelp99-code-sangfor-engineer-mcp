# Control Tower 설계문서 (Design Spec)

> **작성일:** 2026-07-03 · **상태:** 사용자 승인된 설계의 상세화 · **다음 단계:** `docs/superpowers/plans/`의 구현 플랜
>
> **에이전트 워커 주의:** 이 문서는 멀티에이전트 협업 구현을 전제로 작성되었다. §4의 "기존 시스템 계약"은 현재 코드베이스에서 **그대로 인용한 것**이므로 재확인 없이 신뢰하고 사용하라. 단, 구현 시점에 해당 파일이 변경되었을 수 있으므로 import 경로가 깨지면 원본 파일을 다시 읽어라.

---

## 1. 목적

지금까지 만든 제품 전체(MCP 도구 77종, 자문·HCI·지식·PM·문서 서브시스템)를 **한 화면에서 보고(대시보드), 실행하고(명령), 실행 결과를 저장·조회하는(이력)** 통합 관제면을 만든다.

- **대시보드:** 장비·자문 상태 요약 / 최근 실행 이력 / 승인 대기 큐 / 시스템 건강도 (첫 화면 4위젯, 사용자 확정)
- **명령 실행:** 77개 MCP 도구 전체. 읽기전용은 즉시 실행, 쓰기·파괴적은 승인게이트 통과 후 실행 (사용자 확정)
- **실행 이력:** 모든 도구 실행을 영속 저장(비밀값 마스킹), 필터·조회 (사용자 확정)
- **접근:** 로컬 단독 (localhost, 기존 bearer 토큰 게이트 재사용) (사용자 확정)
- **벤더 개방성:** 벤더가 계속 추가된다. 컨트롤타워 코드는 어떤 벤더도 하드코딩하지 않는다. 새 벤더 추가 = 타워 코드 수정 0줄 (사용자 확정)

## 2. 범위 / 비범위

### 범위 (이 스펙)

| # | 항목 | 산출물 |
|---|------|--------|
| 1 | 실행이력 저장소 | 신규 패키지 `packages/sangfor-runs` (`@sangfor/runs`) |
| 2 | 승인 통과 경로 | `apps/http-bridge/src/tool-guard.ts` + `server.ts` 확장 |
| 3 | 컨트롤타워 앱 | 신규 앱 `apps/control-tower` (포트 3700) |
| 4 | 벤더/장비 레지스트리 | `data/registry/vendors.json` + `data/registry/devices.json` + 로더 모듈 |
| 5 | 일괄 자문 sweep | 수동 1클릭 (장비 × 벤더 advisorTools) |
| 6 | 테스트 | 기존 310개 무회귀 + 신규 단위/통합 테스트 |

### 비범위 (명시적 제외 — 다음 스펙)

- **스케줄러/주기 자동실행** (cron·launchd 연동). sweep은 수동 버튼만.
- **원격/멀티유저 접근** (HTTPS, 사용자 구분, 세션).
- **operator-console(3502) 흡수/폐기.** 존치하고 타워에서 링크로만 연결.
- **vendors.json의 UI 편집.** 벤더 디스크립터는 repo 파일로 관리(코드리뷰 대상). 장비(devices)는 UI CRUD 가능.
- **Prisma/DB 저장.** 실행이력은 파일(JSONL) 기반. DB 승격은 나중.
- **MCP 서버(`apps/mcp-server`) 코드 수정.** 절대 금지 — §7 보안 불변식 참조.

## 3. 아키텍처 개요

```
브라우저 ──────→ apps/control-tower (:3700)  [신규]
                  │  · UI (서버렌더 단일 HTML + vanilla JS)
                  │  · 실행이력 저장 (@sangfor/runs → data/runs/*.jsonl)
                  │  · 승인 대기 큐 (= status:pending_approval인 run)
                  │  · 승인 시 SignedApproval 민팅 (HMAC, @sangfor/operator 재사용)
                  │  · 벤더/장비 레지스트리 (data/registry/*.json)
                  ↓ REST (fetch, Authorization: Bearer)
              apps/http-bridge (:3600)  [확장]
                  │  · 안전게이트 = 유일한 HTTP-계층 강제점
                  │  · 기존: 읽기전용만 통과, 파괴적 무조건 거부 (기본값 무변경)
                  │  · 신규: 유효한 SignedApproval 첨부 시 쓰기/파괴적 통과
                  ↓ stdio JSON-RPC (child process)
              apps/mcp-server (77 tools)  [무수정]
                  │  · HCI 쓰기 자체 게이트(hciWriteGate) 그대로 동작 (이중 방어)
                  ↓
              mock-sangfor-console(:3400) / 실장비
```

- 기존 `operator-console(:3502)`은 존치, 타워 네비게이션에서 외부 링크.
- 승인·nonce 체계는 **새로 발명하지 않는다**. `@sangfor/operator`의 `signApprovalToken` / `verifyExecutionApproval` / `FileNonceStore`를 그대로 재사용한다.

## 4. 기존 시스템 계약 (구현 에이전트 필독 — 현재 코드에서 그대로 인용)

### 4.1 http-bridge 엔드포인트 (`apps/http-bridge/src/server.ts`)

- 포트: `Number(process.env.PORT ?? process.env.WHELP99_HTTP_BRIDGE_PORT ?? 3600)`
- 인증: `/tools`, `/tools/call`만 게이트. 헤더 `Authorization: Bearer <SANGFOR_API_TOKEN>`, `checkAuth()` 상수시간 비교. `/health`는 무인증.
- `GET /health` → `{ status: 'ok'|'degraded', bridge, mcp: 'connected'|'error', port }` (degraded면 503)
- `GET /tools` → `{ tools: [{ name, description, inputSchema, annotations: { title, readOnlyHint, destructiveHint }, category }] }`
- `POST /tools/call` body `{ name, arguments }` (alias `args`) → 성공 `{ result: <MCP result envelope> }`, 거부 `{ error }` + 403/400/502
- MCP result envelope: `{ content: [{type:'text', text: JSON.stringify(핸들러결과, null, 2)}], structuredContent: <핸들러결과 원본객체>, isError: boolean }`
  → **파싱은 `structuredContent`를 우선 사용**, 없으면 `content[0].text`를 JSON.parse.
- MCP child: `spawn('pnpm', ['exec','tsx', 'apps/mcp-server/src/index.ts'])`, JSON-RPC 메서드 `initialize` / `tools/list` / `tools/call`, 요청당 30초 타임아웃.

### 4.2 tool-guard 현행 로직 (`apps/http-bridge/src/tool-guard.ts`)

```ts
export function authorizeToolCall(params: {
  name: string;
  toolListResult: unknown;
  enforceWhitelist: boolean;   // WHELP99_ENFORCE_SAFE_TOOLS !== 'false'
  remoteBind?: boolean;        // 비루프백 바인드 여부
  allowRemoteWrite?: boolean;  // SANGFOR_ALLOW_REMOTE_WRITE === 'true'
}): { allow: boolean; status?: number; error?: string }
```

판정 순서(현행): ① annotations 없거나 boolean 아님 → 403 (fail-closed) ② `destructiveHint:true` → **무조건 403** ③ 쓰기 + 원격바인드 + `!allowRemoteWrite` → 403 ④ `enforceWhitelist`이고 읽기전용 아님 → 403 ⑤ 허용.

### 4.3 MCP 도구 명명·annotations (`apps/mcp-server/src/index.ts`)

- 도구명은 **`sangfor.` 접두사 dotted** — 예: `sangfor.advisor_fortios`, `sangfor.advisor_fortios_advanced`, `sangfor.hci_apply_create_volume`, `sangfor.products`.
- `annotationsFor()`: `DESTRUCTIVE_TOOLS` 셋(7개: `sangfor.apply_approved_product_change`, `sangfor.execute_console_action`, `sangfor.execute_console_action_live`, `sangfor.apply_wiki_update`, `sangfor.apply_github_wiki_update`, `sangfor.apply_obsidian_wiki_update`, `sangfor.hci_delete_volume`) → `destructiveHint:true`. `WRITE_TOOLS` 셋 → `readOnlyHint:false`. 나머지 → 읽기전용.
- `category`: `admin|hci|pm|wiki|report|knowledge|ml|collect|advisory` — 타워 도구 카탈로그 그룹핑에 그대로 사용.

### 4.4 승인/nonce 체계 (`packages/sangfor-operator/src/{approval.ts,nonce-store.ts}`, 패키지명 `@sangfor/operator`)

```ts
export interface ApprovalActionRef { type: string; target?: string; }
export interface SignedApproval {
  approvedBy: string;
  approvalToken: string;   // hex HMAC-SHA256
  changeTicketId: string;
  rollbackPlanId: string;
  nonce: string;
  expiresAt: string;       // ISO 8601
}
export function signApprovalToken(secret: string, action: ApprovalActionRef, approval: Omit<SignedApproval,'approvalToken'>): string
export function verifyExecutionApproval(params: { action: ApprovalActionRef; approval: SignedApproval | undefined; secret: string | undefined; now?: Date }): { ok: boolean; reason?: string }
export function consumeApprovalNonce(approval: { nonce: string; expiresAt: string }, now?: Date): NonceConsumeResult
```

- HMAC-SHA256, canonical string = `[approvedBy, changeTicketId, rollbackPlanId, nonce, expiresAt, action.type, action.target ?? ''].join('\n')`. 시크릿 env: **`SANGFOR_OPERATOR_APPROVAL_SECRET`** (미설정 시 fail-closed 거부).
- 단일사용 nonce: `FileNonceStore` — `data/runtime/approval-nonces.json` (env `SANGFOR_NONCE_STORE_PATH`), atomic write, 재시작 생존, 재사용 시 `already used` 거부, 만료 자동 GC.
- HCI 쓰기 도구는 MCP 서버 내부 `hciWriteGate`가 tool args의 `approval`을 **별도로** 검증·nonce 소비한다(action type `hci.create-volume`/`hci.delete-volume`). 이 게이트는 건드리지 않는다.

### 4.5 shared 헬퍼 (`packages/shared/src/index.ts`, 패키지명 `@sangfor/shared`)

```ts
export function resolveBindHost(): string                          // BIND_HOST, 기본 127.0.0.1
export function isLoopback(host: string): boolean
export function checkAuth(authHeader: string|undefined, token: string|undefined): { ok: boolean; status?: number }
export function assertBindSafety(bindHost: string, token: string|undefined): void  // 비루프백+무토큰 → throw
export function resolveRepoData(subdir: string, envVar?: string): string
export function nowId(prefix: string): string                      // `${prefix}_${Date.now()}_${rand6hex}`
```

### 4.6 마스킹 계약 (`packages/sangfor-hci-client/src/audit-ledger.ts`)

```ts
const SECRET_KEY_RE = /password|secret|token|authorization|cookie/i;
// 키가 매칭되고 값이 string이면 '***', 아니면 재귀
```

`maskSecrets<T>(value: T): T`로 export됨. **`@sangfor/runs`는 이 regex 계약을 복제 구현한다** (hci-client에 도메인 무관 의존을 만들지 않기 위해; regex가 바뀌면 양쪽 동기화 — 테스트로 고정).

### 4.7 evaluateSpec 반환 형태 (`packages/sangfor-spec`, `@sangfor-engineer/sangfor-spec`)

```ts
export interface EvaluationResult {
  specId: string;
  ok: boolean;    // pass>0 && fail===0 && indeterminate===0
  items: ItemResult[];      // { id, label, verdict: 'PASS'|'FAIL'|'INDETERMINATE', category, observed?, expected?, reason }
  summary: EvaluationSummary; // { pass, fail, indeterminate, misconfiguration, missing, contextDependent }
  coverage: CoverageInfo;
}
```

자문 도구(advisor_*)의 결과 객체는 이 구조(또는 `{ evaluations: EvaluationResult[] }` 래핑)를 담는다. **타워의 장비 요약 위젯은 `summary`와 `ok`만 읽는다** — 벤더 중립 계약.

### 4.8 컨벤션

- **테스트:** 루트 `tests/**/*.test.ts` (vitest, co-located 아님). 새 패키지를 테스트에서 별칭 import하려면 `vitest.config.ts`의 `resolve.alias`와 루트 `tsconfig.json`의 `paths`에 **둘 다** 추가해야 한다.
- **앱 import:** 앱은 패키지를 상대경로 deep import (`'../../../packages/shared/src/index.js'`, `.js` 확장자 필수 — NodeNext).
- **dev 스크립트:** 루트 package.json `"dev:control-tower": "tsx apps/control-tower/src/server.ts"` 형태로 추가.
- **데이터 루트:** 반드시 `resolveRepoData('<subdir>', '<ENV_OVERRIDE>')`로 앵커 (cwd 무관).
- **앱 서버 패턴:** raw `node:http`, `assertBindSafety` 후 listen, `/api/*`만 `checkAuth` 게이트 (operator-console과 동일).
- **자동 기동 가드:** 서버 모듈은 `MCP_NO_SERVE`/`VITEST` 환경에서 listen하지 않도록 가드 (mock-console과 동일 패턴: "Auto-start only when run as a process").

## 5. 컴포넌트 설계

### 5.1 실행이력 저장소 — `packages/sangfor-runs` (신규, `@sangfor/runs`)

**책임:** RunRecord의 생성·상태전이·조회. 승인 대기 큐는 별도 저장소가 아니라 `status: 'pending_approval'` 쿼리다.

**파일 구조:**

```
packages/sangfor-runs/
├── package.json          // { "name": "@sangfor/runs", "type": "module", "main": "src/index.ts",
│                         //   "dependencies": { "@sangfor/shared": "workspace:*" } }
└── src/
    ├── index.ts          // export * from './run-store.js'; export * from './mask.js';
    ├── mask.ts           // maskSecrets 복제 구현 (§4.6 regex 계약)
    └── run-store.ts      // RunStore 클래스 + 타입
```

**타입 (전체 정의 — 그대로 구현):**

```ts
export type RunStatus =
  | 'pending_approval'  // 쓰기/파괴적 도구, 승인 대기
  | 'rejected'          // 거부됨 (rejectedReason 필수)
  | 'running'           // 실행 중 (bridge 호출 직전 기록)
  | 'succeeded'         // 실행 완료, isError=false
  | 'failed';           // 실행 실패 (bridge 거부/HTTP 오류/isError=true/타임아웃)

export type RunSafety = 'read_only' | 'write' | 'destructive';  // bridge /tools annotations에서 파생

export interface RunRecord {
  schemaVersion: 1;
  runId: string;             // nowId('run')
  toolId: string;            // 예: 'sangfor.advisor_fortios_advanced'
  toolSafety: RunSafety;
  args: Record<string, unknown>;   // 저장 전 maskSecrets 적용
  status: RunStatus;
  requestedAt: string;       // ISO 8601
  finishedAt?: string;
  durationMs?: number;
  resultSummary?: string;    // 사람용 1줄 (예: 'ok=false pass=5 fail=2' 또는 에러 첫줄), 최대 200자
  resultJson?: unknown;      // structuredContent 원본, maskSecrets 적용. 500KB 초과 시 { truncated: true, note } 로 대체
  error?: string;
  deviceId?: string;         // 레지스트리 장비와 연결 시
  sweepId?: string;          // 일괄 자문 실행 그룹
  approval?: {               // 승인 이벤트 기록 (토큰·nonce 값은 저장하지 않음)
    approvedBy: string;
    approvedAt: string;
    changeTicketId: string;
    rollbackPlanId: string;
  };
  rejectedReason?: string;
}

export interface ListRunsOptions {
  status?: RunStatus;
  toolId?: string;
  deviceId?: string;
  sweepId?: string;
  sinceDays?: number;        // 기본 14 — 스캔할 JSONL 파일 날짜 범위
  limit?: number;            // 기본 100
}

export class RunStore {
  constructor(dir?: string);  // 기본 resolveRepoData('data/runs', 'SANGFOR_RUNS_ROOT')
  createRun(input: { toolId: string; toolSafety: RunSafety; args: Record<string, unknown>;
                     deviceId?: string; sweepId?: string; initialStatus: RunStatus }): RunRecord;
  transition(runId: string, patch: Partial<RunRecord> & { status: RunStatus }): RunRecord; // 미존재 runId → throw
  getRun(runId: string): RunRecord | undefined;
  listRuns(opts?: ListRunsOptions): RunRecord[];       // requestedAt 내림차순
  pendingApprovals(): RunRecord[];                     // listRuns({status:'pending_approval'}) 별칭
}
```

**저장 형식 (append-only snapshot JSONL):**

- 파일: `data/runs/<YYYY-MM-DD>.jsonl` — 날짜는 해당 run의 `requestedAt.slice(0,10)`. 상태전이가 며칠 걸쳐도 **같은 파일**에 append(레코드의 requestedAt 기준).
- 한 줄 = RunRecord **전체 스냅샷** (이벤트 병합 불필요). 같은 runId의 마지막 줄이 현재 상태 (last-wins fold).
- append는 `appendFileSync` + `\n`. 파일 rewrite 금지 (감사 가능성 — 이전 스냅샷이 그대로 남음).
- 읽기: `sinceDays` 범위의 파일들을 스캔, runId별 마지막 스냅샷으로 fold, 파싱 불가 줄은 stderr 경고 후 skip (기존 `[competency] skipping unparseable...` 패턴).
- **마스킹 불변식:** `createRun`/`transition`은 저장 직전 `args`·`resultJson`에 반드시 `maskSecrets` 적용. 호출자가 잊어도 저장소가 보장한다.

### 5.2 http-bridge 확장 — 승인 통과 경로

**변경 파일:** `apps/http-bridge/src/tool-guard.ts`, `apps/http-bridge/src/server.ts`

**tool-guard 확장 (시그니처):**

```ts
import type { SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';

export const BRIDGE_APPROVAL_ACTION_TYPE = 'bridge.tool-call';

export function authorizeToolCall(params: {
  name: string;
  toolListResult: unknown;
  enforceWhitelist: boolean;
  remoteBind?: boolean;
  allowRemoteWrite?: boolean;
  approval?: SignedApproval;          // 신규 (optional)
  approvalSecret?: string;            // 신규: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET
}): ToolAuthDecision
```

**신규 판정 로직 (기존 ①~⑤ 앞에 삽입되는 분기):**

```
① annotations 없음/비boolean → 403                       (현행 유지, 승인으로도 우회 불가)
②′ approval이 첨부된 경우:
    a. verifyExecutionApproval({ action: { type: 'bridge.tool-call', target: name },
                                  approval, secret: approvalSecret })
       실패 → 403 `bridge approval rejected: <reason>`
    b. consumeApprovalNonce({ nonce, expiresAt }) 실패 → 403 (재사용/만료)
    c. 쓰기 + 원격바인드 + !allowRemoteWrite → 403         (현행 ③ 유지 — 승인으로도 원격쓰기 불가)
    d. 통과 → { allow: true }                             (destructive 포함)
② approval 미첨부 → 현행 ②~⑤ 그대로                      (기본 동작 100% 무변경)
```

핵심: **approval은 도구명에 action-bound** (`target: name`) — 도구 A용 승인을 도구 B에 재사용 불가. nonce는 기존 FileNonceStore 공유(단일사용). HCI 도구의 tool-args 내 approval(§4.4)과는 **별개의 nonce** — 이중 게이트 각각 자기 nonce를 소비한다.

**server.ts 변경:** `POST /tools/call` body에서 `approval` 필드를 추출해 `authorizeToolCall`에 전달. 그 외 무변경.

```ts
const approval = body.approval && typeof body.approval === 'object' ? body.approval as SignedApproval : undefined;
// authorizeToolCall({ ..., approval, approvalSecret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET })
```

**회귀 보증 (테스트로 고정):** approval 미첨부 요청의 판정 결과는 기존과 완전 동일해야 한다.

### 5.3 컨트롤타워 앱 — `apps/control-tower`

**파일 구조:**

```
apps/control-tower/
├── package.json               // { "name": "control-tower", "type": "module", "main": "src/server.ts" }
└── src/
    ├── server.ts              // http 서버 조립: 포트/바인드/인증/라우팅. listen 가드 포함
    ├── api.ts                 // JSON API 핸들러 (아래 라우트 표)
    ├── ui.ts                  // dashboardHtml(): 단일 HTML 문자열 (operator-console idiom)
    ├── bridge-client.ts       // http-bridge REST 클라이언트
    ├── registry.ts            // vendors.json / devices.json 로더+CRUD
    └── approval-mint.ts       // SignedApproval 민팅 헬퍼 (@sangfor/operator 재사용)
```

**환경변수:** 포트 `PORT ?? CONTROL_TOWER_PORT ?? 3700` · 브리지 `CONTROL_TOWER_BRIDGE_URL ?? 'http://127.0.0.1:3600'` · 토큰 `SANGFOR_API_TOKEN`(타워 /api 게이트 + 브리지 호출 시 Bearer로 전달) · `SANGFOR_OPERATOR_APPROVAL_SECRET`(승인 민팅용, 미설정 시 승인 기능만 fail-closed).

**bridge-client.ts:**

```ts
export interface BridgeTool { name: string; description: string; inputSchema: unknown;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean }; category: string; }
export interface CallResult { ok: boolean; data?: unknown; errorText?: string; }

export class BridgeClient {
  constructor(baseUrl?: string, token?: string);
  health(): Promise<{ status: string; mcp: string } | { status: 'unreachable' }>;  // 실패도 값으로
  listTools(): Promise<BridgeTool[]>;          // 60초 캐시 (도구 목록은 사실상 정적)
  callTool(name: string, args: Record<string, unknown>, approval?: SignedApproval): Promise<CallResult>;
  // callTool 파싱: resp.result.structuredContent 우선, 없으면 content[0].text JSON.parse 시도,
  // isError=true → { ok:false, errorText: content[0].text }
}

export function safetyOf(t: BridgeTool): RunSafety;  // destructiveHint→'destructive', !readOnlyHint→'write', 그외 'read_only'
```

**API 라우트 (전체 — `/api/*`는 checkAuth 게이트):**

| 메서드·경로 | 요청 | 응답 | 설명 |
|---|---|---|---|
| `GET /` | — | HTML | 대시보드 (ui.ts) |
| `GET /api/overview` | — | `{ devices: DeviceSummary[], recentRuns: RunRecord[](limit 20), pendingApprovals: RunRecord[], health: HealthReport }` | 첫 화면 4위젯 단일 호출 |
| `GET /api/tools` | — | `{ groups: Record<category, BridgeTool[]> }` | 카탈로그 (bridge /tools 프록시 + category 그룹핑) |
| `POST /api/runs` | `{ toolId, args, deviceId? }` | `RunRecord` | 실행 요청. read_only → 즉시 실행 후 최종 레코드 반환. write/destructive → `pending_approval` 레코드 반환 |
| `GET /api/runs` | query: `status,toolId,deviceId,sweepId,sinceDays,limit` | `{ runs: RunRecord[] }` | 이력 조회. **목록 응답에서는 `resultJson` 제외**(용량) — 상세(`/api/runs/:id`)에서만 포함 |
| `GET /api/runs/:id` | — | `RunRecord` | 상세 (resultJson 포함) |
| `POST /api/runs/:id/approve` | `{ approvedBy, changeTicketId?, rollbackPlanId? }` | `RunRecord` | §6.2 승인 플로우. 민팅→실행→최종 레코드 |
| `POST /api/runs/:id/reject` | `{ reason }` | `RunRecord` | `pending_approval → rejected` |
| `GET /api/devices` | — | `{ devices: Device[], vendors: VendorDescriptor[] }` | 레지스트리 |
| `POST /api/devices` | `Device`(id 없이) | `Device` | 등록. `product`가 vendors.json에 없으면 400 |
| `PUT /api/devices/:id` | `Partial<Device>` | `Device` | 수정 |
| `DELETE /api/devices/:id` | — | `{ ok: true }` | 삭제 |
| `POST /api/sweep` | `{ deviceIds?: string[] }` (생략=전체) | `{ sweepId, runs: RunRecord[] }` | §6.3 일괄 자문 |
| `POST /api/approvals/mint` | `{ actionType, actionTarget, approvedBy, changeTicketId, rollbackPlanId, ttlSec? }` | `SignedApproval` | HCI 등 tool-args용 승인 수동 민팅 헬퍼 (§6.4) |
| `GET /api/health` | — | `HealthReport` | 시스템 건강도 |

**HealthReport (모든 항목 best-effort, 개별 3초 타임아웃, 실패도 값으로 표현):**

```ts
export interface HealthReport {
  bridge:      { ok: boolean; detail: string };  // bridge GET /health
  mcp:         { ok: boolean; detail: string };  // bridge health의 mcp 필드
  mockConsole: { ok: boolean; detail: string };  // GET http://127.0.0.1:3400/state (MOCK_CONSOLE_URL 오버라이드 가능)
  store:       { ok: boolean; detail: string };  // bridge 경유 sangfor.store_health 호출 (read-only)
  rag:         { ok: boolean; detail: string };  // bridge 경유 sangfor.rag_index_summary 호출 (read-only)
}
```

**UI (ui.ts — 서버렌더 단일 HTML + vanilla JS fetch, 한국어 레이블, operator-console 스타일 답습):**

- 좌측 네비: `대시보드 / 도구 실행 / 실행 이력 / 장비 관리 / (외부링크) 운영콘솔:3502 / (외부링크) Mock콘솔:3400`
- **대시보드:** 4위젯 그리드. ① 장비·자문 요약(장비별: 이름·product 라벨·최신 자문 run의 `summary.pass/fail`·`ok` 뱃지·시각, run 없으면 "미점검") ② 최근 실행 20건 (도구·상태색·소요·클릭→상세) ③ 승인 대기 큐 (도구·args 요약·[승인][거부] 버튼 — 승인 클릭 시 approvedBy 프롬프트) ④ 시스템 건강도 5항목 (녹/적)
- **도구 실행:** category 탭 → 도구 목록(안전등급 뱃지: 읽기=녹 / 쓰기=황 / 파괴적=적). 도구 선택 → inputSchema 기반 폼 자동생성: `type:string|number|boolean` + `enum` → 개별 필드(required 표시, default 채움), `object|array` 등 복잡 타입 → JSON textarea 폴백. 장비 선택 드롭다운(선택 시 디스크립터 `credentialFields`에 해당하는 인자 자동 채움 §5.4). 실행 → `POST /api/runs` → 결과 인라인 표시(읽기) 또는 "승인 대기로 이동" 안내(쓰기)
- **실행 이력:** 필터바(상태/도구/장비/기간) + 테이블 + 행 클릭 → 상세 모달(args·resultJson `<pre>` JSON 뷰어)
- **장비 관리:** 장비 테이블 + 추가/수정/삭제 폼(product 드롭다운은 vendors.json에서) + [전체 일괄 자문 실행] 버튼(→ `POST /api/sweep` → sweepId 필터로 이력 화면 이동)

### 5.4 벤더/장비 레지스트리 (`registry.ts` + `data/registry/*.json`)

**vendors.json (선언적 벤더 디스크립터 — repo 관리, 시드 3종 포함):**

```ts
export interface VendorDescriptor {
  product: string;             // 열린 값 (enum 아님). 예: 'FORTIOS'
  label: string;               // UI 표시명
  advisorTools: string[];      // 이 벤더 장비에 실행할 읽기전용 자문 도구 (sangfor.* 전체이름)
  credentialFields: string[];  // 자문 도구가 요구하는 장비 인자 이름들 (예: ['host','username','password'])
  defaultArgs?: Record<string, unknown>;  // 예: { specVersion: '8.0.0' }
}
```

시드 (`data/registry/vendors.json`):

```json
[
  { "product": "FORTIOS", "label": "Fortinet FortiOS",
    "advisorTools": ["sangfor.advisor_fortios", "sangfor.advisor_fortios_advanced"],
    "credentialFields": ["host", "username", "password"],
    "defaultArgs": { "specVersion": "8.0.0" } },
  { "product": "CISCO_IOSXE", "label": "Cisco IOS-XE",
    "advisorTools": ["sangfor.advisor_cisco_iosxe", "sangfor.advisor_cisco_iosxe_advanced"],
    "credentialFields": ["host", "username", "password"],
    "defaultArgs": { "specVersion": "17.0.0" } },
  { "product": "HCI_SCP", "label": "Sangfor HCI/SCP",
    "advisorTools": ["sangfor.hci_health_report"],
    "credentialFields": ["identityUrl", "username", "password"],
    "defaultArgs": {} }
]
```

> 시드의 `advisorTools`·`credentialFields`는 구현 시점에 각 도구의 실제 inputSchema와 대조 검증할 것 (통합 테스트로 고정 — §9 T-INT-2).

**devices.json (UI CRUD 대상):**

```ts
export interface Device {
  id: string;                  // nowId('dev')
  name: string;                // 예: '본사 방화벽 1호기'
  product: string;             // vendors.json의 product 참조 (등록 시 검증)
  host: string;                // IP/hostname (자문 인자 host로 주입)
  tags: string[];              // 예: ['고객사A', 'lab']
  credentialEnv?: Record<string, string>;
  // 예: { "username": "FGT_LAB_USER", "password": "FGT_LAB_PASS" }
  // 값은 env 변수 "이름". 실행 시 process.env에서 해석. 파일에 비밀값 저장 금지.
  createdAt: string;
  updatedAt: string;
}
```

**credential 해석 규칙 (sweep·장비선택 실행 공통):** 인자 병합 순서 = `vendors.defaultArgs` → `{ host: device.host }` → `credentialEnv` 해석값(`process.env[이름]`, 없으면 생략) → 사용자가 폼에 직접 입력한 값 (사용자 입력이 최우선). mock 장비는 credentialEnv 생략 가능(mock은 인증 안 함 — 도구 스키마상 required면 `'mock'` 문자열 폴백).

**로더:** `resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT')` 앵커. 쓰기는 `.tmp` + `renameSync` atomic (nonce-store 패턴). vendors.json 없으면 위 시드를 생성, devices.json 없으면 `[]` 생성.

**개방성 보증:** 타워 코드 어디에도 `'FORTIOS'` 같은 product 리터럴 분기가 없어야 한다 (테스트 T-REG-3: 가상의 `"ACME_FW"` 벤더 디스크립터를 주입하고 장비 등록→sweep 인자 구성까지 벤더별 분기 없이 동작함을 검증).

## 6. 핵심 플로우

### 6.1 읽기전용 실행 (즉시)

```
UI [실행] → POST /api/runs {toolId, args, deviceId?}
  → bridge /tools에서 안전등급 조회 (BridgeClient 캐시)
  → read_only: RunStore.createRun(initialStatus:'running')
  → BridgeClient.callTool(toolId, mergedArgs)
  → 성공: transition('succeeded', {resultJson, resultSummary, durationMs, finishedAt})
    실패: transition('failed', {error, ...})
  → 최종 RunRecord 응답 (UI에 결과 즉시 표시)
```

`resultSummary` 생성 규칙: 결과가 EvaluationResult(또는 evaluations[] 래핑)면 `ok=<bool> pass=<n> fail=<n>`, 아니면 JSON 첫 150자.

### 6.2 쓰기/파괴적 실행 (승인게이트)

```
UI [실행] → POST /api/runs → safety가 write|destructive
  → RunStore.createRun(initialStatus:'pending_approval') → 즉시 응답 (실행 안 함)
  → 대시보드 승인 큐에 노출
UI [승인] → POST /api/runs/:id/approve {approvedBy, changeTicketId?, rollbackPlanId?}
  → status 검증 (pending_approval 아니면 409)
  → SANGFOR_OPERATOR_APPROVAL_SECRET 미설정 → 500 'approval secret not configured' (fail-closed, 상태 불변)
  → approval-mint.ts: mintBridgeApproval(toolId, {approvedBy, changeTicketId: 기본 `run:<runId>`,
      rollbackPlanId: 기본 'n/a-read-back-verify', ttlSec: 120})
      = signApprovalToken(secret, {type:'bridge.tool-call', target: toolId}, {...base, nonce: randomBytes(12).hex, expiresAt: now+ttl})
  → transition('running', {approval: {approvedBy, approvedAt, changeTicketId, rollbackPlanId}})  // 토큰·nonce 저장 안 함
  → BridgeClient.callTool(toolId, args, signedApproval)   // bridge가 검증+nonce 소비 후 MCP 호출
  → succeeded | failed 전이 → 최종 RunRecord 응답
UI [거부] → POST /api/runs/:id/reject {reason} → 'rejected' 전이
```

- 승인 즉시 실행이므로 TTL 120초면 충분. 민팅된 approval은 메모리에서만 사용 후 폐기.
- **args는 run 생성 시점에 확정·저장된 값을 그대로 사용한다** — 승인 시 재병합·재입력 없음 (승인자가 본 것이 실행되는 것과 동일함을 보장). 단, 저장된 args는 마스킹본이므로 실행용 원본 args는 pending run 생성 시 메모리 맵(`runId → 원본args`)에 별도 보관하고 타워 재시작 시 소실되면 해당 pending run은 승인 시 400 `'원본 인자 소실 — 재요청 필요'`로 거부한다 (마스킹된 args로 실행하는 사고 방지).
- HCI 쓰기 도구(`hci_apply_create_volume` 등)는 bridge 통과 후 **MCP 내부 hciWriteGate가 tool-args의 approval을 추가 요구** — args에 §6.4로 민팅한 approval이 들어있어야 한다. 없으면 MCP가 거부하고 run은 `failed`로 기록된다 (이중 게이트는 의도된 다층 방어).

### 6.3 일괄 자문 sweep

```
POST /api/sweep {deviceIds?}
  → sweepId = nowId('sweep')
  → 대상 장비 각각에 대해: vendors[device.product].advisorTools 각각에 대해:
      args = defaultArgs ∪ {host} ∪ credentialEnv해석  (§5.4 병합 규칙)
      §6.1 읽기전용 실행 (deviceId·sweepId 태깅)
  → 동시성 3 (Promise pool), 도구당 bridge 30초 타임아웃에 위임
  → { sweepId, runs } 응답 (개별 실패는 해당 run만 failed — sweep 전체는 계속)
```

advisorTools에 read_only가 아닌 도구가 섞여 있으면 해당 도구만 skip하고 run을 `failed`(`error: 'sweep은 읽기전용 도구만 실행'`)로 기록 — 디스크립터 오기가 조용히 쓰기를 실행하는 사고 방지.

### 6.4 tool-args용 승인 민팅 헬퍼 (HCI 등)

`POST /api/approvals/mint`는 §4.4의 SignedApproval을 임의 action에 대해 민팅해 반환한다(저장 안 함). UI 도구 실행 폼에서 "승인 토큰 민팅" 버튼 → 반환 JSON을 args의 `approval` 필드에 자동 삽입. `scripts/mint-hci-approval.ts` CLI와 동일 결과물의 UI 버전. 시크릿 미설정 시 500 fail-closed.

## 7. 보안 불변식 (전 태스크 공통 — 위반 시 구현 중단하고 보고)

1. **`apps/mcp-server/src/index.ts` 및 `packages/sangfor-operator/*`는 수정 금지.** R1(nonce 단일사용)·R3(원격 write 정책) 봉인 유지. 승인 경로는 bridge와 타워에만 추가된다.
2. **bridge 기본 동작 무변경:** approval 미첨부 요청의 판정은 기존과 바이트 단위로 동일. 회귀 테스트 필수 (T-BR-1).
3. **fail-closed:** annotations 불명 → 거부. 시크릿 미설정 → 승인·민팅 불가. nonce 재사용 → 거부. 원격바인드 쓰기는 approval이 있어도 `SANGFOR_ALLOW_REMOTE_WRITE` 없이는 거부.
4. **비밀값 무저장:** RunRecord의 args·resultJson은 저장 전 maskSecrets 강제(저장소 계층에서). approvalToken·nonce는 RunRecord에 기록하지 않는다. devices.json에는 env 변수 "이름"만.
5. **approval은 action-bound + 단일사용:** `{type:'bridge.tool-call', target:<도구명>}`에 서명 — 다른 도구·다른 용도 재사용 불가. nonce는 기존 FileNonceStore 공유.
6. **타워 바인드 안전:** `assertBindSafety` — 비루프백 바인드는 토큰 없이 기동 자체가 실패.

## 8. 에러 처리

| 상황 | 동작 |
|---|---|
| bridge 다운/타임아웃 | run은 `failed`+error 기록(이력에 남음). overview의 health에 `bridge.ok:false`. UI 위젯은 "브리지 연결 불가" 표시하되 이력·장비 화면은 정상 동작 |
| MCP `isError:true` | `failed`, `error = content[0].text` |
| 승인 검증/nonce 실패 (bridge 403) | run `failed`, error에 bridge 메시지. **pending으로 되돌리지 않음** (재요청은 새 run) |
| 존재하지 않는 toolId | POST /api/runs 400 (bridge /tools 목록 대조) |
| approve 대상이 pending_approval 아님 | 409 |
| vendors.json에 없는 product로 장비 등록 | 400 |
| JSONL 파싱 불가 줄 | stderr 경고 + skip (기존 패턴) |
| resultJson 500KB 초과 | `{ truncated: true, note: 'result exceeded 500KB' }`로 대체, resultSummary는 유지 |

## 9. 테스트 전략 (`tests/` — 기존 310개 무회귀 필수)

| ID | 파일 | 검증 내용 |
|---|---|---|
| T-RUN-1 | `tests/sangfor-runs-store.test.ts` | 라이프사이클 전이(즉시실행·승인·거부), last-wins fold, requestedAt 정렬, 필터(status/toolId/deviceId/sweepId/limit), 재기동 후 재로드(새 RunStore 인스턴스), 미존재 runId transition throw |
| T-RUN-2 | 〃 | 마스킹: password/secret/token/authorization/cookie 키 → '***' (중첩 객체 포함), §4.6 regex와 문자열 단위 일치 고정 |
| T-BR-1 | `tests/http-bridge-approval-guard.test.ts` | **회귀:** approval 미첨부 시 기존 5규칙 판정 완전 동일 (읽기 허용/쓰기 거부/파괴적 거부/annotations 없음 거부/원격쓰기 거부) |
| T-BR-2 | 〃 | 유효 approval → 쓰기·파괴적 허용. 잘못된 서명/만료/다른 도구명 target/nonce 재사용 → 403. 시크릿 미설정 → 403. nonce 스토어는 `SANGFOR_NONCE_STORE_PATH`로 임시 파일 격리 |
| T-REG-1 | `tests/control-tower-registry.test.ts` | vendors/devices 로드, 시드 자동생성, atomic write, product 검증(400 사유), CRUD |
| T-REG-2 | 〃 | 인자 병합 규칙: defaultArgs < host < credentialEnv < 사용자입력 우선순위 |
| T-REG-3 | 〃 | **개방성:** 가상 벤더 `ACME_FW` 디스크립터 주입 → 장비 등록·sweep 인자 구성이 코드 수정 없이 동작 |
| T-API-1 | `tests/control-tower-api.test.ts` | 라우팅·인증(토큰 유/무)·read_only 즉시실행·write pending 생성·approve(민팅→실행 mock bridge 대조)·reject·409/400 케이스. bridge는 로컬 stub http 서버로 대체(`CONTROL_TOWER_BRIDGE_URL` 주입) |
| T-API-2 | 〃 | overview 4위젯 형태, health 부분실패 표현(stub 다운 시 ok:false) |
| T-INT-1 | `tests/control-tower-e2e.test.ts` | 실제 bridge 로직(guard 포함)을 in-process로 조립: 읽기 실행→이력 기록→쓰기 pending→승인→bridge 통과→(stub MCP) 실행→succeeded 전체 체인 |
| T-INT-2 | 〃 | vendors.json 시드의 advisorTools가 실제 MCP listTools에 존재하고 전부 read_only인지 검증 |

## 10. 환경변수 (신규만 — 기존은 §4 참조)

| 변수 | 기본값 | 용도 |
|---|---|---|
| `CONTROL_TOWER_PORT` | `3700` | 타워 포트 (`PORT`가 우선) |
| `CONTROL_TOWER_BRIDGE_URL` | `http://127.0.0.1:3600` | bridge 주소 |
| `SANGFOR_RUNS_ROOT` | `<repo>/data/runs` | 실행이력 JSONL 루트 |
| `SANGFOR_REGISTRY_ROOT` | `<repo>/data/registry` | 벤더/장비 레지스트리 루트 |
| `MOCK_CONSOLE_URL` | `http://127.0.0.1:3400` | 건강도 점검 대상 |

`.env.example`에 위 5종 추가. `.gitignore`에 `data/runs/` 추가 (실행이력은 로컬 데이터). `data/registry/`는 **커밋 대상** (vendors.json 시드는 코드리뷰 대상, devices.json은 로컬마다 다르므로 `data/registry/devices.json`만 gitignore).

## 11. 기존 시스템 영향

- `apps/mcp-server`, `packages/sangfor-operator`, `apps/operator-console`: **무수정**
- `apps/mock-sangfor-console`: **추가 라우트만 허용, 기존 라우트 무변경.** advisor 도구는 실제 벤더 API 경로(`/api/v2/*`, `/restconf/*`)를 조회하는데 mock은 `/api/v1/*` 경로만 서빙하므로, 기존 핸들러를 실제 경로에 alias 등록해야 라이브 sweep이 가능하다 (advisor의 `host` 인자는 `http://127.0.0.1:3400` 같은 전체 base URL 허용 — `apiBaseUrl()` 확인됨)
- `apps/http-bridge`: tool-guard 확장(승인 분기) + server.ts의 approval 필드 전달 (기본 동작 무변경, T-BR-1로 고정)
- 루트 `package.json`: `dev:control-tower` 스크립트 추가
- `tsconfig.json` paths + `vitest.config.ts` alias: `@sangfor/runs` 추가
- `.env.example`, `.gitignore`: §10

## 12. 수용 기준 (전체 완료 판정)

1. `npm test` 전체 통과 (기존 310+ 및 신규 전부), `npm run lint` clean, `npm run build` clean
2. `pnpm dev:mock-console` + `pnpm dev:http-bridge` + `pnpm dev:control-tower` 기동 후:
   - `http://127.0.0.1:3700` 대시보드 4위젯 렌더
   - mock FortiOS 장비 등록 → [전체 일괄 자문 실행] → 대시보드 장비 요약에 pass/fail 표시
   - `sangfor.advisor_fortios_advanced` 폼 실행 → 즉시 결과 + 이력 기록
   - 쓰기 도구(예: `sangfor.pm_create_engagement`) 실행 → 승인 큐 → 승인 → 실행 성공 → 이력에 approval 메타 기록
   - 같은 승인으로 재실행 불가(신규 run + 신규 승인 필요), 거부 시 rejected 기록
3. 타워 프로세스 재시작 후 이력·장비·pending 큐 유지 (파일 영속)
4. approval 미첨부 bridge 호출의 동작이 기존과 동일함을 T-BR-1이 증명
