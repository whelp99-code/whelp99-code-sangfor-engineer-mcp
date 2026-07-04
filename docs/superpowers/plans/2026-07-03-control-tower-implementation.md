# Control Tower 구현 플랜 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP 도구 77종을 한 화면에서 보고(대시보드)·실행하고(승인게이트 포함)·기록하는(JSONL 이력) 컨트롤타워(`apps/control-tower`, :3700)를 기존 시스템 무회귀로 구축한다.

**Architecture:** 타워는 http-bridge(:3600)의 REST 클라이언트로만 동작하고, 쓰기/파괴적 도구는 타워가 민팅한 SignedApproval(HMAC, action-bound, 단일사용 nonce)을 bridge tool-guard가 검증한 뒤에만 통과한다. 실행이력은 신규 패키지 `@sangfor/runs`의 append-only JSONL 스냅샷(last-wins fold)에 저장하고, 벤더/장비는 선언적 디스크립터(`data/registry/*.json`)로 관리해 타워 코드에 벤더 하드코딩이 0이 되게 한다.

**Tech Stack:** TypeScript(NodeNext ESM), raw `node:http`, vanilla JS 단일 HTML UI, vitest, pnpm workspace. 신규 런타임 의존성 없음.

**스펙:** `docs/superpowers/specs/2026-07-03-control-tower-design.md` (사용자 승인본). 이 플랜의 §숫자 인용은 그 문서 기준.

## Global Constraints (모든 태스크에 암묵 포함 — 위반 시 구현 중단하고 보고)

- **`apps/mcp-server/**`와 `packages/sangfor-operator/**`는 동결(FROZEN).** 수정 금지. R1(nonce 단일사용)·R3(원격 write 정책) 봉인 유지.
- **bridge 기본 동작 무변경:** approval 미첨부 `/tools/call` 판정은 기존과 완전 동일해야 한다. Task 3의 T-BR-1 회귀 테스트가 이를 고정한다.
- **fail-closed:** annotations 불명 → 거부. `SANGFOR_OPERATOR_APPROVAL_SECRET` 미설정 → 승인·민팅 불가. nonce 재사용 → 거부. 원격바인드 쓰기는 유효 approval이 있어도 `SANGFOR_ALLOW_REMOTE_WRITE=true` 없이는 거부.
- **비밀값 무저장:** RunRecord의 args/resultJson은 저장소 계층에서 강제 마스킹. approvalToken·nonce는 RunRecord에 기록하지 않는다. devices.json에는 env 변수 "이름"만 저장.
- **approval은 action-bound + 단일사용:** `{type:'bridge.tool-call', target:<도구명>}`에 서명. nonce는 기존 `FileNonceStore` 공유.
- **바인드 안전:** 타워는 `assertBindSafety` 통과 후에만 listen (비루프백+무토큰 → 기동 실패).
- **모듈 규칙(NodeNext):** 상대 import는 `.js` 확장자 필수. 앱은 패키지를 상대경로 deep import(`'../../../packages/...'`), 패키지는 패키지명(`'@sangfor/shared'`) import. **`@sangfor/operator`의 index.ts는 approval.ts를 재수출하지 않으므로** `signApprovalToken`/`verifyExecutionApproval`/`SignedApproval`은 반드시 deep import: 앱에서 `'../../../packages/sangfor-operator/src/approval.js'`, 테스트에서 `'../packages/sangfor-operator/src/approval.js'`.
- **테스트:** 루트 `tests/**/*.test.ts` (vitest, co-located 금지). 단일 파일 실행: `pnpm exec vitest run tests/<파일>.test.ts` · 전체: `npm test` · 타입체크: `npm run lint`.
- **데이터 루트:** 반드시 `resolveRepoData('<subdir>', '<ENV_VAR>')` 앵커 (cwd 무관).
- **UI 레이블은 한국어**, 코드/식별자/커밋 메시지는 영어. 커밋은 conventional commit, 본문 마지막에 빈 줄 후 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **UI 클라이언트 JS 제약:** `ui.ts`는 서버측 템플릿 리터럴 하나로 HTML을 만든다. 클라이언트 JS 안에서 backtick과 `${`를 쓰면 서버 리터럴이 깨지므로 **문자열 연결(+)만 사용**한다 (의도된 서버측 보간 1곳 제외).

## 파일 구조 (전체 생성/수정 대상)

```
packages/sangfor-runs/                    [신규] 실행이력 저장소 (@sangfor/runs)
├── package.json
└── src/{index.ts, mask.ts, run-store.ts}
apps/http-bridge/src/tool-guard.ts        [수정] 승인 분기 추가 (Task 3)
apps/http-bridge/src/server.ts            [수정] body.approval 전달 (Task 3)
apps/control-tower/                       [신규] 컨트롤타워 (:3700)
├── package.json
└── src/{server.ts, api.ts, ui.ts, bridge-client.ts, registry.ts, approval-mint.ts}
apps/mock-sangfor-console/src/vendor-paths.ts  [신규] 벤더 네이티브 경로 응답 (Task 10)
apps/mock-sangfor-console/src/server.ts   [수정] vendor-paths 디스패치 1블록 추가 (Task 10)
data/registry/vendors.json                [신규·커밋] 시드 3벤더 (Registry가 자동생성, 커밋 대상)
tsconfig.json / vitest.config.ts          [수정] @sangfor/runs 별칭 (Task 1)
package.json                              [수정] dev:control-tower 스크립트 (Task 9)
.env.example / .gitignore                 [수정] §10 신규 env 5종 / data 경로 (Task 4, 9)
tests/sangfor-runs-store.test.ts          [신규] T-RUN-1·2
tests/http-bridge-approval-guard.test.ts  [신규] T-BR-1·2
tests/control-tower-registry.test.ts      [신규] T-REG-1·2·3
tests/control-tower-bridge-client.test.ts [신규] BridgeClient 단위
tests/control-tower-approval-mint.test.ts [신규] 민팅 round-trip
tests/control-tower-api.test.ts           [신규] T-API-1·2
tests/mock-vendor-paths.test.ts           [신규] mock 벤더 경로 (라이브 sweep 전제)
tests/control-tower-e2e.test.ts           [신규] T-INT-1·2
```

**태스크 의존성:** 1→2→(3, 4, 5, 6 순서 무관하나 번호순 권장)→7→8→9, 10은 독립(언제든), 11은 3·7·8·10 완료 후, 12는 마지막.

**스펙 교정 2건 (구현 시 이 플랜이 우선):**
1. 스펙 §5.4 시드의 HCI_SCP `credentialFields`는 `["identityUrl", ...]`이지만 실제 `sangfor.hci_health_report` inputSchema 속성명은 **`identityBaseUrl`**이다. 시드는 `identityBaseUrl`로 쓴다 (T-INT-2가 스키마 대조로 고정).
2. 스펙 §5.2 승인 분기 순서(검증→nonce소비→원격쓰기검사)와 달리 **nonce 소비를 마지막**(원격쓰기 검사 통과 후, allow 직전)에 둔다. 거부되는 호출이 단일사용 nonce를 태워버리면 승인자가 재승인해야 하는 사고가 되기 때문. 서명 검증이 먼저이므로 보안성은 동일하다 (T-BR-2가 "거부는 nonce를 소비하지 않는다"를 고정).

---
### Task 1: `@sangfor/runs` 패키지 스캐폴드 + 비밀값 마스킹 (T-RUN-2)

**Files:**
- Create: `packages/sangfor-runs/package.json`
- Create: `packages/sangfor-runs/src/index.ts`
- Create: `packages/sangfor-runs/src/mask.ts`
- Modify: `tsconfig.json` (paths에 1항목), `vitest.config.ts` (alias에 1줄)
- Test: `tests/sangfor-runs-store.test.ts` (마스킹 부분 — RunStore 테스트는 Task 2에서 같은 파일에 추가)

**Interfaces:**
- Consumes: `@sangfor/hci-client`의 `maskSecrets` (패리티 테스트 전용)
- Produces: `maskSecrets<T>(value: T): T` — Task 2의 RunStore, 이후 모든 태스크가 `@sangfor/runs`로 import

- [ ] **Step 1: 패키지 스캐폴드 생성**

`packages/sangfor-runs/package.json`:

```json
{
  "name": "@sangfor/runs",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@sangfor/shared": "workspace:*"
  }
}
```

`packages/sangfor-runs/src/index.ts`:

```ts
export * from './mask.js';
export * from './run-store.js';
```

(`run-store.ts`는 Task 2에서 만든다. Task 1 동안 index.ts는 임시로 `export * from './mask.js';` 한 줄만 두고, Task 2 Step 3에서 두 줄로 바꾼다.)

- [ ] **Step 2: 별칭 등록 (tsconfig + vitest 둘 다 — 하나만 하면 테스트 or lint가 깨진다)**

`tsconfig.json`의 `"paths"` 객체에서 `"@sangfor-engineer/cisco-client"` 항목 뒤에 추가:

```json
      "@sangfor-engineer/cisco-client": [
        "packages/cisco-client/src/index.ts"
      ],
      "@sangfor/runs": [
        "packages/sangfor-runs/src/index.ts"
      ]
```

`vitest.config.ts`의 `resolve.alias` 객체 안 `'@sangfor/rag'` 줄 다음에 추가:

```ts
      '@sangfor/rag': fromRoot('./packages/sangfor-rag/src/index.ts'),
      '@sangfor/runs': fromRoot('./packages/sangfor-runs/src/index.ts'),
```

- [ ] **Step 3: 실패하는 테스트 작성**

`tests/sangfor-runs-store.test.ts` 신규 생성:

```ts
import { describe, expect, it } from 'vitest';
import { maskSecrets } from '@sangfor/runs';
import { maskSecrets as hciMaskSecrets } from '@sangfor/hci-client';

// §4.6 마스킹 계약: /password|secret|token|authorization|cookie/i 키 + string 값 → '***'
describe('maskSecrets — @sangfor/runs 복제본 (T-RUN-2)', () => {
  const fixture = {
    username: 'admin',
    password: 'p@ss',
    nested: {
      apiToken: 'tok123',
      Authorization: 'Bearer x',
      list: [{ cookie: 'c=1', keep: 42 }],
    },
    secretNote: 'text',
    count: 3,
  };

  it('masks matching keys with string values, recursively, arrays included', () => {
    const masked = maskSecrets(fixture) as typeof fixture;
    expect(masked.password).toBe('***');
    expect(masked.nested.apiToken).toBe('***');
    expect(masked.nested.Authorization).toBe('***');
    expect(masked.nested.list[0].cookie).toBe('***');
    expect(masked.secretNote).toBe('***'); // 'secret' substring match
    expect(masked.username).toBe('admin');
    expect(masked.nested.list[0].keep).toBe(42);
    expect(masked.count).toBe(3);
  });

  it('does not mutate the input and leaves non-string secret values untouched', () => {
    const input = { password: 123, meta: { token: true } };
    const masked = maskSecrets(input) as typeof input;
    expect(masked.password).toBe(123);
    expect(masked.meta.token).toBe(true);
    expect(input.password).toBe(123);
  });

  it('behaves identically to the hci-client original (regex 계약 동기화 고정)', () => {
    expect(maskSecrets(fixture)).toEqual(hciMaskSecrets(fixture));
  });
});
```

- [ ] **Step 4: 테스트가 실패하는지 확인**

Run: `pnpm exec vitest run tests/sangfor-runs-store.test.ts`
Expected: FAIL — `Cannot find module` 계열 (mask.ts 미존재)

- [ ] **Step 5: mask.ts 구현**

`packages/sangfor-runs/src/mask.ts`:

```ts
// Replicated from packages/sangfor-hci-client/src/audit-ledger.ts so run history
// gets the same masking without a domain dependency on the HCI client. Keep the
// regex in sync with the original — tests/sangfor-runs-store.test.ts pins parity.
const SECRET_KEY_RE = /password|secret|token|authorization|cookie/i;

export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' ? '***' : maskSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm exec vitest run tests/sangfor-runs-store.test.ts`
Expected: PASS (3 tests)

Run: `npm run lint`
Expected: 에러 0 (tsconfig paths 오타 검증)

- [ ] **Step 7: Commit**

```bash
git add packages/sangfor-runs tsconfig.json vitest.config.ts tests/sangfor-runs-store.test.ts
git commit -m "feat(runs): add @sangfor/runs package with secret masking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: RunStore — append-only JSONL 실행이력 저장소 (T-RUN-1)

**Files:**
- Create: `packages/sangfor-runs/src/run-store.ts`
- Modify: `packages/sangfor-runs/src/index.ts` (run-store 재수출)
- Test: `tests/sangfor-runs-store.test.ts` (Task 1 파일에 describe 추가)

**Interfaces:**
- Consumes: `maskSecrets` (Task 1), `nowId`/`resolveRepoData` (`@sangfor/shared`)
- Produces (이후 태스크 전부가 의존):
  - `type RunStatus = 'pending_approval'|'rejected'|'running'|'succeeded'|'failed'`
  - `type RunSafety = 'read_only'|'write'|'destructive'`
  - `interface RunRecord`, `interface ListRunsOptions` (스펙 §5.1 전문)
  - `class RunStore { constructor(dir?); createRun(input); transition(runId, patch); getRun(runId); listRuns(opts?); pendingApprovals(); }`

**저장 설계 (스펙 §5.1 — 구현 불변식):** 파일명은 해당 run의 `requestedAt.slice(0,10)`. **한 run의 모든 스냅샷은 같은 파일에 append**되므로(전이가 며칠 걸려도 requestedAt 기준) run은 정확히 한 파일에만 존재한다 — `getRun`은 파일들을 최신 날짜부터 스캔해 첫 히트를 반환하면 된다. 파일 rewrite 금지.

- [ ] **Step 1: 실패하는 테스트 작성 — `tests/sangfor-runs-store.test.ts`에 아래 describe 2개 추가**

```ts
import { afterEach, beforeEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore, type RunRecord } from '@sangfor/runs';

const tick = () => new Promise((r) => setTimeout(r, 5)); // requestedAt(ms) 정렬 결정성

describe('RunStore — 라이프사이클/영속/필터 (T-RUN-1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'runs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('immediate execution lifecycle: running → succeeded', () => {
    const store = new RunStore(dir);
    const run = store.createRun({
      toolId: 'sangfor.products', toolSafety: 'read_only',
      args: { q: 'hci' }, initialStatus: 'running',
    });
    expect(run.runId).toMatch(/^run_/);
    expect(run.schemaVersion).toBe(1);
    const done = store.transition(run.runId, {
      status: 'succeeded', resultJson: { ok: true }, resultSummary: 'ok',
      durationMs: 12, finishedAt: new Date().toISOString(),
    });
    expect(done.status).toBe('succeeded');
    expect(store.getRun(run.runId)?.status).toBe('succeeded');
  });

  it('approval lifecycle: pending_approval → running(approval meta) → succeeded, 큐 비워짐', () => {
    const store = new RunStore(dir);
    const run = store.createRun({
      toolId: 'sangfor.pm_create_engagement', toolSafety: 'write',
      args: { customer: 'acme' }, initialStatus: 'pending_approval',
    });
    expect(store.pendingApprovals().map((r) => r.runId)).toContain(run.runId);
    store.transition(run.runId, {
      status: 'running',
      approval: { approvedBy: 'jmpark', approvedAt: new Date().toISOString(), changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1' },
    });
    store.transition(run.runId, { status: 'succeeded', finishedAt: new Date().toISOString() });
    expect(store.pendingApprovals()).toHaveLength(0);
    const final = store.getRun(run.runId)!;
    expect(final.approval?.approvedBy).toBe('jmpark');
    expect(final.status).toBe('succeeded');
  });

  it('reject lifecycle + unknown runId transition throws', () => {
    const store = new RunStore(dir);
    const run = store.createRun({ toolId: 't', toolSafety: 'write', args: {}, initialStatus: 'pending_approval' });
    const rejected = store.transition(run.runId, { status: 'rejected', rejectedReason: 'no ticket' });
    expect(rejected.rejectedReason).toBe('no ticket');
    expect(() => store.transition('run_none', { status: 'failed' })).toThrow(/unknown runId/);
  });

  it('재기동 생존: 새 RunStore 인스턴스가 last-wins fold로 최종 상태를 읽는다', () => {
    const a = new RunStore(dir);
    const run = a.createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'running' });
    a.transition(run.runId, { status: 'failed', error: 'boom' });
    const b = new RunStore(dir);
    expect(b.getRun(run.runId)?.status).toBe('failed');
    expect(b.getRun(run.runId)?.error).toBe('boom');
  });

  it('requestedAt 내림차순 정렬 + limit + 필터(status/toolId/deviceId/sweepId)', async () => {
    const store = new RunStore(dir);
    const r1 = store.createRun({ toolId: 'a', toolSafety: 'read_only', args: {}, deviceId: 'dev_1', initialStatus: 'running' });
    await tick();
    const r2 = store.createRun({ toolId: 'b', toolSafety: 'read_only', args: {}, sweepId: 'sweep_1', initialStatus: 'running' });
    await tick();
    const r3 = store.createRun({ toolId: 'a', toolSafety: 'write', args: {}, initialStatus: 'pending_approval' });
    const all = store.listRuns();
    expect(all.map((r) => r.runId)).toEqual([r3.runId, r2.runId, r1.runId]);
    expect(store.listRuns({ limit: 2 })).toHaveLength(2);
    expect(store.listRuns({ toolId: 'a' }).map((r) => r.runId).sort()).toEqual([r1.runId, r3.runId].sort());
    expect(store.listRuns({ deviceId: 'dev_1' })[0].runId).toBe(r1.runId);
    expect(store.listRuns({ sweepId: 'sweep_1' })[0].runId).toBe(r2.runId);
    expect(store.listRuns({ status: 'pending_approval' })[0].runId).toBe(r3.runId);
  });

  it('sinceDays: 오래된 파일은 기본(14일) 스캔에서 제외, sinceDays 확대 시 포함', () => {
    const store = new RunStore(dir);
    const old: RunRecord = {
      schemaVersion: 1, runId: 'run_old', toolId: 'a', toolSafety: 'read_only',
      args: {}, status: 'succeeded', requestedAt: '2020-01-01T00:00:00.000Z',
    };
    writeFileSync(join(dir, '2020-01-01.jsonl'), `${JSON.stringify(old)}\n`);
    expect(store.listRuns().find((r) => r.runId === 'run_old')).toBeUndefined();
    expect(store.listRuns({ sinceDays: 10_000 }).find((r) => r.runId === 'run_old')).toBeDefined();
    expect(store.getRun('run_old')?.status).toBe('succeeded'); // getRun은 전 파일 스캔
  });

  it('파싱 불가 줄은 경고 후 skip (파일 전체를 버리지 않는다)', () => {
    const store = new RunStore(dir);
    const run = store.createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'running' });
    appendFileSync(join(dir, `${run.requestedAt.slice(0, 10)}.jsonl`), 'not-json\n');
    expect(store.listRuns().map((r) => r.runId)).toContain(run.runId);
  });
});

describe('RunStore — 마스킹·용량 불변식 (T-RUN-2)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'runs-mask-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('createRun과 transition은 저장 직전 args/resultJson을 강제 마스킹한다', () => {
    const store = new RunStore(dir);
    const run = store.createRun({
      toolId: 't', toolSafety: 'read_only',
      args: { host: 'h', password: 'hunter2', nested: { apiToken: 'x' } },
      initialStatus: 'running',
    });
    expect(run.args.password).toBe('***');
    expect((run.args.nested as Record<string, unknown>).apiToken).toBe('***');
    const done = store.transition(run.runId, { status: 'succeeded', resultJson: { secretKey: 'v', keep: 1 } });
    expect((done.resultJson as Record<string, unknown>).secretKey).toBe('***');
    expect((done.resultJson as Record<string, unknown>).keep).toBe(1);
  });

  it('resultJson 500KB 초과 시 truncated 마커로 대체, resultSummary는 유지', () => {
    const store = new RunStore(dir);
    const run = store.createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'running' });
    const done = store.transition(run.runId, {
      status: 'succeeded', resultSummary: 'big', resultJson: { blob: 'x'.repeat(600_000) },
    });
    expect(done.resultJson).toEqual({ truncated: true, note: 'result exceeded 500KB' });
    expect(done.resultSummary).toBe('big');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm exec vitest run tests/sangfor-runs-store.test.ts`
Expected: FAIL — `RunStore` export 없음

- [ ] **Step 3: run-store.ts 구현 + index.ts 갱신**

`packages/sangfor-runs/src/index.ts`를 다음으로 교체:

```ts
export * from './mask.js';
export * from './run-store.js';
```

`packages/sangfor-runs/src/run-store.ts`:

```ts
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowId, resolveRepoData } from '@sangfor/shared';
import { maskSecrets } from './mask.js';

export type RunStatus = 'pending_approval' | 'rejected' | 'running' | 'succeeded' | 'failed';
export type RunSafety = 'read_only' | 'write' | 'destructive';

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  toolId: string;
  toolSafety: RunSafety;
  args: Record<string, unknown>;
  status: RunStatus;
  requestedAt: string;
  finishedAt?: string;
  durationMs?: number;
  resultSummary?: string;
  resultJson?: unknown;
  error?: string;
  deviceId?: string;
  sweepId?: string;
  approval?: { approvedBy: string; approvedAt: string; changeTicketId: string; rollbackPlanId: string };
  rejectedReason?: string;
}

export interface ListRunsOptions {
  status?: RunStatus;
  toolId?: string;
  deviceId?: string;
  sweepId?: string;
  sinceDays?: number;
  limit?: number;
}

const RESULT_JSON_MAX_CHARS = 500_000;
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function capResultJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    if (JSON.stringify(value).length > RESULT_JSON_MAX_CHARS) {
      return { truncated: true, note: 'result exceeded 500KB' };
    }
  } catch {
    return { truncated: true, note: 'result not serializable' };
  }
  return value;
}

// Append-only snapshot JSONL. One line = a full RunRecord snapshot; the last
// line per runId wins. Every snapshot of a run appends to the SAME date file
// (keyed by requestedAt), so a run lives in exactly one file. Never rewrite
// files — prior snapshots remain for auditability.
export class RunStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveRepoData('data/runs', 'SANGFOR_RUNS_ROOT');
  }

  createRun(input: {
    toolId: string;
    toolSafety: RunSafety;
    args: Record<string, unknown>;
    deviceId?: string;
    sweepId?: string;
    initialStatus: RunStatus;
  }): RunRecord {
    const record: RunRecord = {
      schemaVersion: 1,
      runId: nowId('run'),
      toolId: input.toolId,
      toolSafety: input.toolSafety,
      args: maskSecrets(input.args),
      status: input.initialStatus,
      requestedAt: new Date().toISOString(),
    };
    if (input.deviceId) record.deviceId = input.deviceId;
    if (input.sweepId) record.sweepId = input.sweepId;
    this.append(record);
    return record;
  }

  transition(runId: string, patch: Partial<RunRecord> & { status: RunStatus }): RunRecord {
    const current = this.getRun(runId);
    if (!current) throw new Error(`unknown runId: ${runId}`);
    const next: RunRecord = {
      ...current,
      ...patch,
      schemaVersion: 1,
      runId: current.runId,
      toolId: current.toolId,
      toolSafety: current.toolSafety,
      requestedAt: current.requestedAt,
    };
    next.args = maskSecrets(patch.args ?? current.args);
    if ('resultJson' in patch) next.resultJson = capResultJson(maskSecrets(patch.resultJson));
    this.append(next);
    return next;
  }

  getRun(runId: string): RunRecord | undefined {
    for (const file of this.listFiles().slice().reverse()) {
      const hit = this.foldFile(join(this.dir, file)).get(runId);
      if (hit) return hit;
    }
    return undefined;
  }

  listRuns(opts: ListRunsOptions = {}): RunRecord[] {
    const sinceDays = opts.sinceDays ?? 14;
    const limit = opts.limit ?? 100;
    const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const records: RunRecord[] = [];
    for (const file of this.listFiles()) {
      if (file.slice(0, 10) < cutoff) continue;
      for (const record of this.foldFile(join(this.dir, file)).values()) records.push(record);
    }
    const filtered = records.filter((r) =>
      (!opts.status || r.status === opts.status) &&
      (!opts.toolId || r.toolId === opts.toolId) &&
      (!opts.deviceId || r.deviceId === opts.deviceId) &&
      (!opts.sweepId || r.sweepId === opts.sweepId));
    filtered.sort((a, b) =>
      a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : a.runId < b.runId ? 1 : -1);
    return filtered.slice(0, limit);
  }

  pendingApprovals(): RunRecord[] {
    return this.listRuns({ status: 'pending_approval' });
  }

  private listFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => FILE_RE.test(f)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private foldFile(path: string): Map<string, RunRecord> {
    const out = new Map<string, RunRecord>();
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw error;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as RunRecord;
        if (record && typeof record.runId === 'string') out.set(record.runId, record);
      } catch {
        process.stderr.write(`[runs] skipping unparseable line in ${path}\n`);
      }
    }
    return out;
  }

  private append(record: RunRecord): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${record.requestedAt.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm exec vitest run tests/sangfor-runs-store.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sangfor-runs tests/sangfor-runs-store.test.ts
git commit -m "feat(runs): append-only JSONL RunStore with masking invariant

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 3: http-bridge 승인 통과 경로 (T-BR-1 · T-BR-2)

**Files:**
- Modify: `apps/http-bridge/src/tool-guard.ts` (전체 교체본 아래 제공)
- Modify: `apps/http-bridge/src/server.ts:160-181` (POST /tools/call 블록)
- Test: `tests/http-bridge-approval-guard.test.ts` (신규)

**Interfaces:**
- Consumes: `verifyExecutionApproval`/`signApprovalToken`/`SignedApproval` (deep import from `packages/sangfor-operator/src/approval.js`), `consumeApprovalNonce` (`.../nonce-store.js`)
- Produces: `authorizeToolCall(params)` 확장 시그니처(아래), `BRIDGE_APPROVAL_ACTION_TYPE = 'bridge.tool-call'` — Task 6의 민팅 헬퍼와 Task 11의 T-INT-1이 이 계약에 묶인다

**중요:** `consumeApprovalNonce`는 호출 시마다 `SANGFOR_NONCE_STORE_PATH` env를 다시 읽으므로 테스트는 이 env를 임시 파일로 격리한다 (`tests/operator-nonce-store.test.ts` idiom).

- [ ] **Step 1: T-BR-1 회귀 테스트 먼저 작성 (코드 수정 전 — 현행 동작을 고정)**

`tests/http-bridge-approval-guard.test.ts` 신규 생성:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { authorizeToolCall } from '../apps/http-bridge/src/tool-guard.js';
import { signApprovalToken, type SignedApproval } from '../packages/sangfor-operator/src/approval.js';

const toolList = {
  tools: [
    { name: 'ro', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'write', annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'destructive', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'noannot', annotations: {} },
  ],
};

// T-BR-1: approval 미첨부 시 기존 5규칙 판정이 바이트 단위로 동일해야 한다.
describe('authorizeToolCall — 무승인 경로 회귀 고정 (T-BR-1)', () => {
  it('read-only allowed regardless of whitelist', () => {
    expect(authorizeToolCall({ name: 'ro', toolListResult: toolList, enforceWhitelist: true }).allow).toBe(true);
    expect(authorizeToolCall({ name: 'ro', toolListResult: toolList, enforceWhitelist: false }).allow).toBe(true);
  });
  it('destructive ALWAYS refused without approval', () => {
    const d = authorizeToolCall({ name: 'destructive', toolListResult: toolList, enforceWhitelist: false });
    expect(d).toEqual({ allow: false, status: 403, error: 'Destructive tool refused by MCP annotations: destructive' });
  });
  it('write refused when whitelist enforced, allowed when disabled', () => {
    expect(authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true })).toEqual(
      { allow: false, status: 403, error: 'Tool is not annotated read-only: write' });
    expect(authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: false }).allow).toBe(true);
  });
  it('missing annotations refused (fail-closed)', () => {
    expect(authorizeToolCall({ name: 'noannot', toolListResult: toolList, enforceWhitelist: false })).toEqual(
      { allow: false, status: 403, error: 'Tool annotations unavailable; refusing call: noannot' });
  });
  it('remote-bind write refused without allowRemoteWrite (R3)', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: false, remoteBind: true, allowRemoteWrite: false });
    expect(d.allow).toBe(false);
    expect(d.status).toBe(403);
    expect(d.error).toMatch(/remote/i);
  });
});
```

- [ ] **Step 2: T-BR-1이 현행 코드로 통과하는지 확인 후 즉시 커밋 (회귀 기준선)**

Run: `pnpm exec vitest run tests/http-bridge-approval-guard.test.ts`
Expected: PASS (5 tests — 아직 코드 무수정 상태)

```bash
git add tests/http-bridge-approval-guard.test.ts
git commit -m "test(bridge): pin pre-approval guard behavior (T-BR-1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: T-BR-2 실패하는 테스트 추가 — 같은 파일 하단에 append**

```ts
// ─── T-BR-2: 승인 통과 경로 ─────────────────────────────────────────────────
const SECRET = 'bridge-test-secret';
const BRIDGE_ACTION = 'bridge.tool-call';

function mint(toolName: string, opts: { secret?: string; ttlMs?: number; nonce?: string } = {}): SignedApproval {
  const base = {
    approvedBy: 'tester',
    changeTicketId: 'CHG-1',
    rollbackPlanId: 'RB-1',
    nonce: opts.nonce ?? randomBytes(8).toString('hex'),
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? 60_000)).toISOString(),
  };
  return { ...base, approvalToken: signApprovalToken(opts.secret ?? SECRET, { type: BRIDGE_ACTION, target: toolName }, base) };
}

describe('authorizeToolCall — 서명 승인 통과 경로 (T-BR-2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-approval-'));
    process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
  });
  afterEach(() => {
    delete process.env.SANGFOR_NONCE_STORE_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('valid approval allows a write tool even with the whitelist enforced', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('write'), approvalSecret: SECRET });
    expect(d).toEqual({ allow: true });
  });

  it('valid approval allows a destructive tool', () => {
    const d = authorizeToolCall({ name: 'destructive', toolListResult: toolList, enforceWhitelist: true, approval: mint('destructive'), approvalSecret: SECRET });
    expect(d.allow).toBe(true);
  });

  it('signature minted with a different secret is refused', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('write', { secret: 'wrong' }), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.status).toBe(403);
    expect(d.error).toMatch(/bridge approval rejected/);
  });

  it('expired approval is refused', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('write', { ttlMs: -1000 }), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/expired/);
  });

  it('approval is action-bound: minted for another tool is refused', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('destructive'), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/signature mismatch/);
  });

  it('nonce is single-use: the second authorization with the same approval is refused', () => {
    const approval = mint('write');
    expect(authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval, approvalSecret: SECRET }).allow).toBe(true);
    const replay = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval, approvalSecret: SECRET });
    expect(replay.allow).toBe(false);
    expect(replay.error).toMatch(/already used/);
  });

  it('missing secret fails closed even with a well-formed approval', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('write'), approvalSecret: undefined });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/not configured/);
  });

  it('remote-bind write is refused even with a valid approval (R3 유지)', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, remoteBind: true, allowRemoteWrite: false, approval: mint('write'), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/remote/i);
  });

  it('a refusal does NOT burn the nonce — the same approval works on loopback afterwards', () => {
    const approval = mint('write');
    const refused = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, remoteBind: true, allowRemoteWrite: false, approval, approvalSecret: SECRET });
    expect(refused.allow).toBe(false);
    const allowed = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval, approvalSecret: SECRET });
    expect(allowed.allow).toBe(true);
  });

  it('missing annotations still refuse — approval cannot bypass fail-closed', () => {
    const d = authorizeToolCall({ name: 'noannot', toolListResult: toolList, enforceWhitelist: true, approval: mint('noannot'), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/annotations unavailable/);
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `pnpm exec vitest run tests/http-bridge-approval-guard.test.ts`
Expected: FAIL — T-BR-2 다수 (approval 파라미터가 아직 없어 무승인 판정으로 흘러감). T-BR-1 5개는 계속 PASS여야 한다.

- [ ] **Step 5: tool-guard.ts 전체 교체**

`apps/http-bridge/src/tool-guard.ts`를 아래 전문으로 교체:

```ts
import { verifyExecutionApproval, type SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import { consumeApprovalNonce } from '../../../packages/sangfor-operator/src/nonce-store.js';

type ToolListResult = {
  tools?: Array<{
    name?: unknown;
    annotations?: {
      readOnlyHint?: unknown;
      destructiveHint?: unknown;
    };
  }>;
};

export function findToolAnnotations(toolListResult: unknown, name: string) {
  const tools = (toolListResult as ToolListResult)?.tools;
  if (!Array.isArray(tools)) return null;
  const tool = tools.find((entry) => entry.name === name);
  const annotations = tool?.annotations;
  if (
    typeof annotations?.readOnlyHint !== 'boolean' ||
    typeof annotations.destructiveHint !== 'boolean'
  ) {
    return null;
  }
  return annotations;
}

export function isToolAllowedByAnnotations(toolListResult: unknown, name: string): boolean {
  const annotations = findToolAnnotations(toolListResult, name);
  return annotations?.readOnlyHint === true && annotations.destructiveHint === false;
}

export interface ToolAuthDecision {
  allow: boolean;
  status?: number;
  error?: string;
}

export const BRIDGE_APPROVAL_ACTION_TYPE = 'bridge.tool-call';

/**
 * Single source of truth for whether an incoming /tools/call is authorized.
 * Invariants (regression-pinned):
 *  - unknown/missing annotations  → refuse (fail-closed), approval cannot bypass this
 *  - destructiveHint              → refuse ALWAYS, even with the whitelist off
 *  - write tool on a remote bind  → refuse unless allowRemoteWrite is explicit (redteam R3),
 *                                   even with a valid approval
 *  - non-read-only ("write") tool → refuse unless the whitelist is explicitly disabled
 *  - read-only tool               → allow
 * Signed-approval path (control tower):
 *  - a SignedApproval bound to {type:'bridge.tool-call', target:<tool name>} that verifies
 *    against the server-side secret permits write AND destructive tools for this one call.
 *  - the nonce is consumed LAST, immediately before allow — a refused call must not burn
 *    a single-use approval.
 */
export function authorizeToolCall(params: {
  name: string;
  toolListResult: unknown;
  enforceWhitelist: boolean;
  remoteBind?: boolean;        // bridge is bound beyond loopback
  allowRemoteWrite?: boolean;  // SANGFOR_ALLOW_REMOTE_WRITE === 'true'
  approval?: SignedApproval;   // signed, action-bound, single-use (control tower)
  approvalSecret?: string;     // SANGFOR_OPERATOR_APPROVAL_SECRET
}): ToolAuthDecision {
  const {
    name, toolListResult, enforceWhitelist,
    remoteBind = false, allowRemoteWrite = false,
    approval, approvalSecret,
  } = params;
  const annotations = findToolAnnotations(toolListResult, name);
  if (!annotations) {
    return { allow: false, status: 403, error: `Tool annotations unavailable; refusing call: ${name}` };
  }
  const isWrite = annotations.readOnlyHint !== true;
  if (approval) {
    const verdict = verifyExecutionApproval({
      action: { type: BRIDGE_APPROVAL_ACTION_TYPE, target: name },
      approval,
      secret: approvalSecret,
    });
    if (!verdict.ok) {
      return { allow: false, status: 403, error: `bridge approval rejected: ${verdict.reason}` };
    }
    if (isWrite && remoteBind && !allowRemoteWrite) {
      return { allow: false, status: 403, error: `Write tool refused on a remote (non-loopback) bind: ${name}. Set SANGFOR_ALLOW_REMOTE_WRITE=true only for an authorized deployment.` };
    }
    const consumed = consumeApprovalNonce({ nonce: approval.nonce, expiresAt: approval.expiresAt });
    if (!consumed.ok) {
      return { allow: false, status: 403, error: `bridge approval rejected: ${consumed.reason}` };
    }
    return { allow: true };
  }
  if (annotations.destructiveHint) {
    return { allow: false, status: 403, error: `Destructive tool refused by MCP annotations: ${name}` };
  }
  if (isWrite && remoteBind && !allowRemoteWrite) {
    return { allow: false, status: 403, error: `Write tool refused on a remote (non-loopback) bind: ${name}. Set SANGFOR_ALLOW_REMOTE_WRITE=true only for an authorized deployment.` };
  }
  if (enforceWhitelist && !isToolAllowedByAnnotations(toolListResult, name)) {
    return { allow: false, status: 403, error: `Tool is not annotated read-only: ${name}` };
  }
  return { allow: true };
}
```

- [ ] **Step 6: server.ts에 approval 전달 배선**

`apps/http-bridge/src/server.ts` — import 블록(17행 부근)의 `import { authorizeToolCall } from "./tool-guard.js";` 아래에 추가:

```ts
import type { SignedApproval } from "../../../packages/sangfor-operator/src/approval.js";
```

같은 파일 POST /tools/call 블록에서 아래 두 곳을 수정. `const args = body.arguments ?? body.args ?? {};` 줄 다음에 추가:

```ts
      const approval = body.approval && typeof body.approval === "object"
        ? (body.approval as SignedApproval)
        : undefined;
```

`authorizeToolCall({...})` 호출을 다음으로 교체:

```ts
      const decision = authorizeToolCall({
        name,
        toolListResult: list.error ? null : list.result,
        enforceWhitelist,
        remoteBind: REMOTE_BIND,
        allowRemoteWrite: ALLOW_REMOTE_WRITE,
        approval,
        approvalSecret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
      });
```

그 외(인증, MCP 호출, 응답 형식)는 한 글자도 바꾸지 않는다.

- [ ] **Step 7: 전체 통과 확인 (신규 + 기존 bridge 테스트)**

Run: `pnpm exec vitest run tests/http-bridge-approval-guard.test.ts tests/http-bridge-authorize.test.ts tests/http-bridge-guard.test.ts`
Expected: PASS 전부 (기존 http-bridge-authorize/guard 테스트 무회귀 포함)

Run: `npm run lint`
Expected: 에러 0

- [ ] **Step 8: Commit**

```bash
git add apps/http-bridge/src/tool-guard.ts apps/http-bridge/src/server.ts tests/http-bridge-approval-guard.test.ts
git commit -m "feat(bridge): signed-approval pass-through for write/destructive tools (T-BR-2)

Approval is action-bound (bridge.tool-call + tool name), single-use (shared
FileNonceStore), and consumed last so refusals never burn a nonce. Default
no-approval behavior is byte-identical (pinned by T-BR-1).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 4: 벤더/장비 레지스트리 + 타워 스캐폴드 (T-REG-1 · 2 · 3)

**Files:**
- Create: `apps/control-tower/package.json`
- Create: `apps/control-tower/src/registry.ts`
- Modify: `.gitignore` (2줄 추가)
- Test: `tests/control-tower-registry.test.ts`
- 참고: `data/registry/vendors.json`은 Registry가 첫 로드 시 시드로 자동생성한다. Task 12에서 생성본을 커밋한다.

**Interfaces:**
- Consumes: `nowId`/`resolveRepoData` (deep import `../../../packages/shared/src/index.js`)
- Produces (Task 7·8·11이 의존):
  - `interface VendorDescriptor { product: string; label: string; advisorTools: string[]; credentialFields: string[]; defaultArgs?: Record<string, unknown> }`
  - `interface Device { id: string; name: string; product: string; host: string; tags: string[]; credentialEnv?: Record<string, string>; createdAt: string; updatedAt: string }`
  - `class RegistryValidationError extends Error` (api 계층이 400으로 매핑)
  - `const SEED_VENDORS: VendorDescriptor[]` (T-INT-2가 import)
  - `class Registry { constructor(dir?); vendors(); vendorFor(product); devices(); createDevice(input); updateDevice(id, patch); deleteDevice(id); }`
  - `function mergeDeviceArgs(vendor, device, userArgs?): Record<string, unknown>`
  - `function applyMockCredentialFallback(args, vendor, inputSchema): Record<string, unknown>`

**설계 결정 (스펙 §5.4 구체화):** 인자 병합은 순수 함수 `mergeDeviceArgs`로 분리한다 — 우선순위 `defaultArgs < host < credentialEnv 해석값 < 사용자입력`. mock 폴백(`'mock'` 문자열)은 **도구 inputSchema가 required로 요구하는 credentialField가 병합 후에도 없을 때만** 채운다(스펙 문구 "도구 스키마상 required면"). 스키마를 아는 것은 api 계층이므로 별도 함수 `applyMockCredentialFallback`로 두고 registry는 스키마 무지를 유지한다. 이 규칙 덕에 HCI(`identityBaseUrl` optional)는 mock 폴백으로 오염되지 않고 도구 기본값(`http://127.0.0.1:3400/...`)을 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/control-tower-registry.test.ts` 신규 생성:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Registry, RegistryValidationError, SEED_VENDORS,
  mergeDeviceArgs, applyMockCredentialFallback,
  type Device, type VendorDescriptor,
} from '../apps/control-tower/src/registry.js';

describe('Registry — 로드/시드/CRUD (T-REG-1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'registry-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('vendors.json 없으면 시드 3종을 생성하고 반환한다', () => {
    const reg = new Registry(dir);
    const vendors = reg.vendors();
    expect(vendors.map((v) => v.product)).toEqual(['FORTIOS', 'CISCO_IOSXE', 'HCI_SCP']);
    expect(existsSync(join(dir, 'vendors.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'vendors.json'), 'utf8'))).toEqual(SEED_VENDORS);
  });

  it('HCI 시드 credentialFields는 실제 스키마 속성명 identityBaseUrl을 쓴다 (스펙 교정 1)', () => {
    const hci = SEED_VENDORS.find((v) => v.product === 'HCI_SCP')!;
    expect(hci.credentialFields).toEqual(['identityBaseUrl', 'username', 'password']);
  });

  it('devices CRUD: 생성/수정/삭제 + atomic 파일 반영 + 재로드', () => {
    const reg = new Registry(dir);
    const dev = reg.createDevice({ name: '본사 FW', product: 'FORTIOS', host: '10.0.0.1', tags: ['lab'] });
    expect(dev.id).toMatch(/^dev_/);
    expect(new Registry(dir).devices()).toHaveLength(1);
    const updated = reg.updateDevice(dev.id, { name: '본사 FW 1호기' });
    expect(updated.name).toBe('본사 FW 1호기');
    expect(updated.updatedAt >= dev.updatedAt).toBe(true);
    reg.deleteDevice(dev.id);
    expect(reg.devices()).toHaveLength(0);
    expect(existsSync(join(dir, 'devices.json.tmp'))).toBe(false); // atomic write 잔여물 없음
  });

  it('vendors.json에 없는 product 등록/수정은 RegistryValidationError', () => {
    const reg = new Registry(dir);
    expect(() => reg.createDevice({ name: 'x', product: 'NOPE', host: 'h' })).toThrow(RegistryValidationError);
    const dev = reg.createDevice({ name: 'x', product: 'FORTIOS', host: 'h' });
    expect(() => reg.updateDevice(dev.id, { product: 'NOPE' })).toThrow(/unknown product/);
    expect(() => reg.updateDevice(dev.id, { product: '' })).toThrow(/unknown product/);
    expect(() => reg.updateDevice('dev_none', { name: 'y' })).toThrow(/unknown device/);
    expect(() => reg.deleteDevice('dev_none')).toThrow(/unknown device/);
    expect(() => reg.createDevice({ name: '', product: 'FORTIOS', host: 'h' })).toThrow(/name is required/);
    expect(() => reg.createDevice({ name: 'x', product: 'FORTIOS', host: ' ' })).toThrow(/host is required/);
  });
});

describe('mergeDeviceArgs — 병합 우선순위 (T-REG-2)', () => {
  const vendor: VendorDescriptor = {
    product: 'FORTIOS', label: 'f', advisorTools: [],
    credentialFields: ['host', 'username', 'password'],
    defaultArgs: { specVersion: '8.0.0', host: 'default-host' },
  };
  const device: Device = {
    id: 'dev_1', name: 'n', product: 'FORTIOS', host: '10.0.0.9', tags: [],
    credentialEnv: { username: 'T_REG2_USER', password: 'T_REG2_PASS' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };

  afterEach(() => { delete process.env.T_REG2_USER; delete process.env.T_REG2_PASS; });

  it('defaultArgs < device.host < credentialEnv < 사용자입력', () => {
    process.env.T_REG2_USER = 'env-admin';
    process.env.T_REG2_PASS = 'env-pass';
    const merged = mergeDeviceArgs(vendor, device, { password: 'user-wins' });
    expect(merged).toEqual({
      specVersion: '8.0.0',
      host: '10.0.0.9',        // device.host가 defaultArgs.host를 덮음
      username: 'env-admin',   // env 해석값
      password: 'user-wins',   // 사용자 입력 최우선
    });
  });

  it('credentialEnv의 env 변수가 없으면 해당 키는 생략된다', () => {
    const merged = mergeDeviceArgs(vendor, device, {});
    expect(merged.username).toBeUndefined();
    expect(merged.password).toBeUndefined();
  });

  it('applyMockCredentialFallback: 스키마 required인 credentialField만 mock으로 채운다', () => {
    const merged = mergeDeviceArgs(vendor, device, {});
    const filled = applyMockCredentialFallback(merged, vendor, { required: ['host', 'username', 'password'] });
    expect(filled.username).toBe('mock');
    expect(filled.password).toBe('mock');
    // required 아니면 채우지 않는다 (HCI identityBaseUrl 케이스)
    const hciVendor: VendorDescriptor = { product: 'HCI_SCP', label: 'h', advisorTools: [], credentialFields: ['identityBaseUrl', 'username', 'password'] };
    const untouched = applyMockCredentialFallback({}, hciVendor, { required: [] });
    expect(untouched).toEqual({});
    // 이미 값이 있으면 덮지 않는다
    const kept = applyMockCredentialFallback({ username: 'real' }, vendor, { required: ['username'] });
    expect(kept.username).toBe('real');
  });
});

describe('개방성 — 가상 벤더 주입 (T-REG-3)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'registry-acme-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('ACME_FW 디스크립터를 파일로 주입하면 코드 수정 없이 등록·인자구성이 동작한다', () => {
    const acme: VendorDescriptor = {
      product: 'ACME_FW', label: 'Acme Firewall',
      advisorTools: ['sangfor.advisor_acme'],
      credentialFields: ['host', 'apiKey'],
      defaultArgs: { profile: 'strict' },
    };
    writeFileSync(join(dir, 'vendors.json'), JSON.stringify([acme], null, 2));
    const reg = new Registry(dir);
    const dev = reg.createDevice({ name: 'acme1', product: 'ACME_FW', host: 'http://127.0.0.1:9999', tags: [] });
    const args = applyMockCredentialFallback(
      mergeDeviceArgs(reg.vendorFor(dev.product)!, dev, {}),
      reg.vendorFor(dev.product)!,
      { required: ['host', 'apiKey'] },
    );
    expect(args).toEqual({ profile: 'strict', host: 'http://127.0.0.1:9999', apiKey: 'mock' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-registry.test.ts`
Expected: FAIL — `Cannot find module '../apps/control-tower/src/registry.js'`

- [ ] **Step 3: 스캐폴드 + registry.ts 구현**

`apps/control-tower/package.json`:

```json
{
  "name": "control-tower",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/server.ts"
}
```

`apps/control-tower/src/registry.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowId, resolveRepoData } from '../../../packages/shared/src/index.js';

export interface VendorDescriptor {
  product: string;             // 열린 값 (enum 아님)
  label: string;
  advisorTools: string[];      // 이 벤더 장비에 실행할 읽기전용 자문 도구 전체이름
  credentialFields: string[];  // 자문 도구가 요구하는 장비 인자 이름들
  defaultArgs?: Record<string, unknown>;
}

export interface Device {
  id: string;
  name: string;
  product: string;             // vendors.json의 product 참조 (등록 시 검증)
  host: string;
  tags: string[];
  credentialEnv?: Record<string, string>; // 값은 env 변수 "이름" — 비밀값 파일 저장 금지
  createdAt: string;
  updatedAt: string;
}

export class RegistryValidationError extends Error {}

// NOTE: 스펙 §5.4 시드의 HCI credentialFields 'identityUrl'은 실제 스키마 속성명
// 'identityBaseUrl'로 교정했다 (tests/control-tower-e2e.test.ts T-INT-2가 대조 고정).
export const SEED_VENDORS: VendorDescriptor[] = [
  {
    product: 'FORTIOS', label: 'Fortinet FortiOS',
    advisorTools: ['sangfor.advisor_fortios', 'sangfor.advisor_fortios_advanced'],
    credentialFields: ['host', 'username', 'password'],
    defaultArgs: { specVersion: '8.0.0' },
  },
  {
    product: 'CISCO_IOSXE', label: 'Cisco IOS-XE',
    advisorTools: ['sangfor.advisor_cisco_iosxe', 'sangfor.advisor_cisco_iosxe_advanced'],
    credentialFields: ['host', 'username', 'password'],
    defaultArgs: { specVersion: '17.0.0' },
  },
  {
    product: 'HCI_SCP', label: 'Sangfor HCI/SCP',
    advisorTools: ['sangfor.hci_health_report'],
    credentialFields: ['identityBaseUrl', 'username', 'password'],
    defaultArgs: {},
  },
];

export class Registry {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
  }

  vendors(): VendorDescriptor[] {
    return this.loadOrSeed<VendorDescriptor[]>(join(this.dir, 'vendors.json'), SEED_VENDORS);
  }

  vendorFor(product: string): VendorDescriptor | undefined {
    return this.vendors().find((v) => v.product === product);
  }

  devices(): Device[] {
    return this.loadOrSeed<Device[]>(join(this.dir, 'devices.json'), []);
  }

  createDevice(input: {
    name: string; product: string; host: string;
    tags?: string[]; credentialEnv?: Record<string, string>;
  }): Device {
    if (!input.name?.trim()) throw new RegistryValidationError('name is required');
    if (!input.host?.trim()) throw new RegistryValidationError('host is required');
    if (!this.vendorFor(input.product)) {
      throw new RegistryValidationError(`unknown product (vendors.json에 없음): ${input.product}`);
    }
    const now = new Date().toISOString();
    const device: Device = {
      id: nowId('dev'),
      name: input.name.trim(),
      product: input.product,
      host: input.host.trim(),
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.credentialEnv) device.credentialEnv = input.credentialEnv;
    this.writeDevices([...this.devices(), device]);
    return device;
  }

  updateDevice(id: string, patch: Partial<Omit<Device, 'id' | 'createdAt' | 'updatedAt'>>): Device {
    const devices = this.devices();
    const index = devices.findIndex((d) => d.id === id);
    if (index === -1) throw new RegistryValidationError(`unknown device: ${id}`);
    if (patch.product !== undefined && !this.vendorFor(patch.product)) {
      throw new RegistryValidationError(`unknown product (vendors.json에 없음): ${patch.product}`);
    }
    const updated: Device = {
      ...devices[index],
      ...patch,
      id,
      createdAt: devices[index].createdAt,
      updatedAt: new Date().toISOString(),
    };
    devices[index] = updated;
    this.writeDevices(devices);
    return updated;
  }

  deleteDevice(id: string): void {
    const devices = this.devices();
    if (!devices.some((d) => d.id === id)) throw new RegistryValidationError(`unknown device: ${id}`);
    this.writeDevices(devices.filter((d) => d.id !== id));
  }

  private loadOrSeed<T>(path: string, seed: T): T {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.atomicWrite(path, seed);
        return structuredClone(seed);
      }
      throw error; // corrupt registry must fail loud, not silently reset
    }
  }

  private writeDevices(devices: Device[]): void {
    this.atomicWrite(join(this.dir, 'devices.json'), devices);
  }

  private atomicWrite(path: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  }
}

// 인자 병합 우선순위: defaultArgs < device.host < credentialEnv 해석값 < 사용자입력.
export function mergeDeviceArgs(
  vendor: VendorDescriptor,
  device: Device,
  userArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  const fromEnv: Record<string, unknown> = {};
  for (const [field, envName] of Object.entries(device.credentialEnv ?? {})) {
    const value = process.env[envName];
    if (value !== undefined) fromEnv[field] = value;
  }
  return { ...(vendor.defaultArgs ?? {}), host: device.host, ...fromEnv, ...userArgs };
}

// mock 장비 폴백: 도구 inputSchema가 required로 요구하는 credentialField가 병합 후에도
// 없으면 'mock'을 채운다 (mock 콘솔은 인증을 보지 않는다). required가 아니면 채우지
// 않는다 — HCI identityBaseUrl은 도구 기본값(로컬 mock)을 그대로 쓰게 한다.
export function applyMockCredentialFallback(
  args: Record<string, unknown>,
  vendor: VendorDescriptor,
  inputSchema: { required?: string[] } | undefined,
): Record<string, unknown> {
  const required = new Set(inputSchema?.required ?? []);
  const out = { ...args };
  for (const field of vendor.credentialFields) {
    if (out[field] === undefined && required.has(field)) out[field] = 'mock';
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-registry.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: .gitignore에 런타임 데이터 경로 추가**

`.gitignore` 끝(`data/evidence/change-runs/` 블록 뒤)에 추가:

```
# Control Tower runtime data (vendors.json 시드는 커밋 대상 — devices/이력만 로컬)
data/runs/
data/registry/devices.json
```

- [ ] **Step 6: Commit**

```bash
git add apps/control-tower tests/control-tower-registry.test.ts .gitignore
git commit -m "feat(control-tower): vendor/device registry with open descriptors (T-REG)

Merge order defaultArgs < device.host < credentialEnv < user input; 'mock'
fallback only for schema-required credential fields. HCI seed corrected to
identityBaseUrl (matches the actual tool schema).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 5: BridgeClient — http-bridge REST 클라이언트

**Files:**
- Create: `apps/control-tower/src/bridge-client.ts`
- Test: `tests/control-tower-bridge-client.test.ts`

**Interfaces:**
- Consumes: `SignedApproval` (deep import), `RunSafety` (`@sangfor/runs`)
- Produces (Task 7·8이 의존):
  - `interface BridgeTool { name: string; description: string; inputSchema: BridgeToolSchema; annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean }; category: string }`
  - `interface BridgeToolSchema { type?: string; properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] }`
  - `interface CallResult { ok: boolean; data?: unknown; errorText?: string }`
  - `class BridgeClient { constructor(baseUrl?, token?); health(); listTools(); callTool(name, args, approval?, timeoutMs?); }`
  - `function safetyOf(t: BridgeTool): RunSafety`

**파싱 계약 (스펙 §4.1):** `POST /tools/call` 성공 응답은 `{ result: { content: [{type:'text', text}], structuredContent, isError } }`. `structuredContent` 우선, 없으면 `content[0].text`를 JSON.parse (실패 시 raw text). `isError:true` → `{ok:false, errorText: content[0].text}`. 거부/오류(403/400/502)는 `{ error }` body — `{ok:false, errorText}`로 값 변환(throw 금지, 이력에 남겨야 함).

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/control-tower-bridge-client.test.ts` 신규 생성:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeClient, safetyOf, type BridgeTool } from '../apps/control-tower/src/bridge-client.js';

// 프로그래머블 stub bridge: 케이스별 응답을 큐로 제어한다.
let stub: http.Server;
let base: string;
let toolsResponse: unknown;
let callResponse: { status: number; body: unknown };
let lastCall: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> } | null = null;
let toolsHits = 0;

beforeAll(async () => {
  stub = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') { toolsHits += 1; return respond(200, toolsResponse); }
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      lastCall = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      return respond(callResponse.status, callResponse.body);
    }
    respond(404, { error: 'not found' });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => stub.close(() => r())));

const tool = (name: string, ro: boolean, destructive = false): BridgeTool => ({
  name, description: 'd', inputSchema: { type: 'object', properties: {} },
  annotations: { title: name, readOnlyHint: ro, destructiveHint: destructive }, category: 'admin',
});

describe('BridgeClient', () => {
  it('listTools는 Bearer 토큰을 붙이고 60초 캐시한다', async () => {
    const client = new BridgeClient(base, 'tok-1');
    toolsResponse = { tools: [tool('a.read', true)] };
    toolsHits = 0;
    const first = await client.listTools();
    expect(first.map((t) => t.name)).toEqual(['a.read']);
    toolsResponse = { tools: [] }; // 서버 응답을 바꿔도
    const second = await client.listTools();
    expect(second.map((t) => t.name)).toEqual(['a.read']); // 캐시 히트
    expect(toolsHits).toBe(1);
  });

  it('callTool: structuredContent 우선 파싱 + approval/arguments 전달 + Bearer 헤더', async () => {
    const client = new BridgeClient(base, 'tok-2');
    const payload = { evaluation: { ok: true } };
    callResponse = { status: 200, body: { result: { content: [{ type: 'text', text: 'ignored' }], structuredContent: payload, isError: false } } };
    const approval = { approvedBy: 'a', approvalToken: 't', changeTicketId: 'c', rollbackPlanId: 'r', nonce: 'n', expiresAt: 'e' };
    const result = await client.callTool('x.tool', { q: 1 }, approval);
    expect(result).toEqual({ ok: true, data: payload });
    expect(lastCall!.headers.authorization).toBe('Bearer tok-2');
    expect(lastCall!.body).toEqual({ name: 'x.tool', arguments: { q: 1 }, approval });
  });

  it('callTool: structuredContent 없으면 content[0].text JSON.parse, 비JSON이면 raw text', async () => {
    const client = new BridgeClient(base);
    callResponse = { status: 200, body: { result: { content: [{ type: 'text', text: '{"a":1}' }], isError: false } } };
    expect(await client.callTool('x', {})).toEqual({ ok: true, data: { a: 1 } });
    callResponse = { status: 200, body: { result: { content: [{ type: 'text', text: 'plain' }], isError: false } } };
    expect(await client.callTool('x', {})).toEqual({ ok: true, data: 'plain' });
  });

  it('callTool: isError → ok:false + errorText', async () => {
    const client = new BridgeClient(base);
    callResponse = { status: 200, body: { result: { content: [{ type: 'text', text: 'tool blew up' }], isError: true } } };
    expect(await client.callTool('x', {})).toEqual({ ok: false, errorText: 'tool blew up' });
  });

  it('callTool: bridge 거부(403 {error})는 값으로 반환한다', async () => {
    const client = new BridgeClient(base);
    callResponse = { status: 403, body: { error: 'Destructive tool refused' } };
    expect(await client.callTool('x', {})).toEqual({ ok: false, errorText: 'Destructive tool refused' });
  });

  it('bridge 다운: health는 unreachable 값, callTool은 ok:false 값 (throw 금지)', async () => {
    const dead = new BridgeClient('http://127.0.0.1:1'); // 연결 불가 포트
    expect((await dead.health()).status).toBe('unreachable');
    const call = await dead.callTool('x', {});
    expect(call.ok).toBe(false);
    expect(call.errorText).toMatch(/bridge unreachable/);
  });

  it('safetyOf: destructive > write > read_only', () => {
    expect(safetyOf(tool('a', false, true))).toBe('destructive');
    expect(safetyOf(tool('a', false))).toBe('write');
    expect(safetyOf(tool('a', true))).toBe('read_only');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-bridge-client.test.ts`
Expected: FAIL — 모듈 미존재

- [ ] **Step 3: bridge-client.ts 구현**

`apps/control-tower/src/bridge-client.ts`:

```ts
import type { SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import type { RunSafety } from '../../../packages/sangfor-runs/src/index.js';

export interface BridgeToolSchema {
  type?: string;
  properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[] }>;
  required?: string[];
}

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: BridgeToolSchema;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean };
  category: string;
}

export interface CallResult {
  ok: boolean;
  data?: unknown;
  errorText?: string;
}

interface McpResultEnvelope {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const TOOLS_CACHE_MS = 60_000;

export class BridgeClient {
  private toolsCache: { at: number; tools: BridgeTool[] } | null = null;

  constructor(
    private readonly baseUrl: string = process.env.CONTROL_TOWER_BRIDGE_URL ?? 'http://127.0.0.1:3600',
    private readonly token: string | undefined = process.env.SANGFOR_API_TOKEN,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  // 실패도 값으로 — overview/health 위젯은 브리지가 죽어도 렌더돼야 한다.
  async health(): Promise<{ status: string; mcp: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      const body = (await res.json()) as { status?: string; mcp?: string };
      return { status: String(body.status ?? 'unknown'), mcp: String(body.mcp ?? 'unknown') };
    } catch {
      return { status: 'unreachable', mcp: 'unknown' };
    }
  }

  async listTools(): Promise<BridgeTool[]> {
    const now = Date.now();
    if (this.toolsCache && now - this.toolsCache.at < TOOLS_CACHE_MS) return this.toolsCache.tools;
    const res = await fetch(`${this.baseUrl}/tools`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`bridge /tools HTTP ${res.status}`);
    const body = (await res.json()) as { tools?: BridgeTool[] };
    const tools = Array.isArray(body.tools) ? body.tools : [];
    this.toolsCache = { at: now, tools };
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    approval?: SignedApproval,
    timeoutMs = 35_000, // bridge의 MCP 요청 30초 타임아웃보다 여유 있게
  ): Promise<CallResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/tools/call`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name, arguments: args, ...(approval ? { approval } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, errorText: `bridge unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const body = (await res.json().catch(() => null)) as { result?: McpResultEnvelope; error?: string } | null;
    if (!res.ok) return { ok: false, errorText: String(body?.error ?? `bridge HTTP ${res.status}`) };
    const result = body?.result;
    if (!result) return { ok: false, errorText: 'bridge response missing result' };
    const text = result.content?.[0]?.text;
    if (result.isError) return { ok: false, errorText: text ?? 'tool returned isError' };
    if (result.structuredContent !== undefined) return { ok: true, data: result.structuredContent };
    if (typeof text === 'string') {
      try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; }
    }
    return { ok: true, data: null };
  }
}

export function safetyOf(t: BridgeTool): RunSafety {
  if (t.annotations.destructiveHint) return 'destructive';
  if (t.annotations.readOnlyHint !== true) return 'write';
  return 'read_only';
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-bridge-client.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/control-tower/src/bridge-client.ts tests/control-tower-bridge-client.test.ts
git commit -m "feat(control-tower): http-bridge client with failure-as-value semantics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 승인 민팅 헬퍼 (approval-mint.ts)

**Files:**
- Create: `apps/control-tower/src/approval-mint.ts`
- Test: `tests/control-tower-approval-mint.test.ts`

**Interfaces:**
- Consumes: `signApprovalToken`/`SignedApproval` (deep import)
- Produces (Task 7·8·11이 의존):
  - `const BRIDGE_APPROVAL_ACTION_TYPE = 'bridge.tool-call'` (tool-guard와 같은 값 — 의도적 문자열 복제, T-INT-1이 실guard로 호환 고정)
  - `interface MintInput { secret: string; actionType: string; actionTarget?: string; approvedBy: string; changeTicketId: string; rollbackPlanId: string; ttlSec?: number; now?: Date }`
  - `function mintApproval(input: MintInput): SignedApproval`
  - `function mintBridgeApproval(toolId: string, input: Omit<MintInput, 'actionType' | 'actionTarget'>): SignedApproval`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/control-tower-approval-mint.test.ts` 신규 생성:

```ts
import { describe, expect, it } from 'vitest';
import { mintApproval, mintBridgeApproval, BRIDGE_APPROVAL_ACTION_TYPE } from '../apps/control-tower/src/approval-mint.js';
import { verifyExecutionApproval } from '../packages/sangfor-operator/src/approval.js';

const SECRET = 'mint-test-secret';

describe('approval-mint', () => {
  it('mintBridgeApproval 결과가 verifyExecutionApproval을 통과한다 (round-trip)', () => {
    const signed = mintBridgeApproval('sangfor.pm_create_engagement', {
      secret: SECRET, approvedBy: 'jmpark', changeTicketId: 'CHG-9', rollbackPlanId: 'RB-9',
    });
    expect(signed.nonce).toMatch(/^[0-9a-f]{24}$/); // randomBytes(12).hex
    const verdict = verifyExecutionApproval({
      action: { type: BRIDGE_APPROVAL_ACTION_TYPE, target: 'sangfor.pm_create_engagement' },
      approval: signed, secret: SECRET,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('다른 도구명(target)으로는 검증 실패 — action-bound', () => {
    const signed = mintBridgeApproval('tool.a', { secret: SECRET, approvedBy: 'a', changeTicketId: 'c', rollbackPlanId: 'r' });
    const verdict = verifyExecutionApproval({
      action: { type: BRIDGE_APPROVAL_ACTION_TYPE, target: 'tool.b' },
      approval: signed, secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
  });

  it('기본 TTL 120초, now 주입 시 만료 판정 재현 가능', () => {
    const now = new Date('2026-07-03T00:00:00.000Z');
    const signed = mintApproval({
      secret: SECRET, actionType: 'hci.create-volume', actionTarget: 'h:vol',
      approvedBy: 'a', changeTicketId: 'c', rollbackPlanId: 'r', now,
    });
    expect(signed.expiresAt).toBe('2026-07-03T00:02:00.000Z');
    const late = verifyExecutionApproval({
      action: { type: 'hci.create-volume', target: 'h:vol' },
      approval: signed, secret: SECRET, now: new Date('2026-07-03T00:02:01.000Z'),
    });
    expect(late.ok).toBe(false);
    expect(late.reason).toMatch(/expired/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-approval-mint.test.ts`
Expected: FAIL — 모듈 미존재

- [ ] **Step 3: approval-mint.ts 구현**

`apps/control-tower/src/approval-mint.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { signApprovalToken, type SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';

// apps/http-bridge/src/tool-guard.ts의 BRIDGE_APPROVAL_ACTION_TYPE과 같은 값.
// 앱 간 직접 import를 피하려고 문자열을 복제한다 — 호환성은 T-INT-1이 실제 guard로 고정.
export const BRIDGE_APPROVAL_ACTION_TYPE = 'bridge.tool-call';

export interface MintInput {
  secret: string;
  actionType: string;
  actionTarget?: string;
  approvedBy: string;
  changeTicketId: string;
  rollbackPlanId: string;
  ttlSec?: number;
  now?: Date;
}

export function mintApproval(input: MintInput): SignedApproval {
  const now = input.now ?? new Date();
  const base = {
    approvedBy: input.approvedBy,
    changeTicketId: input.changeTicketId,
    rollbackPlanId: input.rollbackPlanId,
    nonce: randomBytes(12).toString('hex'),
    expiresAt: new Date(now.getTime() + (input.ttlSec ?? 120) * 1000).toISOString(),
  };
  return {
    ...base,
    approvalToken: signApprovalToken(input.secret, { type: input.actionType, target: input.actionTarget }, base),
  };
}

export function mintBridgeApproval(
  toolId: string,
  input: Omit<MintInput, 'actionType' | 'actionTarget'>,
): SignedApproval {
  return mintApproval({ ...input, actionType: BRIDGE_APPROVAL_ACTION_TYPE, actionTarget: toolId });
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-approval-mint.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/control-tower/src/approval-mint.ts tests/control-tower-approval-mint.test.ts
git commit -m "feat(control-tower): signed-approval minting helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 7: Tower API 코어 — 실행 라이프사이클 (T-API-1)

**Files:**
- Create: `apps/control-tower/src/api.ts`
- Create: `apps/control-tower/src/server.ts` (API 라우팅만 — `GET /` UI 라우트·listen 블록은 Task 9)
- Test: `tests/control-tower-api.test.ts`

**Interfaces:**
- Consumes: Task 2 `RunStore`, Task 4 `Registry`/`mergeDeviceArgs`/`applyMockCredentialFallback`, Task 5 `BridgeClient`/`safetyOf`, Task 6 `mintBridgeApproval`
- Produces (Task 8·9·11이 의존):
  - `class ApiError extends Error { constructor(public readonly status: number, message: string) }`
  - `interface TowerOptions { bridgeUrl?; token?; runsDir?; registryDir?; approvalSecret?; mockConsoleUrl? }` (전부 optional string)
  - `function summarize(result: unknown): string`
  - `function createApi(opts?: TowerOptions)` → `{ createRun, listRuns, getRun, approveRun, rejectRun }` (Task 8에서 확장)
  - `function createTowerServer(opts?: TowerServerOptions): http.Server` — `TowerServerOptions = TowerOptions & { apiToken?: string }`

**핵심 규칙 (스펙 §6.1·6.2·8):** read_only → `running` 생성 후 즉시 실행. write/destructive → `pending_approval` 생성만. 승인 시 저장된 **원본(무마스킹) args**를 메모리 맵에서 꺼내 실행 — 맵에 없으면(타워 재시작) 400. bridge 403/isError/다운 → run `failed` (pending으로 되돌리지 않음). listRuns 응답은 `resultJson` 제외, 상세만 포함.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/control-tower-api.test.ts` 신규 생성:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import { Registry, type VendorDescriptor } from '../apps/control-tower/src/registry.js';
import type { RunRecord } from '@sangfor/runs';

// ─── stub bridge ────────────────────────────────────────────────────────────
const STUB_TOOLS = {
  tools: [
    {
      name: 'stub.read', description: 'echo read',
      inputSchema: {
        type: 'object',
        properties: { host: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, specVersion: { type: 'string', default: '1.0' } },
        required: ['host', 'username', 'password'],
      },
      annotations: { title: 'stub read', readOnlyHint: true, destructiveHint: false }, category: 'advisory',
    },
    {
      name: 'stub.write', description: 'echo write',
      inputSchema: { type: 'object', properties: { customer: { type: 'string' }, password: { type: 'string' } }, required: ['customer'] },
      annotations: { title: 'stub write', readOnlyHint: false, destructiveHint: false }, category: 'pm',
    },
    {
      name: 'stub.fail', description: 'always isError',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'stub fail', readOnlyHint: true, destructiveHint: false }, category: 'admin',
    },
  ],
};

let stubBridge: http.Server;
let bridgeUrl: string;
let lastCall: { name: string; arguments: Record<string, unknown>; approval?: Record<string, unknown> } | null;

function startStubBridge(): Promise<void> {
  stubBridge = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') return respond(200, STUB_TOOLS);
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      lastCall = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // 실제 bridge처럼 목록에 없는 도구는 403 — Task 8 health 테스트의 store/rag 프로브가 이 경로를 탄다
      if (!STUB_TOOLS.tools.some((t) => t.name === lastCall!.name)) {
        return respond(403, { error: 'Tool annotations unavailable; refusing call: ' + lastCall!.name });
      }
      if (lastCall!.name === 'stub.fail') {
        return respond(200, { result: { content: [{ type: 'text', text: 'stub tool exploded' }], isError: true } });
      }
      const payload = lastCall!.name === 'stub.read'
        ? { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 3, fail: 0, indeterminate: 0 }, coverage: {} } }
        : { created: true, echo: lastCall!.arguments };
      return respond(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
    }
    respond(404, { error: 'not found' });
  });
  return new Promise((r) => stubBridge.listen(0, '127.0.0.1', () => {
    bridgeUrl = `http://127.0.0.1:${(stubBridge.address() as AddressInfo).port}`;
    r();
  }));
}

// ─── tower 기동 헬퍼 ────────────────────────────────────────────────────────
let runsDir: string;
let registryDir: string;
let tower: http.Server;
let towerUrl: string;

function startTower(opts: Record<string, unknown> = {}): Promise<http.Server> {
  const server = createTowerServer({
    bridgeUrl, runsDir, registryDir,
    approvalSecret: 'api-secret', apiToken: 'test-token',
    mockConsoleUrl: 'http://127.0.0.1:1',
    ...opts,
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const urlOf = (server: http.Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, body?: unknown, base?: string, token = 'test-token') {
  const res = await fetch(`${base ?? towerUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'tower-runs-'));
  registryDir = mkdtempSync(join(tmpdir(), 'tower-reg-'));
  lastCall = null;
  await startStubBridge();
  tower = await startTower();
  towerUrl = urlOf(tower);
});

afterEach(async () => {
  await new Promise<void>((r) => tower.close(() => r()));
  await new Promise<void>((r) => stubBridge.close(() => r()));
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

describe('Tower API — 인증/검증 (T-API-1)', () => {
  it('토큰 없으면 /api/*는 401, 잘못된 토큰도 401', async () => {
    expect((await call('GET', '/api/runs', undefined, towerUrl, '')).status).toBe(401);
    expect((await call('GET', '/api/runs', undefined, towerUrl, 'wrong')).status).toBe(401);
  });

  it('존재하지 않는 toolId → 400', async () => {
    const r = await call('POST', '/api/runs', { toolId: 'nope.tool', args: {} });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/unknown tool/);
  });
});

describe('Tower API — 읽기전용 즉시 실행 (T-API-1)', () => {
  it('실행→succeeded 레코드 반환, 이력 목록은 resultJson 제외·상세는 포함', async () => {
    const r = await call('POST', '/api/runs', { toolId: 'stub.read', args: { host: 'h', username: 'u', password: 'p' } });
    expect(r.status).toBe(200);
    const run = r.body as unknown as RunRecord;
    expect(run.status).toBe('succeeded');
    expect(run.toolSafety).toBe('read_only');
    expect(run.resultSummary).toBe('ok=true pass=3 fail=0');
    expect(run.args.password).toBe('***'); // 저장소 마스킹 불변식이 응답에도 반영
    expect(lastCall!.arguments.password).toBe('p'); // 실행에는 원본이 나감

    const list = await call('GET', '/api/runs');
    const listed = (list.body.runs as RunRecord[]).find((x) => x.runId === run.runId)!;
    expect(listed).toBeDefined();
    expect('resultJson' in listed).toBe(false);

    const detail = await call('GET', `/api/runs/${run.runId}`);
    expect((detail.body as unknown as RunRecord).resultJson).toBeDefined();
    expect((await call('GET', '/api/runs/run_none')).status).toBe(404);
  });

  it('isError 도구 → failed + error 기록', async () => {
    const r = await call('POST', '/api/runs', { toolId: 'stub.fail', args: {} });
    const run = r.body as unknown as RunRecord;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('stub tool exploded');
  });

  it('deviceId 지정 시 §5.4 병합 규칙으로 인자 구성 (사용자입력 > mock 폴백)', async () => {
    writeFileSync(join(registryDir, 'vendors.json'), JSON.stringify([{
      product: 'STUB_FW', label: 'Stub FW',
      advisorTools: ['stub.read'], credentialFields: ['host', 'username', 'password'],
      defaultArgs: { specVersion: '1.0' },
    } satisfies VendorDescriptor]));
    const device = new Registry(registryDir).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
    const r = await call('POST', '/api/runs', { toolId: 'stub.read', deviceId: device.id, args: { specVersion: '9.9' } });
    expect((r.body as unknown as RunRecord).deviceId).toBe(device.id);
    expect(lastCall!.arguments).toEqual({
      specVersion: '9.9',              // 사용자입력이 defaultArgs를 덮음
      host: 'http://127.0.0.1:9',      // device.host
      username: 'mock', password: 'mock', // required credentialField 폴백
    });
    expect((await call('POST', '/api/runs', { toolId: 'stub.read', deviceId: 'dev_none' })).status).toBe(400);
  });
});

describe('Tower API — 승인 플로우 (T-API-1)', () => {
  it('write → pending_approval(실행 안 함) → approve → 민팅·실행·succeeded + approval 메타', async () => {
    const created = await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'acme', password: 'sec' } });
    const pending = created.body as unknown as RunRecord;
    expect(pending.status).toBe('pending_approval');
    expect(lastCall).toBeNull(); // 아직 bridge 호출 없음
    expect((await call('GET', '/api/runs?status=pending_approval')).body.runs).toHaveLength(1);

    const approved = await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'jmpark' });
    const final = approved.body as unknown as RunRecord;
    expect(final.status).toBe('succeeded');
    expect(final.approval).toMatchObject({ approvedBy: 'jmpark', changeTicketId: `run:${pending.runId}`, rollbackPlanId: 'n/a-read-back-verify' });
    expect(JSON.stringify(final)).not.toMatch(/approvalToken|nonce/); // 토큰·nonce 무저장
    expect(lastCall!.name).toBe('stub.write');
    expect(lastCall!.arguments.password).toBe('sec'); // 원본 args로 실행 (마스킹본 아님)
    expect(lastCall!.approval).toMatchObject({ approvedBy: 'jmpark' });
    expect(typeof lastCall!.approval!.approvalToken).toBe('string');

    // 이미 최종 상태 → 재승인 409
    expect((await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'x' })).status).toBe(409);
  });

  it('reject: 사유 필수, pending → rejected. 404/409 케이스', async () => {
    const created = await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'acme' } });
    const pending = created.body as unknown as RunRecord;
    expect((await call('POST', `/api/runs/${pending.runId}/reject`, {})).status).toBe(400);
    const rejected = await call('POST', `/api/runs/${pending.runId}/reject`, { reason: 'no ticket' });
    expect((rejected.body as unknown as RunRecord).status).toBe('rejected');
    expect((rejected.body as unknown as RunRecord).rejectedReason).toBe('no ticket');
    expect((await call('POST', `/api/runs/${pending.runId}/reject`, { reason: 'again' })).status).toBe(409);
    expect((await call('POST', '/api/runs/run_none/approve', { approvedBy: 'x' })).status).toBe(404);
    expect((await call('POST', '/api/runs/run_none/reject', { reason: 'x' })).status).toBe(404);
  });

  it('시크릿 미설정 → 500 fail-closed, 상태는 pending 유지', async () => {
    const bare = await startTower({ approvalSecret: '' });
    const bareUrl = urlOf(bare);
    try {
      const created = await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'a' } }, bareUrl);
      const pending = created.body as unknown as RunRecord;
      const r = await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'x' }, bareUrl);
      expect(r.status).toBe(500);
      expect(String(r.body.error)).toMatch(/approval secret not configured/);
      const detail = await call('GET', `/api/runs/${pending.runId}`, undefined, bareUrl);
      expect((detail.body as unknown as RunRecord).status).toBe('pending_approval');
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });

  it('타워 재시작 시 원본 인자 소실 → 승인 400 (마스킹본 실행 사고 방지)', async () => {
    const created = await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'a', password: 's' } });
    const pending = created.body as unknown as RunRecord;
    const restarted = await startTower(); // 같은 runsDir/registryDir, 새 프로세스 상태
    try {
      const r = await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'x' }, urlOf(restarted));
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/원본 인자 소실/);
    } finally {
      await new Promise<void>((r) => restarted.close(() => r()));
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-api.test.ts`
Expected: FAIL — `server.js`/`api.js` 미존재

- [ ] **Step 3: api.ts 구현 (코어)**

`apps/control-tower/src/api.ts`:

```ts
import type { SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import { RunStore, type ListRunsOptions, type RunRecord } from '../../../packages/sangfor-runs/src/index.js';
import { BridgeClient, safetyOf, type BridgeTool } from './bridge-client.js';
import { Registry, mergeDeviceArgs, applyMockCredentialFallback } from './registry.js';
import { mintBridgeApproval } from './approval-mint.js';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface TowerOptions {
  bridgeUrl?: string;
  token?: string;
  runsDir?: string;
  registryDir?: string;
  approvalSecret?: string;
  mockConsoleUrl?: string;
}

interface EvalLike { ok: boolean; summary: { pass: number; fail: number } }

function asEval(value: unknown): EvalLike | null {
  const e = value as { ok?: unknown; summary?: { pass?: unknown; fail?: unknown } } | null;
  return e && typeof e === 'object' && typeof e.ok === 'boolean'
    && typeof e.summary?.pass === 'number' && typeof e.summary?.fail === 'number'
    ? (e as EvalLike)
    : null;
}

// 스펙 §6.1: EvaluationResult(직접 | .evaluation | .evaluations[] 래핑)면 ok/pass/fail
// 요약, advisor 오류 결과({error})면 error 첫줄, 그 외 JSON 첫 150자. 최대 200자.
export function summarize(result: unknown): string {
  const cap = (s: string) => s.slice(0, 200);
  const fmt = (ok: boolean, pass: number, fail: number) => `ok=${ok} pass=${pass} fail=${fail}`;
  if (result && typeof result === 'object') {
    const r = result as { evaluation?: unknown; evaluations?: unknown[]; error?: unknown };
    const direct = asEval(result);
    if (direct) return fmt(direct.ok, direct.summary.pass, direct.summary.fail);
    const single = asEval(r.evaluation);
    if (single) return fmt(single.ok, single.summary.pass, single.summary.fail);
    if (Array.isArray(r.evaluations)) {
      const parts = r.evaluations.map(asEval).filter((p): p is EvalLike => p !== null);
      if (parts.length) {
        return fmt(
          parts.every((p) => p.ok),
          parts.reduce((n, p) => n + p.summary.pass, 0),
          parts.reduce((n, p) => n + p.summary.fail, 0),
        );
      }
    }
    if (typeof r.error === 'string') return cap(`error: ${r.error.slice(0, 150)}`);
  }
  try {
    return cap(JSON.stringify(result)?.slice(0, 150) ?? 'null');
  } catch {
    return cap(String(result).slice(0, 150));
  }
}

export function createApi(opts: TowerOptions = {}) {
  const bridge = new BridgeClient(opts.bridgeUrl, opts.token);
  const store = new RunStore(opts.runsDir);
  const registry = new Registry(opts.registryDir);
  const approvalSecret = opts.approvalSecret ?? process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
  const mockConsoleUrl = opts.mockConsoleUrl ?? process.env.MOCK_CONSOLE_URL ?? 'http://127.0.0.1:3400';
  // 승인 대기 run의 실행용 원본(무마스킹) args. 저장소에는 마스킹본만 있으므로 타워
  // 재시작으로 소실되면 해당 pending은 승인 시 400 — 마스킹본('***')을 실제 장비에
  // 보내는 사고를 막는다 (스펙 §6.2).
  const originalArgs = new Map<string, Record<string, unknown>>();

  async function listBridgeTools(): Promise<BridgeTool[]> {
    try {
      return await bridge.listTools();
    } catch (error) {
      throw new ApiError(502, `bridge unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function execute(
    runId: string,
    toolId: string,
    args: Record<string, unknown>,
    approval?: SignedApproval,
  ): Promise<RunRecord> {
    const started = Date.now();
    const call = await bridge.callTool(toolId, args, approval);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - started;
    if (call.ok) {
      return store.transition(runId, {
        status: 'succeeded', resultJson: call.data, resultSummary: summarize(call.data), durationMs, finishedAt,
      });
    }
    return store.transition(runId, {
      status: 'failed', error: call.errorText ?? 'unknown bridge error', durationMs, finishedAt,
    });
  }

  function stripResultJson(record: RunRecord): RunRecord {
    const { resultJson: _resultJson, ...rest } = record;
    return rest as RunRecord;
  }

  return {
    async createRun(input: { toolId: string; args?: Record<string, unknown>; deviceId?: string }): Promise<RunRecord> {
      if (!input.toolId) throw new ApiError(400, 'toolId is required');
      const tools = await listBridgeTools();
      const tool = tools.find((t) => t.name === input.toolId);
      if (!tool) throw new ApiError(400, `unknown tool: ${input.toolId}`);
      let args = input.args ?? {};
      if (input.deviceId) {
        const device = registry.devices().find((d) => d.id === input.deviceId);
        if (!device) throw new ApiError(400, `unknown device: ${input.deviceId}`);
        const vendor = registry.vendorFor(device.product);
        if (!vendor) throw new ApiError(400, `no vendor descriptor for product: ${device.product}`);
        args = applyMockCredentialFallback(mergeDeviceArgs(vendor, device, args), vendor, tool.inputSchema);
      }
      const toolSafety = safetyOf(tool);
      if (toolSafety === 'read_only') {
        const record = store.createRun({ toolId: tool.name, toolSafety, args, deviceId: input.deviceId, initialStatus: 'running' });
        return execute(record.runId, tool.name, args);
      }
      const record = store.createRun({ toolId: tool.name, toolSafety, args, deviceId: input.deviceId, initialStatus: 'pending_approval' });
      originalArgs.set(record.runId, args);
      return record;
    },

    listRuns(query: ListRunsOptions = {}): RunRecord[] {
      return store.listRuns(query).map(stripResultJson);
    },

    getRun(runId: string): RunRecord {
      const record = store.getRun(runId);
      if (!record) throw new ApiError(404, `unknown run: ${runId}`);
      return record;
    },

    async approveRun(
      runId: string,
      input: { approvedBy: string; changeTicketId?: string; rollbackPlanId?: string },
    ): Promise<RunRecord> {
      const record = store.getRun(runId);
      if (!record) throw new ApiError(404, `unknown run: ${runId}`);
      if (record.status !== 'pending_approval') throw new ApiError(409, `run is not pending_approval: ${record.status}`);
      if (!input.approvedBy?.trim()) throw new ApiError(400, 'approvedBy is required');
      if (!approvalSecret) throw new ApiError(500, 'approval secret not configured');
      const args = originalArgs.get(runId);
      if (!args) throw new ApiError(400, '원본 인자 소실 — 재요청 필요');
      const changeTicketId = input.changeTicketId?.trim() || `run:${runId}`;
      const rollbackPlanId = input.rollbackPlanId?.trim() || 'n/a-read-back-verify';
      const signed = mintBridgeApproval(record.toolId, {
        secret: approvalSecret, approvedBy: input.approvedBy, changeTicketId, rollbackPlanId, ttlSec: 120,
      });
      store.transition(runId, {
        status: 'running',
        approval: { approvedBy: input.approvedBy, approvedAt: new Date().toISOString(), changeTicketId, rollbackPlanId },
      });
      const final = await execute(runId, record.toolId, args, signed);
      originalArgs.delete(runId);
      return final;
    },

    rejectRun(runId: string, input: { reason?: string }): RunRecord {
      const record = store.getRun(runId);
      if (!record) throw new ApiError(404, `unknown run: ${runId}`);
      if (record.status !== 'pending_approval') throw new ApiError(409, `run is not pending_approval: ${record.status}`);
      if (!input.reason?.trim()) throw new ApiError(400, 'reason is required');
      originalArgs.delete(runId);
      return store.transition(runId, { status: 'rejected', rejectedReason: input.reason.trim() });
    },
  };
}

export type TowerApi = ReturnType<typeof createApi>;
```

(`mockConsoleUrl`은 Task 8의 health()에서 사용한다 — 이 시점에는 선언만 있고 미사용이라 tsc `noUnusedLocals`가 켜져 있지 않으므로 통과한다. 불안하면 `void mockConsoleUrl;` 한 줄을 임시로 두고 Task 8에서 제거해도 된다.)

- [ ] **Step 4: server.ts 구현 (API 라우팅만)**

`apps/control-tower/src/server.ts`:

```ts
import http from 'node:http';
import { URL } from 'node:url';
import { checkAuth } from '../../../packages/shared/src/index.js';
import type { RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import { createApi, ApiError, type TowerOptions } from './api.js';

export interface TowerServerOptions extends TowerOptions {
  apiToken?: string;
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

export function createTowerServer(opts: TowerServerOptions = {}): http.Server {
  const api = createApi(opts);
  const apiToken = opts.apiToken ?? process.env.SANGFOR_API_TOKEN;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // Shared-secret gate for API routes (no-op when the token is unset).
    if (path.startsWith('/api/')) {
      const auth = checkAuth(req.headers['authorization'], apiToken);
      if (!auth.ok) return json(res, { error: 'unauthorized' }, auth.status ?? 401);
    }

    try {
      if (method === 'POST' && path === '/api/runs') {
        const b = await readJsonBody(req);
        return json(res, await api.createRun({
          toolId: String(b.toolId ?? ''),
          args: (b.args && typeof b.args === 'object' ? b.args : {}) as Record<string, unknown>,
          deviceId: typeof b.deviceId === 'string' ? b.deviceId : undefined,
        }));
      }
      if (method === 'GET' && path === '/api/runs') {
        const num = (v: string | null) => (v === null || v === '' ? undefined : Number(v));
        return json(res, {
          runs: api.listRuns({
            status: (url.searchParams.get('status') ?? undefined) as RunStatus | undefined,
            toolId: url.searchParams.get('toolId') ?? undefined,
            deviceId: url.searchParams.get('deviceId') ?? undefined,
            sweepId: url.searchParams.get('sweepId') ?? undefined,
            sinceDays: num(url.searchParams.get('sinceDays')),
            limit: num(url.searchParams.get('limit')),
          }),
        });
      }
      const approveMatch = path.match(/^\/api\/runs\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        const b = await readJsonBody(req);
        return json(res, await api.approveRun(approveMatch[1], {
          approvedBy: String(b.approvedBy ?? ''),
          changeTicketId: typeof b.changeTicketId === 'string' ? b.changeTicketId : undefined,
          rollbackPlanId: typeof b.rollbackPlanId === 'string' ? b.rollbackPlanId : undefined,
        }));
      }
      const rejectMatch = path.match(/^\/api\/runs\/([^/]+)\/reject$/);
      if (method === 'POST' && rejectMatch) {
        const b = await readJsonBody(req);
        return json(res, api.rejectRun(rejectMatch[1], {
          reason: typeof b.reason === 'string' ? b.reason : undefined,
        }));
      }
      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
      if (method === 'GET' && runMatch) return json(res, api.getRun(runMatch[1]));

      return json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json(res, { error: error.message }, error.status);
      return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-api.test.ts`
Expected: PASS (9 tests)

Run: `npm run lint`
Expected: 에러 0

- [ ] **Step 6: Commit**

```bash
git add apps/control-tower/src tests/control-tower-api.test.ts
git commit -m "feat(control-tower): run lifecycle API — immediate reads, approval-gated writes (T-API-1)

Original (unmasked) args for pending runs live only in memory; approval after
a tower restart is refused with 400 so masked args can never reach a device.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 8: Tower API 확장 — overview·tools·devices·sweep·health·mint (T-API-2)

**Files:**
- Modify: `apps/control-tower/src/api.ts` (타입·헬퍼·메서드 추가)
- Modify: `apps/control-tower/src/server.ts` (라우트 추가)
- Test: `tests/control-tower-api.test.ts` (describe 추가)

**Interfaces:**
- Consumes: Task 7의 `createApi` 내부(bridge/store/registry/execute), `nowId` (`@sangfor/shared` deep import 추가)
- Produces (Task 9 UI·Task 11이 의존):
  - `interface HealthEntry { ok: boolean; detail: string }` / `interface HealthReport { bridge; mcp; mockConsole; store; rag: HealthEntry }`
  - `interface DeviceSummary { id; name; product; productLabel; host: string; tags: string[]; lastAdvisory?: { runId: string; toolId: string; finishedAt?: string; status: RunStatus; ok?: boolean; pass?: number; fail?: number } }`
  - api 추가 메서드: `overview()`, `toolGroups()`, `listDevices()`, `createDevice(input)`, `updateDevice(id, patch)`, `deleteDevice(id)`, `sweep(input)`, `health()`, `mint(input)`

- [ ] **Step 1: 실패하는 테스트 추가 — `tests/control-tower-api.test.ts` 하단에 append**

```ts
describe('Tower API — devices/sweep/overview/health (T-API-2)', () => {
  function seedStubVendor() {
    writeFileSync(join(registryDir, 'vendors.json'), JSON.stringify([{
      product: 'STUB_FW', label: 'Stub FW',
      advisorTools: ['stub.read', 'stub.write'], // write가 섞인 오기 케이스 포함
      credentialFields: ['host', 'username', 'password'],
      defaultArgs: { specVersion: '1.0' },
    } satisfies VendorDescriptor]));
  }

  it('devices CRUD 라우트: 등록(미등록 product 400)/수정/삭제, 목록은 vendors 동봉', async () => {
    seedStubVendor();
    const bad = await call('POST', '/api/devices', { name: 'x', product: 'NOPE', host: 'h' });
    expect(bad.status).toBe(400);
    const created = await call('POST', '/api/devices', { name: 'fw1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: ['lab'] });
    expect(created.status).toBe(200);
    const id = String((created.body as Record<string, unknown>).id);
    const list = await call('GET', '/api/devices');
    expect((list.body.devices as unknown[])).toHaveLength(1);
    expect((list.body.vendors as Array<{ product: string }>)[0].product).toBe('STUB_FW');
    const updated = await call('PUT', `/api/devices/${id}`, { name: 'fw1-renamed' });
    expect((updated.body as Record<string, unknown>).name).toBe('fw1-renamed');
    expect((await call('DELETE', `/api/devices/${id}`)).body).toEqual({ ok: true });
    expect((await call('PUT', '/api/devices/dev_none', { name: 'x' })).status).toBe(400);
  });

  it('sweep: 장비×advisorTools 실행, read-only 아닌 도구는 failed 기록, sweepId 태깅', async () => {
    seedStubVendor();
    const device = new Registry(registryDir).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
    const r = await call('POST', '/api/sweep', {});
    expect(r.status).toBe(200);
    const sweepId = String(r.body.sweepId);
    expect(sweepId).toMatch(/^sweep_/);
    const runs = r.body.runs as RunRecord[];
    expect(runs).toHaveLength(2); // stub.read + stub.write
    const read = runs.find((x) => x.toolId === 'stub.read')!;
    const write = runs.find((x) => x.toolId === 'stub.write')!;
    expect(read.status).toBe('succeeded');
    expect(read.sweepId).toBe(sweepId);
    expect(read.deviceId).toBe(device.id);
    expect(write.status).toBe('failed');
    expect(write.error).toBe('sweep은 읽기전용 도구만 실행');
    // 이력에서 sweepId 필터로 재조회 가능
    const listed = await call('GET', `/api/runs?sweepId=${sweepId}`);
    expect((listed.body.runs as RunRecord[])).toHaveLength(2);
    // 존재하지 않는 deviceIds → 400
    expect((await call('POST', '/api/sweep', { deviceIds: ['dev_none'] })).status).toBe(400);
  });

  it('tools: category 그룹핑', async () => {
    const r = await call('GET', '/api/tools');
    const groups = r.body.groups as Record<string, Array<{ name: string }>>;
    expect(groups.advisory.map((t) => t.name)).toContain('stub.read');
    expect(groups.pm.map((t) => t.name)).toContain('stub.write');
  });

  it('overview: 4위젯 형태 + 장비 요약의 lastAdvisory 파싱 + 목록 resultJson 제외', async () => {
    seedStubVendor();
    const device = new Registry(registryDir).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
    await call('POST', '/api/runs', { toolId: 'stub.read', deviceId: device.id });   // 자문 성공 이력
    await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'a' } }); // 승인 대기 1건
    const r = await call('GET', '/api/overview');
    expect(r.status).toBe(200);
    const body = r.body as {
      devices: Array<{ id: string; productLabel: string; lastAdvisory?: { ok?: boolean; pass?: number; fail?: number } }>;
      recentRuns: RunRecord[];
      pendingApprovals: RunRecord[];
      health: Record<string, { ok: boolean; detail: string }>;
    };
    expect(body.devices[0].productLabel).toBe('Stub FW');
    expect(body.devices[0].lastAdvisory).toMatchObject({ ok: true, pass: 3, fail: 0 });
    expect(body.recentRuns.length).toBeGreaterThanOrEqual(2);
    expect(body.recentRuns.every((x) => !('resultJson' in x))).toBe(true);
    expect(body.pendingApprovals).toHaveLength(1);
    expect(body.health.bridge.ok).toBe(true);
    expect(body.health.mcp.ok).toBe(true);
    expect(body.health.mockConsole.ok).toBe(false); // mockConsoleUrl이 죽은 포트
  });

  it('health: 부분 실패를 값으로 표현 (stub bridge에는 store/rag 도구가 없음 → ok:false)', async () => {
    const r = await call('GET', '/api/health');
    const health = r.body as Record<string, { ok: boolean; detail: string }>;
    expect(health.bridge.ok).toBe(true);
    expect(health.store.ok).toBe(false); // stub bridge가 sangfor.store_health를 모름 → 404/error
    expect(health.rag.ok).toBe(false);
    expect(health.mockConsole.ok).toBe(false);
  });

  it('mint 라우트: 시크릿 있으면 SignedApproval 반환, 필수 필드 누락 400', async () => {
    const r = await call('POST', '/api/approvals/mint', {
      actionType: 'hci.create-volume', actionTarget: '127.0.0.1:vol-a',
      approvedBy: 'jmpark', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1', ttlSec: 60,
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.approvalToken).toBe('string');
    expect(typeof r.body.nonce).toBe('string');
    expect((await call('POST', '/api/approvals/mint', { actionType: 'x' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-api.test.ts`
Expected: FAIL — 신규 describe만 (404 Not found 등). Task 7의 describe는 계속 PASS.

- [ ] **Step 3: api.ts 확장**

`apps/control-tower/src/api.ts` 수정 — ① import 2줄 추가:

```ts
import { nowId } from '../../../packages/shared/src/index.js';
import { mintApproval } from './approval-mint.js';   // 기존 mintBridgeApproval import 줄에 병합:
// import { mintApproval, mintBridgeApproval } from './approval-mint.js';
import { RegistryValidationError, type Device, type VendorDescriptor } from './registry.js';
// ↑ 기존 registry import 줄에 병합해 한 줄로 유지:
// import { Registry, RegistryValidationError, mergeDeviceArgs, applyMockCredentialFallback, type Device, type VendorDescriptor } from './registry.js';
import type { RunStatus } from '../../../packages/sangfor-runs/src/index.js'; // 기존 runs import에 병합
```

② `TowerOptions` 아래에 공개 타입 추가:

```ts
export interface HealthEntry { ok: boolean; detail: string }

export interface HealthReport {
  bridge: HealthEntry;
  mcp: HealthEntry;
  mockConsole: HealthEntry;
  store: HealthEntry;
  rag: HealthEntry;
}

export interface DeviceSummary {
  id: string;
  name: string;
  product: string;
  productLabel: string;
  host: string;
  tags: string[];
  lastAdvisory?: {
    runId: string; toolId: string; finishedAt?: string; status: RunStatus;
    ok?: boolean; pass?: number; fail?: number;
  };
}

export interface Overview {
  devices: DeviceSummary[];
  recentRuns: RunRecord[];
  pendingApprovals: RunRecord[];
  health: HealthReport;
}
```

③ 모듈 레벨(비공개) 동시성 풀 — `summarize` 아래에 추가:

```ts
async function promisePool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
```

④ `createApi` 반환 객체에 메서드 추가 (`rejectRun` 뒤에):

```ts
    listDevices(): { devices: Device[]; vendors: VendorDescriptor[] } {
      return { devices: registry.devices(), vendors: registry.vendors() };
    },

    createDevice(input: { name: string; product: string; host: string; tags?: string[]; credentialEnv?: Record<string, string> }): Device {
      try {
        return registry.createDevice(input);
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
    },

    updateDevice(id: string, patch: Partial<Omit<Device, 'id' | 'createdAt' | 'updatedAt'>>): Device {
      try {
        return registry.updateDevice(id, patch);
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
    },

    deleteDevice(id: string): { ok: true } {
      try {
        registry.deleteDevice(id);
        return { ok: true };
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
    },

    async toolGroups(): Promise<{ groups: Record<string, BridgeTool[]> }> {
      const tools = await listBridgeTools();
      const groups: Record<string, BridgeTool[]> = {};
      for (const tool of tools) {
        (groups[tool.category ?? 'etc'] ??= []).push(tool);
      }
      return { groups };
    },

    // 스펙 §6.3: 장비 × 벤더 advisorTools, 동시성 3, 개별 실패는 해당 run만 failed.
    // advisorTools에 read-only가 아닌 도구가 섞이면(디스크립터 오기) 실행하지 않고
    // failed로 기록 — 조용한 쓰기 실행 사고 방지.
    async sweep(input: { deviceIds?: string[] }): Promise<{ sweepId: string; runs: RunRecord[] }> {
      const all = registry.devices();
      const targets = input.deviceIds?.length
        ? input.deviceIds.map((id) => {
            const device = all.find((d) => d.id === id);
            if (!device) throw new ApiError(400, `unknown device: ${id}`);
            return device;
          })
        : all;
      const tools = await listBridgeTools();
      const sweepId = nowId('sweep');
      const jobs: Array<{ device: Device; vendor: VendorDescriptor; toolId: string }> = [];
      for (const device of targets) {
        const vendor = registry.vendorFor(device.product);
        if (!vendor) continue; // 등록 시 검증되므로 정상 경로에서는 없음
        for (const toolId of vendor.advisorTools) jobs.push({ device, vendor, toolId });
      }
      const runs = await promisePool(jobs, 3, async ({ device, vendor, toolId }) => {
        const tool = tools.find((t) => t.name === toolId);
        if (!tool || safetyOf(tool) !== 'read_only') {
          const record = store.createRun({
            toolId, toolSafety: tool ? safetyOf(tool) : 'write', args: {},
            deviceId: device.id, sweepId, initialStatus: 'running',
          });
          return store.transition(record.runId, {
            status: 'failed',
            error: tool ? 'sweep은 읽기전용 도구만 실행' : `unknown tool: ${toolId}`,
            finishedAt: new Date().toISOString(),
          });
        }
        const args = applyMockCredentialFallback(mergeDeviceArgs(vendor, device, {}), vendor, tool.inputSchema);
        const record = store.createRun({
          toolId, toolSafety: 'read_only', args, deviceId: device.id, sweepId, initialStatus: 'running',
        });
        return execute(record.runId, toolId, args);
      });
      return { sweepId, runs };
    },

    // 모든 항목 best-effort(개별 3초 타임아웃) — 실패도 값으로, 절대 throw하지 않는다.
    async health(): Promise<HealthReport> {
      const bridgeHealth = await bridge.health();
      const toEntry = async (name: string): Promise<HealthEntry> => {
        const call = await bridge.callTool(name, {}, undefined, 3_000);
        return call.ok
          ? { ok: true, detail: JSON.stringify(call.data)?.slice(0, 120) ?? 'ok' }
          : { ok: false, detail: call.errorText ?? 'error' };
      };
      const [mockConsole, storeEntry, ragEntry] = await Promise.all([
        fetch(`${mockConsoleUrl}/state`, { signal: AbortSignal.timeout(3_000) })
          .then((r) => ({ ok: r.ok, detail: `HTTP ${r.status}` }))
          .catch((error) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) })),
        toEntry('sangfor.store_health'),
        toEntry('sangfor.rag_index_summary'),
      ]);
      return {
        bridge: { ok: bridgeHealth.status === 'ok', detail: `status=${bridgeHealth.status}` },
        mcp: { ok: bridgeHealth.mcp === 'connected', detail: `mcp=${bridgeHealth.mcp}` },
        mockConsole,
        store: storeEntry,
        rag: ragEntry,
      };
    },

    // 스펙 §5.3 대시보드 첫 화면 4위젯 단일 호출.
    async overview(): Promise<Overview> {
      const vendors = new Map(registry.vendors().map((v) => [v.product, v] as const));
      const devices: DeviceSummary[] = registry.devices().map((d) => {
        const vendor = vendors.get(d.product);
        const advisorSet = new Set(vendor?.advisorTools ?? []);
        const latest = store.listRuns({ deviceId: d.id, limit: 100 })
          .find((r) => advisorSet.has(r.toolId) && (r.status === 'succeeded' || r.status === 'failed'));
        const summary: DeviceSummary = {
          id: d.id, name: d.name, product: d.product,
          productLabel: vendor?.label ?? d.product, host: d.host, tags: d.tags,
        };
        if (latest) {
          const m = latest.resultSummary?.match(/ok=(true|false) pass=(\d+) fail=(\d+)/);
          summary.lastAdvisory = {
            runId: latest.runId, toolId: latest.toolId, finishedAt: latest.finishedAt, status: latest.status,
            ...(m ? { ok: m[1] === 'true', pass: Number(m[2]), fail: Number(m[3]) } : {}),
          };
        }
        return summary;
      });
      return {
        devices,
        recentRuns: store.listRuns({ limit: 20 }).map(stripResultJson),
        pendingApprovals: store.pendingApprovals().map(stripResultJson),
        health: await this.health(),
      };
    },

    // 스펙 §6.4: tool-args용 승인 수동 민팅 (HCI 등). 저장하지 않는다.
    mint(input: {
      actionType?: string; actionTarget?: string; approvedBy?: string;
      changeTicketId?: string; rollbackPlanId?: string; ttlSec?: number;
    }): SignedApproval {
      if (!approvalSecret) throw new ApiError(500, 'approval secret not configured');
      for (const field of ['actionType', 'approvedBy', 'changeTicketId', 'rollbackPlanId'] as const) {
        if (!input[field] || !String(input[field]).trim()) throw new ApiError(400, `${field} is required`);
      }
      return mintApproval({
        secret: approvalSecret,
        actionType: String(input.actionType),
        actionTarget: input.actionTarget ? String(input.actionTarget) : undefined,
        approvedBy: String(input.approvedBy),
        changeTicketId: String(input.changeTicketId),
        rollbackPlanId: String(input.rollbackPlanId),
        ttlSec: typeof input.ttlSec === 'number' ? input.ttlSec : undefined,
      });
    },
```

주의: `overview()`가 `this.health()`를 부르므로 반환 객체 리터럴의 메서드 단축 문법을 유지해야 한다(화살표 함수로 바꾸면 `this` 바인딩이 깨진다).

- [ ] **Step 4: server.ts 라우트 추가**

`apps/control-tower/src/server.ts` — `if (method === 'POST' && path === '/api/runs') {` 블록 **앞**에 추가:

```ts
      if (method === 'GET' && path === '/api/overview') return json(res, await api.overview());
      if (method === 'GET' && path === '/api/tools') return json(res, await api.toolGroups());
      if (method === 'GET' && path === '/api/health') return json(res, await api.health());
      if (method === 'GET' && path === '/api/devices') return json(res, api.listDevices());
      if (method === 'POST' && path === '/api/devices') {
        const b = await readJsonBody(req);
        return json(res, api.createDevice({
          name: String(b.name ?? ''),
          product: String(b.product ?? ''),
          host: String(b.host ?? ''),
          tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
          credentialEnv: b.credentialEnv && typeof b.credentialEnv === 'object'
            ? (b.credentialEnv as Record<string, string>) : undefined,
        }));
      }
      const deviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
      if (method === 'PUT' && deviceMatch) {
        const b = await readJsonBody(req);
        return json(res, api.updateDevice(deviceMatch[1], b as Record<string, never>));
      }
      if (method === 'DELETE' && deviceMatch) return json(res, api.deleteDevice(deviceMatch[1]));
      if (method === 'POST' && path === '/api/sweep') {
        const b = await readJsonBody(req);
        return json(res, await api.sweep({
          deviceIds: Array.isArray(b.deviceIds) ? b.deviceIds.map(String) : undefined,
        }));
      }
      if (method === 'POST' && path === '/api/approvals/mint') {
        const b = await readJsonBody(req);
        return json(res, api.mint(b as Parameters<typeof api.mint>[0]));
      }
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-api.test.ts`
Expected: PASS (15 tests)

Run: `npm run lint`
Expected: 에러 0

- [ ] **Step 6: Commit**

```bash
git add apps/control-tower/src tests/control-tower-api.test.ts
git commit -m "feat(control-tower): overview, sweep, health, device and mint APIs (T-API-2)

Sweep runs device × advisorTools at concurrency 3; a non-read-only tool in a
descriptor is recorded as failed instead of executed. Health is best-effort
with per-probe 3s timeouts — failures are values, never exceptions.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 9: UI + 서버 조립 + 기동 배선

**Files:**
- Create: `apps/control-tower/src/ui.ts`
- Modify: `apps/control-tower/src/server.ts` (GET / 라우트 + listen 가드 블록)
- Modify: `package.json` (dev 스크립트), `.env.example` (§10 신규 env 5종)
- Test: `tests/control-tower-api.test.ts` (UI 서빙 1케이스 추가)

**Interfaces:**
- Consumes: Task 8까지의 전체 API 라우트 (UI는 `/api/*`만 fetch)
- Produces: `dashboardHtml(): string`

**UI 규칙:** operator-console 다크테마 idiom(CSS 변수, 좌측 네비, 헤더 토큰 입력→localStorage `sangfor_api_token`). 클라이언트 JS는 **backtick·`${}` 금지, 문자열 연결만** (서버 템플릿 리터럴 보호). 동적 버튼은 `window.*` 전역 함수 + `onclick` 속성으로 배선.

- [ ] **Step 1: 실패하는 테스트 추가 — `tests/control-tower-api.test.ts` 하단에 append**

```ts
describe('Tower UI 서빙', () => {
  it('GET /는 무인증 HTML(한국어 레이블 포함), /api/*만 토큰 게이트', async () => {
    const res = await fetch(`${towerUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Sangfor Control Tower');
    expect(html).toContain('대시보드');
    expect(html).toContain('도구 실행');
    expect(html).toContain('실행 이력');
    expect(html).toContain('장비 관리');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-api.test.ts`
Expected: FAIL — GET /가 404 JSON

- [ ] **Step 3: ui.ts 구현 (전문)**

`apps/control-tower/src/ui.ts`:

```ts
// 서버렌더 단일 HTML + vanilla JS. 클라이언트 JS는 이 서버측 템플릿 리터럴 안에
// 들어가므로 backtick과 ${ 를 절대 쓰지 않는다(문자열 연결만).
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sangfor Control Tower</title>
  <style>
    :root { --bg:#0f172a; --card:#1e293b; --accent:#38bdf8; --text:#e2e8f0; --muted:#94a3b8; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Segoe UI,system-ui,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:14px 22px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
    h1 { margin:0; font-size:1.2rem; }
    .auth-box { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .auth-box input { width:220px; }
    main { display:grid; grid-template-columns:190px 1fr; min-height:calc(100vh - 54px); }
    nav { padding:14px; border-right:1px solid #334155; }
    nav button, nav a.ext { display:block; width:100%; text-align:left; margin:4px 0; padding:9px 11px; border:1px solid #334155; border-radius:8px; background:var(--card); color:var(--text); cursor:pointer; font-size:.9rem; text-decoration:none; }
    nav button.active { border-color:var(--accent); background:#0c4a6e; }
    section { padding:18px 22px; overflow:auto; }
    .panel { display:none; }
    .panel.active { display:block; }
    .grid4 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .card { background:var(--card); border:1px solid #334155; border-radius:12px; padding:14px; }
    .card h3 { margin:0 0 10px; font-size:.95rem; color:var(--accent); }
    .meta { color:var(--muted); font-size:.82rem; }
    table { width:100%; border-collapse:collapse; font-size:.85rem; }
    th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #334155; vertical-align:top; }
    tr.clickable { cursor:pointer; }
    tr.clickable:hover { background:#0c4a6e33; }
    label { display:block; margin:8px 0 4px; font-size:.85rem; color:var(--muted); }
    input, select, textarea { width:100%; padding:8px 10px; border:1px solid #334155; border-radius:8px; background:#0b1220; color:var(--text); font:inherit; }
    textarea { min-height:70px; resize:vertical; font-family:ui-monospace,monospace; }
    button.primary { margin-top:10px; padding:9px 14px; border:none; border-radius:8px; background:var(--accent); color:#0f172a; font-weight:600; cursor:pointer; }
    button.small { padding:4px 9px; border:1px solid #334155; border-radius:6px; background:#0b1220; color:var(--text); cursor:pointer; font-size:.8rem; margin-right:4px; }
    pre.result { background:#0b1220; border:1px solid #334155; border-radius:10px; padding:12px; overflow:auto; max-height:420px; font-size:.78rem; white-space:pre-wrap; word-break:break-word; }
    .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.72rem; font-weight:600; }
    .sf-read_only { background:#14532d; color:var(--ok); }
    .sf-write { background:#78350f; color:var(--warn); }
    .sf-destructive { background:#7f1d1d; color:var(--err); }
    .st-succeeded { color:var(--ok); }
    .st-failed { color:var(--err); }
    .st-pending_approval { color:var(--warn); }
    .st-running { color:var(--accent); }
    .st-rejected { color:var(--muted); }
    .hl-ok { color:var(--ok); }
    .hl-bad { color:var(--err); }
    .tabbar button { margin:0 6px 8px 0; }
    .tool-item { margin:4px 0; }
    .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:end; margin-bottom:10px; }
    .filters > div { min-width:130px; }
    #run-modal { display:none; position:fixed; inset:0; background:#000a; padding:5vh 8vw; z-index:10; }
    #run-modal .card { max-height:88vh; overflow:auto; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    @media (max-width:860px) { main { grid-template-columns:1fr; } .grid4, .row2 { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Sangfor Control Tower</h1>
    <div class="auth-box">
      <input id="api-token" type="password" autocomplete="off" placeholder="API bearer token" />
      <button class="small" id="save-token" type="button">토큰 저장</button>
      <span class="meta">:3700 · bridge :3600</span>
    </div>
  </header>
  <main>
    <nav id="nav">
      <button data-panel="dashboard" class="active">대시보드</button>
      <button data-panel="tools">도구 실행</button>
      <button data-panel="runs">실행 이력</button>
      <button data-panel="devices">장비 관리</button>
      <a class="ext" href="http://localhost:3502" target="_blank">운영콘솔 :3502 ↗</a>
      <a class="ext" href="http://localhost:3400" target="_blank">Mock콘솔 :3400 ↗</a>
    </nav>
    <section>
      <div id="dashboard" class="panel active">
        <button class="small" onclick="loadOverview()">새로고침</button>
        <div class="grid4" style="margin-top:10px">
          <div class="card"><h3>장비 · 자문 요약</h3><div id="w-devices" class="meta">로딩…</div></div>
          <div class="card"><h3>시스템 건강도</h3><div id="w-health" class="meta">로딩…</div></div>
          <div class="card"><h3>승인 대기 큐</h3><div id="w-pending" class="meta">로딩…</div></div>
          <div class="card"><h3>최근 실행 20건</h3><div id="w-recent" class="meta">로딩…</div></div>
        </div>
      </div>

      <div id="tools" class="panel">
        <div class="tabbar" id="tool-tabs"></div>
        <div class="row2">
          <div class="card"><h3>도구 목록</h3><div id="tool-list" class="meta">카테고리를 선택하세요</div></div>
          <div class="card">
            <h3 id="tf-title">도구 선택 대기</h3>
            <div id="tf-device-row" style="display:none"><label>장비 (선택 시 인자 자동 주입)</label><select id="tf-device"></select></div>
            <div id="tf-fields"></div>
            <div id="tf-actions" style="display:none">
              <button class="primary" onclick="runTool()">실행</button>
              <button class="small" onclick="mintToken()" style="margin-left:8px">승인 토큰 민팅 (HCI tool-args용)</button>
            </div>
            <pre class="result" id="tf-result" style="display:none"></pre>
          </div>
        </div>
      </div>

      <div id="runs" class="panel">
        <div class="filters">
          <div><label>상태</label><select id="rf-status"><option value="">전체</option><option>pending_approval</option><option>running</option><option>succeeded</option><option>failed</option><option>rejected</option></select></div>
          <div><label>도구</label><input id="rf-tool" placeholder="sangfor.advisor_..." /></div>
          <div><label>장비 ID</label><input id="rf-device" /></div>
          <div><label>Sweep ID</label><input id="rf-sweep" /></div>
          <div><label>기간(일)</label><input id="rf-since" type="number" value="14" /></div>
          <div><button class="primary" onclick="loadRuns()">조회</button></div>
        </div>
        <div class="card"><table id="runs-table"><thead><tr><th>시각</th><th>도구</th><th>안전등급</th><th>상태</th><th>소요</th><th>요약</th></tr></thead><tbody></tbody></table></div>
      </div>

      <div id="devices" class="panel">
        <div class="row2">
          <div class="card">
            <h3>장비 목록</h3>
            <button class="primary" id="btn-sweep" onclick="runSweep()">전체 일괄 자문 실행</button>
            <table id="devices-table" style="margin-top:10px"><thead><tr><th>이름</th><th>제품</th><th>host</th><th>태그</th><th></th></tr></thead><tbody></tbody></table>
          </div>
          <div class="card">
            <h3 id="df-title">장비 등록</h3>
            <label>이름 *</label><input id="df-name" />
            <label>제품 *</label><select id="df-product"></select>
            <label>host *</label><input id="df-host" placeholder="10.0.0.1 또는 http://127.0.0.1:3400" />
            <label>태그 (쉼표 구분)</label><input id="df-tags" />
            <label>credentialEnv (JSON — 값은 env 변수 이름)</label><textarea id="df-credenv" placeholder='{"username":"FGT_LAB_USER","password":"FGT_LAB_PASS"}'></textarea>
            <button class="primary" onclick="saveDevice()">저장</button>
            <button class="small" onclick="resetDeviceForm()" style="margin-left:8px">초기화</button>
          </div>
        </div>
      </div>
    </section>
  </main>

  <div id="run-modal" onclick="if(event.target===this)this.style.display='none'">
    <div class="card">
      <button class="small" onclick="document.getElementById('run-modal').style.display='none'">닫기</button>
      <pre class="result" id="run-modal-pre"></pre>
    </div>
  </div>

<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'sangfor_api_token';
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function headers(json) {
    var h = json ? { 'content-type': 'application/json' } : {};
    var t = (localStorage.getItem(TOKEN_KEY) || '').trim();
    if (t) h.authorization = 'Bearer ' + t;
    return h;
  }
  function req(method, path, body) {
    return fetch(path, {
      method: method, headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }
  function fail(err) { alert('오류: ' + err.message); }
  function when(iso) { return iso ? String(iso).replace('T', ' ').slice(5, 19) : '-'; }
  function statusHtml(s) { return '<span class="st-' + esc(s) + '">' + esc(s) + '</span>'; }
  function safetyHtml(s) { return '<span class="badge sf-' + esc(s) + '">' + esc(s) + '</span>'; }

  // ── 네비 ──
  var navButtons = document.querySelectorAll('#nav button');
  navButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      navButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
      $(btn.dataset.panel).classList.add('active');
      if (btn.dataset.panel === 'dashboard') loadOverview();
      if (btn.dataset.panel === 'tools') loadTools();
      if (btn.dataset.panel === 'runs') loadRuns();
      if (btn.dataset.panel === 'devices') loadDevices();
    });
  });
  $('api-token').value = localStorage.getItem(TOKEN_KEY) || '';
  $('save-token').addEventListener('click', function () {
    localStorage.setItem(TOKEN_KEY, $('api-token').value.trim());
    loadOverview();
  });

  // ── 대시보드 ──
  window.loadOverview = function () {
    req('GET', '/api/overview').then(function (o) {
      $('w-devices').innerHTML = o.devices.length === 0 ? '등록된 장비 없음' : o.devices.map(function (d) {
        var adv = d.lastAdvisory;
        var badge = !adv ? '<span class="meta">미점검</span>'
          : adv.ok === undefined ? statusHtml(adv.status)
          : '<span class="' + (adv.ok ? 'hl-ok' : 'hl-bad') + '">' + (adv.ok ? 'OK' : 'FAIL') + ' pass=' + adv.pass + ' fail=' + adv.fail + '</span> <span class="meta">' + when(adv.finishedAt) + '</span>';
        return '<div style="margin:6px 0"><strong>' + esc(d.name) + '</strong> <span class="meta">' + esc(d.productLabel) + ' · ' + esc(d.host) + '</span><br/>' + badge + '</div>';
      }).join('');
      $('w-recent').innerHTML = o.recentRuns.length === 0 ? '실행 이력 없음' : '<table><tbody>' + o.recentRuns.map(function (r) {
        return '<tr class="clickable" onclick="showRun(\'' + esc(r.runId) + '\')"><td>' + when(r.requestedAt) + '</td><td>' + esc(r.toolId) + '</td><td>' + statusHtml(r.status) + '</td><td>' + (r.durationMs == null ? '-' : r.durationMs + 'ms') + '</td></tr>';
      }).join('') + '</tbody></table>';
      $('w-pending').innerHTML = o.pendingApprovals.length === 0 ? '대기 없음' : o.pendingApprovals.map(function (r) {
        return '<div style="margin:6px 0"><strong>' + esc(r.toolId) + '</strong> <span class="meta">' + when(r.requestedAt) + '</span><br/><span class="meta">' + esc(JSON.stringify(r.args)).slice(0, 120) + '</span><br/>'
          + '<button class="small" onclick="approveRun(\'' + esc(r.runId) + '\')">승인</button>'
          + '<button class="small" onclick="rejectRun(\'' + esc(r.runId) + '\')">거부</button></div>';
      }).join('');
      var order = ['bridge', 'mcp', 'mockConsole', 'store', 'rag'];
      $('w-health').innerHTML = order.map(function (k) {
        var h = o.health[k];
        return '<div><span class="' + (h.ok ? 'hl-ok' : 'hl-bad') + '">●</span> ' + k + ' <span class="meta">' + esc(h.detail) + '</span></div>';
      }).join('');
    }).catch(fail);
  };
  window.approveRun = function (runId) {
    var by = prompt('승인자 ID (approvedBy)');
    if (!by) return;
    req('POST', '/api/runs/' + runId + '/approve', { approvedBy: by })
      .then(function (r) { alert('실행 결과: ' + r.status + (r.error ? ' — ' + r.error : '')); loadOverview(); })
      .catch(fail);
  };
  window.rejectRun = function (runId) {
    var reason = prompt('거부 사유');
    if (!reason) return;
    req('POST', '/api/runs/' + runId + '/reject', { reason: reason })
      .then(function () { loadOverview(); }).catch(fail);
  };

  // ── 도구 실행 ──
  var toolGroups = {};
  var currentTool = null;
  var deviceCache = { devices: [], vendors: [] };
  window.loadTools = function () {
    Promise.all([req('GET', '/api/tools'), req('GET', '/api/devices')]).then(function (results) {
      toolGroups = results[0].groups;
      deviceCache = results[1];
      $('tool-tabs').innerHTML = Object.keys(toolGroups).sort().map(function (cat) {
        return '<button class="small" onclick="showCategory(\'' + esc(cat) + '\')">' + esc(cat) + ' (' + toolGroups[cat].length + ')</button>';
      }).join('');
    }).catch(fail);
  };
  window.showCategory = function (cat) {
    $('tool-list').innerHTML = toolGroups[cat].map(function (t) {
      var safety = t.annotations.destructiveHint ? 'destructive' : (t.annotations.readOnlyHint ? 'read_only' : 'write');
      return '<div class="tool-item">' + safetyHtml(safety) + ' <a href="#" onclick="selectTool(\'' + esc(cat) + '\',\'' + esc(t.name) + '\');return false" style="color:var(--accent)">' + esc(t.name) + '</a><br/><span class="meta">' + esc(t.description).slice(0, 140) + '</span></div>';
    }).join('');
  };
  window.selectTool = function (cat, name) {
    currentTool = toolGroups[cat].find(function (t) { return t.name === name; });
    $('tf-title').textContent = name;
    $('tf-actions').style.display = 'block';
    $('tf-result').style.display = 'none';
    var devOptions = '<option value="">(장비 미지정)</option>' + deviceCache.devices.map(function (d) {
      return '<option value="' + esc(d.id) + '">' + esc(d.name) + ' (' + esc(d.product) + ')</option>';
    }).join('');
    $('tf-device').innerHTML = devOptions;
    $('tf-device-row').style.display = 'block';
    var props = (currentTool.inputSchema && currentTool.inputSchema.properties) || {};
    var required = (currentTool.inputSchema && currentTool.inputSchema.required) || [];
    $('tf-fields').innerHTML = Object.keys(props).map(function (key) {
      var p = props[key];
      var star = required.indexOf(key) > -1 ? ' *' : '';
      var id = 'arg-' + key;
      if (p.enum) {
        return '<label>' + esc(key) + star + '</label><select id="' + id + '" data-arg="' + esc(key) + '" data-kind="string"><option value=""></option>' + p.enum.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('') + '</select>';
      }
      if (p.type === 'boolean') {
        return '<label>' + esc(key) + star + '</label><select id="' + id + '" data-arg="' + esc(key) + '" data-kind="boolean"><option value=""></option><option>true</option><option>false</option></select>';
      }
      if (p.type === 'number' || p.type === 'integer') {
        return '<label>' + esc(key) + star + '</label><input id="' + id + '" data-arg="' + esc(key) + '" data-kind="number" type="number" />';
      }
      if (p.type === 'string' || p.type === undefined) {
        var dflt = p.default === undefined ? '' : String(p.default);
        return '<label>' + esc(key) + star + ' <span class="meta">' + esc(p.description || '') + '</span></label><input id="' + id + '" data-arg="' + esc(key) + '" data-kind="string" value="' + esc(dflt) + '" />';
      }
      return '<label>' + esc(key) + star + ' <span class="meta">(JSON)</span></label><textarea id="' + id + '" data-arg="' + esc(key) + '" data-kind="json"></textarea>';
    }).join('');
  };
  function collectArgs() {
    var args = {};
    var nodes = document.querySelectorAll('#tf-fields [data-arg]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var raw = el.value.trim();
      if (raw === '') continue; // 빈 값은 생략 → 서버측 장비 병합이 채움
      var kind = el.dataset.kind;
      if (kind === 'number') args[el.dataset.arg] = Number(raw);
      else if (kind === 'boolean') args[el.dataset.arg] = raw === 'true';
      else if (kind === 'json') args[el.dataset.arg] = JSON.parse(raw);
      else args[el.dataset.arg] = raw;
    }
    return args;
  }
  window.runTool = function () {
    if (!currentTool) return;
    var args;
    try { args = collectArgs(); } catch (e) { return alert('JSON 인자 파싱 실패: ' + e.message); }
    var body = { toolId: currentTool.name, args: args };
    var deviceId = $('tf-device').value;
    if (deviceId) body.deviceId = deviceId;
    $('tf-result').style.display = 'block';
    $('tf-result').textContent = '실행 중…';
    req('POST', '/api/runs', body).then(function (run) {
      if (run.status === 'pending_approval') {
        $('tf-result').textContent = '승인 대기로 이동했습니다 (runId: ' + run.runId + '). 대시보드 승인 큐에서 승인/거부하세요.';
      } else {
        $('tf-result').textContent = JSON.stringify(run, null, 2);
      }
    }).catch(function (e) { $('tf-result').textContent = '오류: ' + e.message; });
  };
  window.mintToken = function () {
    var actionType = prompt('actionType (예: hci.create-volume)');
    if (!actionType) return;
    var actionTarget = prompt('actionTarget (예: 127.0.0.1:vol-a)') || undefined;
    var approvedBy = prompt('approvedBy');
    if (!approvedBy) return;
    req('POST', '/api/approvals/mint', {
      actionType: actionType, actionTarget: actionTarget, approvedBy: approvedBy,
      changeTicketId: prompt('changeTicketId', 'CHG-manual') || 'CHG-manual',
      rollbackPlanId: prompt('rollbackPlanId', 'RB-manual') || 'RB-manual',
    }).then(function (signed) {
      var el = document.querySelector('#tf-fields [data-arg="approval"]');
      if (el && el.dataset.kind === 'json') { el.value = JSON.stringify(signed); alert('approval 필드에 삽입했습니다.'); }
      else { $('tf-result').style.display = 'block'; $('tf-result').textContent = JSON.stringify(signed, null, 2); }
    }).catch(fail);
  };

  // ── 실행 이력 ──
  window.loadRuns = function () {
    var q = [];
    if ($('rf-status').value) q.push('status=' + encodeURIComponent($('rf-status').value));
    if ($('rf-tool').value.trim()) q.push('toolId=' + encodeURIComponent($('rf-tool').value.trim()));
    if ($('rf-device').value.trim()) q.push('deviceId=' + encodeURIComponent($('rf-device').value.trim()));
    if ($('rf-sweep').value.trim()) q.push('sweepId=' + encodeURIComponent($('rf-sweep').value.trim()));
    if ($('rf-since').value) q.push('sinceDays=' + encodeURIComponent($('rf-since').value));
    req('GET', '/api/runs' + (q.length ? '?' + q.join('&') : '')).then(function (data) {
      document.querySelector('#runs-table tbody').innerHTML = data.runs.map(function (r) {
        return '<tr class="clickable" onclick="showRun(\'' + esc(r.runId) + '\')">'
          + '<td>' + when(r.requestedAt) + '</td><td>' + esc(r.toolId) + '</td>'
          + '<td>' + safetyHtml(r.toolSafety) + '</td><td>' + statusHtml(r.status) + '</td>'
          + '<td>' + (r.durationMs == null ? '-' : r.durationMs + 'ms') + '</td>'
          + '<td class="meta">' + esc(r.resultSummary || r.error || '') + '</td></tr>';
      }).join('');
    }).catch(fail);
  };
  window.showRun = function (runId) {
    req('GET', '/api/runs/' + runId).then(function (run) {
      $('run-modal-pre').textContent = JSON.stringify(run, null, 2);
      $('run-modal').style.display = 'block';
    }).catch(fail);
  };

  // ── 장비 관리 ──
  var editingDeviceId = null;
  window.loadDevices = function () {
    req('GET', '/api/devices').then(function (data) {
      deviceCache = data;
      $('df-product').innerHTML = data.vendors.map(function (v) {
        return '<option value="' + esc(v.product) + '">' + esc(v.label) + ' (' + esc(v.product) + ')</option>';
      }).join('');
      document.querySelector('#devices-table tbody').innerHTML = data.devices.map(function (d) {
        return '<tr><td>' + esc(d.name) + '</td><td>' + esc(d.product) + '</td><td>' + esc(d.host) + '</td><td class="meta">' + esc(d.tags.join(', ')) + '</td>'
          + '<td><button class="small" onclick="editDevice(\'' + esc(d.id) + '\')">수정</button>'
          + '<button class="small" onclick="removeDevice(\'' + esc(d.id) + '\')">삭제</button></td></tr>';
      }).join('');
    }).catch(fail);
  };
  window.resetDeviceForm = function () {
    editingDeviceId = null;
    $('df-title').textContent = '장비 등록';
    $('df-name').value = ''; $('df-host').value = ''; $('df-tags').value = ''; $('df-credenv').value = '';
  };
  window.editDevice = function (id) {
    var d = deviceCache.devices.find(function (x) { return x.id === id; });
    if (!d) return;
    editingDeviceId = id;
    $('df-title').textContent = '장비 수정: ' + d.name;
    $('df-name').value = d.name; $('df-product').value = d.product; $('df-host').value = d.host;
    $('df-tags').value = d.tags.join(', ');
    $('df-credenv').value = d.credentialEnv ? JSON.stringify(d.credentialEnv) : '';
  };
  window.saveDevice = function () {
    var body = {
      name: $('df-name').value.trim(),
      product: $('df-product').value,
      host: $('df-host').value.trim(),
      tags: $('df-tags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    };
    var credRaw = $('df-credenv').value.trim();
    if (credRaw) {
      try { body.credentialEnv = JSON.parse(credRaw); } catch (e) { return alert('credentialEnv JSON 파싱 실패: ' + e.message); }
    }
    var p = editingDeviceId ? req('PUT', '/api/devices/' + editingDeviceId, body) : req('POST', '/api/devices', body);
    p.then(function () { resetDeviceForm(); loadDevices(); }).catch(fail);
  };
  window.removeDevice = function (id) {
    if (!confirm('장비를 삭제할까요?')) return;
    req('DELETE', '/api/devices/' + id).then(function () { loadDevices(); }).catch(fail);
  };
  window.runSweep = function () {
    if (!confirm('등록된 전체 장비에 일괄 자문(read-only)을 실행할까요?')) return;
    $('btn-sweep').disabled = true;
    req('POST', '/api/sweep', {}).then(function (data) {
      $('btn-sweep').disabled = false;
      $('rf-sweep').value = data.sweepId;
      document.querySelector('#nav button[data-panel="runs"]').click();
    }).catch(function (e) { $('btn-sweep').disabled = false; fail(e); });
  };

  loadOverview();
})();
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: server.ts 최종 조립 (UI 라우트 + 기동 블록)**

`apps/control-tower/src/server.ts` — ① import 추가:

```ts
import { loadEnvFile } from '../../../packages/sangfor-collector/src/load-env.js';
import { resolveBindHost, assertBindSafety, checkAuth } from '../../../packages/shared/src/index.js'; // checkAuth import 줄에 병합
import { dashboardHtml } from './ui.js';
```

② 모듈 상단(import 직후)에 추가:

```ts
loadEnvFile('.env');
```

③ `createTowerServer`의 try 블록 첫 줄에 UI 라우트 추가:

```ts
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(dashboardHtml());
        return;
      }
```

④ 파일 끝에 기동 블록 추가 (mock-console 패턴 — 스펙 §4.8):

```ts
// Auto-start only when run as a process (not when imported by tests).
const port = Number(process.env.PORT ?? process.env.CONTROL_TOWER_PORT ?? 3700);
if (process.env.MCP_NO_SERVE !== '1' && process.env.VITEST === undefined) {
  const bindHost = resolveBindHost();
  const apiToken = process.env.SANGFOR_API_TOKEN;
  assertBindSafety(bindHost, apiToken); // fail closed: no public bind without a token
  createTowerServer().listen(port, bindHost, () => {
    console.log(`Sangfor Control Tower listening on http://${bindHost}:${port}${apiToken ? ' (token-gated)' : ''}`);
  });
}
```

- [ ] **Step 5: dev 스크립트 + .env.example**

`package.json` scripts의 `"dev:web"` 줄 다음에 추가:

```json
    "dev:web": "tsx apps/operator-console/src/server.ts",
    "dev:control-tower": "tsx apps/control-tower/src/server.ts",
```

`.env.example` 끝에 추가:

```
# ── Control Tower (:3700) ─────────────────────────────────────────────────
# 타워 포트 (PORT가 우선한다)
# CONTROL_TOWER_PORT=3700
# 타워가 호출할 http-bridge 주소
# CONTROL_TOWER_BRIDGE_URL=http://127.0.0.1:3600
# 실행이력 JSONL 루트 (기본 <repo>/data/runs — gitignored)
# SANGFOR_RUNS_ROOT=
# 벤더/장비 레지스트리 루트 (기본 <repo>/data/registry)
# SANGFOR_REGISTRY_ROOT=
# 건강도 위젯이 점검할 mock 콘솔 주소
# MOCK_CONSOLE_URL=http://127.0.0.1:3400
```

- [ ] **Step 6: 테스트·타입 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-api.test.ts`
Expected: PASS (16 tests)

Run: `npm run lint`
Expected: 에러 0

- [ ] **Step 7: 수동 스모크 (3프로세스 기동)**

터미널 3개(또는 백그라운드)로:

```bash
pnpm dev:mock-console      # :3400
pnpm dev:http-bridge       # :3600
SANGFOR_OPERATOR_APPROVAL_SECRET=dev-secret pnpm dev:control-tower  # :3700
```

확인:

```bash
curl -s http://127.0.0.1:3700/ | grep -o '<title>[^<]*'   # → <title>Sangfor Control Tower
curl -s http://127.0.0.1:3700/api/overview | head -c 200   # → {"devices":[],... health 포함 JSON
```

브라우저에서 `http://127.0.0.1:3700` — 4위젯 렌더, 건강도에 bridge/mcp/mockConsole 녹색 확인. (store/rag는 로컬 DB 상태에 따라 적색일 수 있음 — 값으로 표현되면 정상.)

- [ ] **Step 8: Commit**

```bash
git add apps/control-tower/src package.json .env.example tests/control-tower-api.test.ts
git commit -m "feat(control-tower): dashboard UI and server assembly on :3700

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 10: Mock 콘솔 벤더 네이티브 경로 서빙 (라이브 sweep 전제)

**Files:**
- Create: `apps/mock-sangfor-console/src/vendor-paths.ts`
- Modify: `apps/mock-sangfor-console/src/server.ts` (import 1줄 + 디스패치 1블록 — **기존 라우트 무변경**)
- Test: `tests/mock-vendor-paths.test.ts`

**Interfaces:**
- Consumes: `createMockConsoleServer()` (기존 export), `getToolHandler` (mcp-server — `MCP_NO_SERVE=1` import, 수정 금지)
- Produces: `const VENDOR_PATH_RESPONSES: Record<string, unknown>` (14경로)

**배경 (스펙 §11):** advisor 도구는 실제 벤더 API 경로를 조회한다 — FortiOS `/api/v2/*` 6경로, Cisco RESTCONF `/restconf/data/*` 8경로. mock은 `/api/v1/*`만 서빙하므로 지금은 mock 장비 sweep이 전부 `{error}`로 끝난다(advisor는 **엔드포인트 하나라도 비2xx면 evaluation 없이 error 반환**). 기존 `/api/v1` 핸들러 재사용(alias)은 응답 형태가 매퍼 요구와 부분 불일치(예: policy 핸들러에 srcintf/dstintf 없음)라서 쓰지 않고, **canonical fixture 형태(tests/mcp-advanced-integration.test.ts의 happy fixture 기준)의 정적 응답 맵**을 새로 만든다. `hci_health_report`는 기존 `/openstack/*` 라우트로 이미 동작한다(compute/image 404는 collectInventory가 빈 배열로 흡수) — HCI는 수정 불필요.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/mock-vendor-paths.test.ts` 신규 생성:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

// mock 콘솔에 벤더 네이티브 경로가 서빙되면, 배포된 advisor 도구가 그대로
// mock 장비를 sweep할 수 있다 (스펙 §11 — 라이브 sweep 전제).
describe('mock console — vendor-native advisor paths', () => {
  let server: http.Server;
  let base: string;
  let getToolHandler: typeof import('../apps/mcp-server/src/index.js')['getToolHandler'];

  beforeAll(async () => {
    ({ getToolHandler } = await import('../apps/mcp-server/src/index.js'));
    const { createMockConsoleServer } = await import('../apps/mock-sangfor-console/src/server.js');
    server = createMockConsoleServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('advisor_fortios: mock에서 evaluation 산출 (error 없음)', async () => {
    const result: any = await getToolHandler('sangfor.advisor_fortios')!({ host: base, username: 'mock', password: 'mock' });
    expect(result.error).toBeUndefined();
    expect(result.evaluation.summary.pass + result.evaluation.summary.fail).toBeGreaterThan(0);
  });

  it('advisor_fortios_advanced: 5개 엔드포인트 전부 서빙 → evaluations 2개', async () => {
    const result: any = await getToolHandler('sangfor.advisor_fortios_advanced')!({ host: base, username: 'mock', password: 'mock' });
    expect(result.error).toBeUndefined();
    expect(result.evaluations).toHaveLength(2);
  });

  it('advisor_cisco_iosxe: RESTCONF interfaces 경로 서빙 → evaluation 산출', async () => {
    const result: any = await getToolHandler('sangfor.advisor_cisco_iosxe')!({ host: base, username: 'mock', password: 'mock' });
    expect(result.error).toBeUndefined();
    expect(result.evaluation).toBeDefined();
  });

  it('advisor_cisco_iosxe_advanced: 7개 RESTCONF 경로 전부 서빙 → evaluations 2개', async () => {
    const result: any = await getToolHandler('sangfor.advisor_cisco_iosxe_advanced')!({ host: base, username: 'mock', password: 'mock' });
    expect(result.error).toBeUndefined();
    expect(result.evaluations).toHaveLength(2);
  });

  it('hci_health_report: 기존 /openstack 라우트로 summary 산출 (수정 없이)', async () => {
    const result: any = await getToolHandler('sangfor.hci_health_report')!({ identityBaseUrl: `${base}/openstack/identity/v2.0` });
    expect(result.summary).toBeDefined();
  });

  it('기존 /api/v1 라우트는 그대로 동작한다 (무변경 보증)', async () => {
    const res = await fetch(`${base}/api/v1/fortios/query-policy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/mock-vendor-paths.test.ts`
Expected: FAIL — advisor 4건이 `result.error`(`device query failed: ... HTTP 404`)로 떨어짐. HCI·`/api/v1` 케이스는 PASS.

- [ ] **Step 3: vendor-paths.ts 구현**

`apps/mock-sangfor-console/src/vendor-paths.ts`:

```ts
// Vendor-native advisor paths, served in addition to the /api/v1 mock routes so
// the deployed advisor tools (which query real FortiOS REST / Cisco RESTCONF
// paths) can live-sweep this mock console. Shapes mirror the canonical fixtures
// the config-state mappers accept (see tests/mcp-advanced-integration.test.ts).
export const VENDOR_PATH_RESPONSES: Record<string, unknown> = {
  // ── FortiOS: sangfor.advisor_fortios (1) + advisor_fortios_advanced (5) ──
  '/api/v2/firewall/policy': {
    results: [
      { policyid: 1, name: 'Allow-Internal-Traffic', action: 'accept', logtraffic: 'all', 'ssl-ssh-profile': 'certificate-inspection', srcintf: 'port1', dstintf: 'port2' },
      { policyid: 2, name: 'Allow-DNS', action: 'accept', logtraffic: 'utm', srcintf: 'port1', dstintf: 'port2' },
      { policyid: 3, name: 'Deny-All', action: 'deny', logtraffic: 'all', srcintf: 'port3', dstintf: 'port4' },
    ],
  },
  '/api/v2/monitor/system/status': {
    results: [{ cpu: 42, mem: 58, disk: 35, uptime: 864000, version: '7.2.0', serial: 'FG3000D3914908901' }],
  },
  '/api/v2/monitor/system/npu-stats': {
    results: [{ cpu: 65, packets_received: 1500000, packets_dropped: 1200 }],
  },
  '/api/v2/cmdb/system/ha-setting': {
    results: [{ mode: 'a-p', state: 'master', priority: 100, group_id: 1, remote_ip: '192.168.1.2' }],
  },
  '/api/v2/cmdb/firewall/policy': {
    results: [
      { policyid: 1, action: 'accept', srcintf: 'port1', dstintf: 'port2', logtraffic: 'all' },
      { policyid: 2, action: 'accept', srcintf: 'port1', dstintf: 'port2', logtraffic: 'utm' },
      { policyid: 3, action: 'deny', srcintf: 'port3', dstintf: 'port4', logtraffic: 'all' },
    ],
  },
  '/api/v2/cmdb/ips/sensor': {
    results: [{ signature_database: '20250703', sensor_name: 'default' }],
  },
  // ── Cisco IOS-XE: sangfor.advisor_cisco_iosxe (1) + advisor_cisco_iosxe_advanced (7) ──
  '/restconf/data/ietf-interfaces:interfaces': {
    'ietf-interfaces:interface': [
      { name: 'GigabitEthernet0/0/0' },
      { name: 'GigabitEthernet0/0/1' },
      { name: 'Loopback0' },
    ],
  },
  '/restconf/data/Cisco-IOS-XE-utilization:system': {
    'Cisco-IOS-XE-utilization:system': {
      'cpu-utilization': {
        'cpu-core': [
          { 'core-id': 0, 'cpu-utilization': 45 },
          { 'core-id': 1, 'cpu-utilization': 55 },
        ],
      },
    },
  },
  '/restconf/data/Cisco-IOS-XE-memory:memory': {
    'Cisco-IOS-XE-memory:memory': { 'memory-statistics': { total: 1000, used: 500 } },
  },
  '/restconf/data/ietf-interfaces:interfaces-state': {
    'ietf-interfaces:interfaces-state': {
      interface: [
        { name: 'GigabitEthernet0/0/0', 'oper-status': 'up' },
        { name: 'GigabitEthernet0/0/1', 'oper-status': 'down' },
      ],
    },
  },
  '/restconf/data/ietf-routing:routing': {
    'ietf-routing:routing': {
      'control-plane-protocols': {
        'control-plane-protocol': [{ 'vrf-name': 'default' }, { 'vrf-name': 'customer1' }],
      },
    },
  },
  '/restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair': {
    'Cisco-IOS-XE-zone-based-firewall:zone-pair': [
      { source_zone: 'inside', destination_zone: 'outside' },
      { source_zone: 'dmz', destination_zone: 'outside' },
    ],
  },
  '/restconf/data/Cisco-IOS-XE-acl:ip': {
    'Cisco-IOS-XE-acl:ip': {
      'access-lists': {
        'access-list': [
          { 'access-list-entries': { 'access-list-entry': [{ sequence: 10, action: 'permit' }, { sequence: 20, action: 'deny' }] } },
          { 'access-list-entries': { 'access-list-entry': [{ sequence: 10, action: 'permit' }] } },
        ],
      },
    },
  },
  '/restconf/data/Cisco-IOS-XE-snort:snort': {
    'Cisco-IOS-XE-snort:snort': { 'snort-config': { 'rule-database-version': '20250703', enabled: true } },
  },
};
```

- [ ] **Step 4: server.ts에 디스패치 1블록 추가**

`apps/mock-sangfor-console/src/server.ts` — 상단 import에 추가:

```ts
import { VENDOR_PATH_RESPONSES } from './vendor-paths.js';
```

`createMockConsoleServer()`의 요청 핸들러에서 `if (await openstack.handle(req, res)) return;` 줄 **바로 앞**에 추가 (기존 `/api/v1/*` 블록들은 한 글자도 건드리지 않는다):

```ts
    // Vendor-native advisor paths (additive aliases; existing routes unchanged)
    if (req.url && Object.prototype.hasOwnProperty.call(VENDOR_PATH_RESPONSES, req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(VENDOR_PATH_RESPONSES[req.url]));
      return;
    }
```

- [ ] **Step 5: 통과 확인 (신규 + 기존 mock/advisor 테스트 무회귀)**

Run: `pnpm exec vitest run tests/mock-vendor-paths.test.ts tests/mock-openstack.test.ts tests/mcp-advanced-integration.test.ts tests/mcp-fortios-advisor.test.ts tests/mcp-cisco-advisor.test.ts`
Expected: PASS 전부

- [ ] **Step 6: Commit**

```bash
git add apps/mock-sangfor-console/src/vendor-paths.ts apps/mock-sangfor-console/src/server.ts tests/mock-vendor-paths.test.ts
git commit -m "feat(mock): serve vendor-native advisor paths for live sweep

Advisors query real FortiOS /api/v2 and Cisco RESTCONF paths and return an
error result if ANY endpoint is non-2xx, so the mock now serves all 14 paths
with mapper-canonical shapes. Existing /api/v1 and /openstack routes unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 11: 통합 테스트 — 전체 승인 체인 + 시드 검증 (T-INT-1 · T-INT-2)

**Files:**
- Test: `tests/control-tower-e2e.test.ts` (신규 — 프로덕션 코드 변경 없음)

**Interfaces:**
- Consumes: 실제 `authorizeToolCall`(Task 3), 실제 `createApi`(Task 7·8), 실제 `mintBridgeApproval`(Task 6 — api 내부에서), `SEED_VENDORS`(Task 4), mcp-server `listTools`(동결 모듈, `MCP_NO_SERVE=1` import)

**목적:** T-API는 stub bridge가 승인을 검증하지 않았다. T-INT-1은 **실제 bridge guard 로직을 in-process로 조립**해 타워 민팅 → guard 검증 → nonce 소비 → 실행 → 이력의 전체 체인과, 같은 승인의 재사용 불가(R1)를 증명한다. T-INT-2는 vendors.json 시드가 실제 MCP 도구 목록과 일치하는지(존재·read-only·credentialFields⊆스키마) 고정한다.

- [ ] **Step 1: 테스트 작성**

`tests/control-tower-e2e.test.ts` 신규 생성:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

import { authorizeToolCall } from '../apps/http-bridge/src/tool-guard.js';
import { createApi } from '../apps/control-tower/src/api.js';
import { SEED_VENDORS } from '../apps/control-tower/src/registry.js';

const SECRET = 'itest-secret';

// ─── T-INT-1: 실제 guard를 태운 in-process bridge ──────────────────────────
const TOOL_LIST = {
  tools: [
    { name: 'itest.read', description: 'stub', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'itest read', readOnlyHint: true, destructiveHint: false }, category: 'admin' },
    { name: 'itest.write', description: 'stub', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'itest write', readOnlyHint: false, destructiveHint: false }, category: 'admin' },
  ],
};

describe('T-INT-1 — 타워 민팅 → 실제 bridge guard → 실행 → 이력 전체 체인', () => {
  let bridgeServer: http.Server;
  let bridgeUrl: string;
  let dir: string;
  let lastCallBody: { name: string; arguments: Record<string, unknown>; approval?: Record<string, unknown> } | null = null;
  const OLD_ENV = { ...process.env };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tower-e2e-'));
    process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;

    // 실제 authorizeToolCall(승인 분기 포함)을 쓰는 미니 bridge — 실행부만 stub.
    bridgeServer = http.createServer(async (req, res) => {
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
      if (req.method === 'GET' && req.url === '/tools') return respond(200, TOOL_LIST);
      if (req.method === 'POST' && req.url === '/tools/call') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        lastCallBody = body;
        const decision = authorizeToolCall({
          name: body.name,
          toolListResult: TOOL_LIST,
          enforceWhitelist: true,
          approval: body.approval,
          approvalSecret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
        });
        if (!decision.allow) return respond(decision.status ?? 403, { error: decision.error });
        const payload = { echo: body.name, args: body.arguments };
        return respond(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
      }
      respond(404, { error: 'not found' });
    });
    await new Promise<void>((r) => bridgeServer.listen(0, '127.0.0.1', r));
    bridgeUrl = `http://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => bridgeServer.close(() => r()));
    process.env = { ...OLD_ENV };
    rmSync(dir, { recursive: true, force: true });
  });

  it('읽기 실행 → 이력 / 쓰기 pending → 승인 → guard 통과 → succeeded / 같은 승인 재사용 → 403', async () => {
    const api = createApi({
      bridgeUrl,
      runsDir: join(dir, 'runs'),
      registryDir: join(dir, 'registry'),
      approvalSecret: SECRET,
      mockConsoleUrl: 'http://127.0.0.1:1',
    });

    // ① 읽기전용: guard의 read-only 허용 경로로 즉시 실행
    const read = await api.createRun({ toolId: 'itest.read', args: {} });
    expect(read.status).toBe('succeeded');

    // ② 쓰기: 승인 없이 guard에 직접 던지면 403 (whitelist enforced)
    const direct = await fetch(`${bridgeUrl}/tools/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'itest.write', arguments: {} }),
    });
    expect(direct.status).toBe(403);

    // ③ 타워 경유: pending → 승인 → 민팅된 approval이 실제 guard를 통과
    const pending = await api.createRun({ toolId: 'itest.write', args: { customer: 'acme', password: 'hunter2' } });
    expect(pending.status).toBe('pending_approval');
    const final = await api.approveRun(pending.runId, { approvedBy: 'jmpark' });
    expect(final.status).toBe('succeeded');
    expect(final.approval?.approvedBy).toBe('jmpark');
    expect(JSON.stringify(final)).not.toMatch(/approvalToken/); // 이력에 토큰 무저장
    expect(lastCallBody!.arguments.password).toBe('hunter2');   // 원본 args 실행
    expect(lastCallBody!.approval).toBeDefined();

    // ④ R1: 같은 승인(같은 nonce)을 bridge에 직접 재사용 → 403 already used
    const replay = await fetch(`${bridgeUrl}/tools/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'itest.write', arguments: {}, approval: lastCallBody!.approval }),
    });
    expect(replay.status).toBe(403);
    expect(String(((await replay.json()) as { error: string }).error)).toMatch(/already used/);

    // ⑤ 이력에 전체 체인 기록 (읽기 1 + 쓰기 1)
    const runs = api.listRuns({});
    expect(runs.filter((r) => r.status === 'succeeded')).toHaveLength(2);

    // ⑥ 거부 플로우
    const pending2 = await api.createRun({ toolId: 'itest.write', args: {} });
    const rejected = api.rejectRun(pending2.runId, { reason: 'not now' });
    expect(rejected.status).toBe('rejected');
  });
});

// ─── T-INT-2: vendors.json 시드 ↔ 실제 MCP 도구 대조 ────────────────────────
describe('T-INT-2 — 시드 advisorTools가 실제 MCP에 존재하고 전부 read-only', () => {
  let byName: Map<string, { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; inputSchema: { properties?: Record<string, unknown> } }>;

  beforeAll(async () => {
    const mod = await import('../apps/mcp-server/src/index.js');
    const listTools = (mod as { listTools: () => Array<never> }).listTools;
    byName = new Map((listTools() as Array<{ name: string }>).map((t) => [t.name, t as never]));
  });

  it('모든 시드 advisorTool이 존재하고 readOnly:true / destructive:false', () => {
    for (const vendor of SEED_VENDORS) {
      for (const toolName of vendor.advisorTools) {
        const tool = byName.get(toolName);
        expect(tool, `${vendor.product}: ${toolName} 미존재`).toBeTruthy();
        expect(tool!.annotations.readOnlyHint, `${toolName} readOnlyHint`).toBe(true);
        expect(tool!.annotations.destructiveHint, `${toolName} destructiveHint`).toBe(false);
      }
    }
  });

  it('모든 credentialField가 해당 벤더 모든 advisorTool의 inputSchema 속성에 존재 (시드 오타 방지)', () => {
    for (const vendor of SEED_VENDORS) {
      for (const toolName of vendor.advisorTools) {
        const properties = Object.keys(byName.get(toolName)!.inputSchema.properties ?? {});
        for (const field of vendor.credentialFields) {
          expect(properties, `${vendor.product}/${toolName}: credentialField '${field}'가 스키마에 없음`).toContain(field);
        }
      }
    }
  });
});
```

**주의 — HCI credentialFields와 `host` 인자:** `mergeDeviceArgs`는 항상 `host`를 주입하지만 `hci_health_report` 스키마에는 `host` 속성이 없다. MCP 핸들러는 여분 인자를 무시하므로(스키마 강제 검증 없음) 무해하다. 반대로 credentialFields의 `host`는 FortiOS/Cisco 벤더에만 있으므로 위 테스트는 통과한다.

- [ ] **Step 2: 실행 확인 (프로덕션 코드는 이미 완성 — 이 태스크는 검증 자체가 산출물)**

Run: `pnpm exec vitest run tests/control-tower-e2e.test.ts`
Expected: PASS (3 tests). 실패 시 그 자체가 회귀 신호다 — 원인을 고치기 전에는 진행 금지. 특히 credentialFields 대조 실패는 시드 오타(스펙 교정 1 미적용)를 의미한다.

- [ ] **Step 3: Commit**

```bash
git add tests/control-tower-e2e.test.ts
git commit -m "test(integration): control tower end-to-end approval chain + seed validation (T-INT)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: 최종 검증 + 수용 기준 (스펙 §12)

**Files:**
- 신규 코드 없음. `data/registry/vendors.json` 시드 생성본 커밋. 발견된 결함만 수정.

- [ ] **Step 1: 전체 테스트/타입/빌드**

```bash
npm test        # 기존 310+ 전부 + 신규 8파일 전부 PASS (0 fail — skip 기존 2건은 허용)
npm run lint    # 에러 0
npm run build   # 에러 0
```

하나라도 실패하면: superpowers:systematic-debugging으로 원인 규명 → 수정 → 재실행. 기존 테스트를 고치는 방향의 수정은 금지(Global Constraints 위반 신호).

- [ ] **Step 2: vendors.json 시드 생성·커밋**

```bash
pnpm exec tsx -e "import('./apps/control-tower/src/registry.js').then(m => console.log(new m.Registry().vendors().length))"
# → 3 출력 + data/registry/vendors.json 생성됨
git add data/registry/vendors.json
git commit -m "chore(control-tower): commit vendor descriptor seed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: 수용 기준 수동 체크 (스펙 §12 — 3프로세스 기동 상태에서)**

기동: `pnpm dev:mock-console` + `pnpm dev:http-bridge` + `SANGFOR_OPERATOR_APPROVAL_SECRET=dev-secret pnpm dev:control-tower` (bridge에도 같은 시크릿 env 필요 — 한 셸에서 export 후 두 프로세스 기동).
쓰기 승인 체인 확인용으로 bridge는 `WHELP99_ENFORCE_SAFE_TOOLS` 기본값(true) 그대로 둔다 — 승인 경로가 whitelist를 통과시키는 것이 확인 대상이다.

브라우저 `http://127.0.0.1:3700`에서:

1. [ ] 대시보드 4위젯 렌더 (장비·자문 요약 / 최근 실행 / 승인 대기 / 건강도)
2. [ ] 장비 관리 → mock FortiOS 장비 등록 (product `FORTIOS`, host `http://127.0.0.1:3400`) → [전체 일괄 자문 실행] → 이력 화면에 sweepId 필터로 2 run(succeded) → 대시보드 장비 요약에 pass/fail 뱃지
3. [ ] 도구 실행 → advisory 카테고리 → `sangfor.advisor_fortios_advanced` 폼 (host에 `http://127.0.0.1:3400`, username/password `mock`) → 즉시 결과 인라인 + 이력 기록
4. [ ] 쓰기 도구 `sangfor.pm_create_engagement` (customer/product 입력) 실행 → "승인 대기로 이동" → 대시보드 승인 큐 → [승인](approvedBy 입력) → 실행 성공 → 이력 상세에 approval 메타(approvedBy/changeTicketId) 기록, approvalToken/nonce 없음
5. [ ] 같은 run 재승인 시도 → 409 오류 알림 (신규 실행은 새 run + 새 승인)
6. [ ] 다른 쓰기 run 생성 후 [거부] → rejected + 사유 기록
7. [ ] 타워 프로세스만 재시작 → 이력·장비·pending 큐 유지 (파일 영속) → 재시작 전 pending의 [승인] → "원본 인자 소실" 400 확인
8. [ ] `curl -s -X POST http://127.0.0.1:3600/tools/call -H 'content-type: application/json' -d '{"name":"sangfor.pm_create_engagement","arguments":{"customer":"x","product":"HCI"}}'` → 403 (approval 미첨부 bridge 기본 동작 불변)

- [ ] **Step 4: 이슈 발견 시 수정 커밋, 클린이면 종료 보고**

체크 실패 항목은 개별 수정 커밋(`fix(control-tower): ...`) 후 해당 체크부터 재검증. 전부 통과하면 superpowers:finishing-a-development-branch로 마무리 옵션(머지/PR) 제시.

---

## 스펙 커버리지 매핑 (Self-Review 결과)

| 스펙 § | 요구 | 태스크 |
|---|---|---|
| §2 범위 1 실행이력 저장소 | `@sangfor/runs` | Task 1, 2 |
| §2 범위 2 승인 통과 경로 | tool-guard + server.ts | Task 3 |
| §2 범위 3 컨트롤타워 앱 | apps/control-tower | Task 4~9 |
| §2 범위 4 벤더/장비 레지스트리 | registry + 시드 | Task 4, 12(커밋) |
| §2 범위 5 일괄 자문 sweep | POST /api/sweep | Task 8 |
| §2 범위 6 테스트 | 신규 8 테스트 파일 + 무회귀 | 전 태스크, Task 12 |
| §4.6 마스킹 계약 복제·동기화 고정 | mask.ts + 패리티 테스트 | Task 1 |
| §5.1 RunRecord/RunStore/JSONL 규칙 | 전문 구현 | Task 2 |
| §5.2 guard 확장·회귀 보증 | 신규 판정 로직 + T-BR-1/2 | Task 3 (nonce 순서는 교정 2) |
| §5.3 파일 구조·env·BridgeClient·API 라우트 표·HealthReport·UI 4화면 | | Task 5(클라이언트), 7·8(라우트 전부), 9(UI·env) |
| §5.4 디스크립터·병합 규칙·개방성 | registry + T-REG-3 | Task 4 (HCI 필드명은 교정 1) |
| §6.1 읽기 즉시 실행 + resultSummary 규칙 | createRun + summarize | Task 7 |
| §6.2 승인 플로우·원본 args 맵·이중 게이트 | approveRun | Task 7 (HCI 이중 게이트는 §6.4 민팅 UI로 지원, hciWriteGate 무수정) |
| §6.3 sweep 규칙 (동시성 3·read-only 강제) | sweep | Task 8 |
| §6.4 tool-args 민팅 헬퍼 | mint API + UI 버튼 | Task 6, 8, 9 |
| §7 보안 불변식 6종 | Global Constraints + T-BR/T-INT | Task 3, 7, 11 |
| §8 에러 처리 표 8행 | failed 기록/부분 실패 값 표현/409/400/파싱 skip/500KB | Task 2(skip·truncate), 5(bridge 다운), 7(403→failed·409·400), 8(health 부분 실패) |
| §9 테스트 전략 표 10행 | T-RUN-1·2 / T-BR-1·2 / T-REG-1·2·3 / T-API-1·2 / T-INT-1·2 | Task 2/3/4/7·8/11 |
| §10 환경변수 5종 + .gitignore | .env.example·.gitignore | Task 4, 9 |
| §11 기존 시스템 영향 (mock alias 포함) | vendor-paths 추가만 | Task 10 |
| §12 수용 기준 4항 | 최종 검증 체크리스트 | Task 12 |

**스펙 이탈(의도적, 근거 명시):** ① HCI 시드 `identityUrl`→`identityBaseUrl` (실스키마 대조, T-INT-2 고정) ② guard 승인 분기의 nonce 소비를 마지막으로 이동 (거부가 nonce를 태우지 않게 — T-BR-2 고정) ③ mock 폴백 'mock'은 스키마 required 필드에만 적용 (registry가 아니라 api 계층에서 — HCI 기본값 보존) ④ mock alias는 기존 핸들러 재사용 대신 canonical 정적 응답 맵 (기존 핸들러 응답이 매퍼 요구와 부분 불일치 — 기존 라우트 무변경 원칙과도 정합).
