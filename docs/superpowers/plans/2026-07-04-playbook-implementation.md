# 플레이북 구현 플랜 (Playbook Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Control Tower v1 위에, MCP 도구를 블록으로 배치·연결한 **플레이북**을 조립(AI)·검증(사람)·실행(순차/일시정지/재개)·분석(AI 개선/제안 루프)하는 협업 시스템을 기존 전체 무회귀로 얹는다.

**Architecture:** 플레이북 정의/리비전/분석/에이전트큐는 신규 `playbook-store.ts`의 4개 스토어(registry 패턴 3 + append-only JSONL 1)에 저장한다. "플레이북 실행"은 별도 상태 레코드를 만들지 않고(접근법 B), 블록 run들의 태그(`playbookRunId`/`playbookRev`/`blockId`)와 리비전의 블록 목록에서 **매번 유도**한다. 실행 루프는 v1 `createApi` 클로저 안에 sweep과 같은 방식으로 구현하고, `playbook-engine.ts`는 부수효과 없는 **순수함수 3개**(`resolveTemplates`/`derivePlaybookRunStatus`/`renderReport`)만 export한다. write 블록 승인은 v1 run 승인 게이트(민팅→bridge tool-guard)를 **그대로 재사용**한다.

**Tech Stack:** TypeScript(NodeNext ESM), raw `node:http`, vanilla JS 단일 HTML UI, vitest, pnpm workspace. 신규 런타임 의존성 없음.

**스펙:** `docs/superpowers/specs/2026-07-04-playbook-design.md` (사용자 승인본). 이 플랜의 §숫자 인용은 그 문서 기준. v1 스펙/플랜: `docs/superpowers/specs/2026-07-03-control-tower-design.md`, `docs/superpowers/plans/2026-07-03-control-tower-implementation.md`.

## Global Constraints (모든 태스크에 암묵 포함 — 위반 시 구현 중단하고 보고)

- **v1 무회귀 (최상위 제약):** 단일 도구 실행·승인·sweep·이력·장비 CRUD 동작은 바이트 단위 동일해야 한다. 기존 385 pass / 2 skip 테스트를 **하나도 수정하지 않고** 통과해야 한다. 특히 v1의 "원본 인자 소실 → 400" 규칙은 **playbookRunId 없는 run에 그대로 유지**된다 (Task 7이 이를 고정).
- **동결(FROZEN):** `apps/mcp-server/**`, `packages/sangfor-operator/**`, `apps/http-bridge/**` 수정 금지. R1(nonce 단일사용)·R3(원격 write 정책) 봉인 유지. 플레이북은 bridge를 REST 클라이언트로만 사용한다.
- **승인 체계 무발명:** write 블록 승인은 v1 `approveRun`의 action-bound 단일사용 nonce 경로를 재사용한다. 새 승인 토큰·nonce·게이트를 만들지 않는다.
- **비밀값 무저장 (§7.5):** 모든 신규 저장물(플레이북 블록 args, 분석 아티팩트, 에이전트 task payload/result)은 **저장 직전 `maskSecrets`**. 따라서 자격증명은 블록 args 리터럴이 아니라 **deviceId → 장비 레지스트리 `credentialEnv`** 경로로만 주입된다(마스킹된 `'***'`가 장비로 나가는 사고 방지).
- **정보 격리 (§7.3):** 템플릿은 자기 `playbookRun` 내부 블록 결과만 참조한다. 다른 실행·다른 플레이북의 run을 참조할 수 없다.
- **템플릿 결정성 (§7.4):** 템플릿 해석은 항상 RunStore에 영속된 `resultJson`(마스킹·500KB 캡 적용본) 기준 → 재시작 전후 동일. 마스킹본이므로 상류 비밀값을 하류로 파이프할 수 없다(의도된 fail-closed).
- **토큰 게이트 (§7.6):** 모든 신규 라우트는 기존 `/api/*` checkAuth 게이트 뒤. 에이전트도 같은 Bearer 토큰 사용.
- **모듈 규칙(NodeNext):** 상대 import는 `.js` 확장자 필수. 앱은 패키지를 상대경로 deep import(`'../../../packages/...'`), 패키지는 패키지명(`'@sangfor/shared'`, `'@sangfor/runs'`). `@sangfor/operator`의 index는 approval.ts를 재수출하지 않으므로 `SignedApproval` 등은 deep import(`'../../../packages/sangfor-operator/src/approval.js'`).
- **테스트:** 루트 `tests/**/*.test.ts` (vitest, co-located 금지). 단일 파일: `pnpm exec vitest run tests/<파일>.test.ts` · 전체: `npm test` · 타입체크: `npm run lint`.
- **데이터 루트:** 반드시 `resolveRepoData('<subdir>', '<ENV_VAR>')` 앵커 (cwd 무관). 신규 env 없음 — `SANGFOR_REGISTRY_ROOT`(playbooks/agent-tasks), `SANGFOR_RUNS_ROOT`(analyses) 재사용.
- **UI 레이블은 한국어**, 코드/식별자/커밋 메시지는 영어. 커밋은 conventional commit, 본문 마지막에 빈 줄 후 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **UI 클라이언트 JS 제약:** `ui.ts`는 서버측 템플릿 리터럴 하나로 HTML을 만든다. 클라이언트 JS 안에서 backtick과 `${`를 쓰면 서버 리터럴이 깨지므로 **문자열 연결(+)만 사용**한다.

## 파일 구조 (전체 생성/수정 대상)

```
packages/sangfor-runs/src/run-store.ts     [수정] RunRecord 옵셔널 4필드 + ListRunsOptions.playbookRunId + createRun 입력 (Task 1)
apps/control-tower/src/playbook-store.ts    [신규] 타입 전체 + PlaybookStore/AnalysisStore/AgentTaskStore + PlaybookValidationError (Task 2, 3)
apps/control-tower/src/playbook-engine.ts   [신규] 순수함수 3개: resolveTemplates/derivePlaybookRunStatus/renderReport + TemplateError (Task 4)
apps/control-tower/src/api.ts               [수정] 스토어 3개 인스턴스화 + 엔진 실행 루프 + 위임 메서드 + approveRun 접점 2곳 (Task 5, 6, 7)
apps/control-tower/src/server.ts            [수정] §5.4 라우트 추가 (Task 6)
apps/control-tower/src/ui.ts                [수정] 플레이북 패널 (Task 8)
.gitignore                                  [수정] outputs/playbooks/ (Task 9)
tests/control-tower-playbook-store.test.ts  [신규] T-PB-1·2 (Task 2, 3)
tests/control-tower-playbook-engine.test.ts [신규] T-PB-3·4 (Task 4, 5)
tests/control-tower-playbook-api.test.ts    [신규] T-PB-5·6 (Task 6, 7)
tests/control-tower-e2e.test.ts             [수정] T-PB-7 추가 (Task 9)
tests/sangfor-runs-store.test.ts            [수정] RunRecord 태그 왕복 1케이스 (Task 1)
```

**태스크 의존성:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. (2·3은 같은 파일, 4는 1에만 의존, 5는 1·2·4, 6은 5, 7은 5·6, 8은 6, 9는 전부.)

**스펙 이탈(의도적, 근거 명시 — 구현 시 이 플랜이 우선):**
1. **`TowerOptions.playbookOutputDir` 추가.** 리포트 산출물 경로(`outputs/playbooks/`)를 테스트가 temp dir로 주입할 수 있게 옵션 1개 추가. env가 아니므로 "신규 env 없음"(§10) 위반 아님. 기본값 `resolveRepoData('outputs/playbooks')`.
2. **reject는 리포트를 실행하지 않는다 → 유도 상태 `failed`.** 스펙 §6.2("failed/rejected면 report 블록만 실행")와 §8("write 거부 → 재개 없음 → failed")이 상충한다. §8과 §5.3("api.ts 수정은 approveRun 접점 2곳")을 우선한다: `rejectRun`은 무수정, 리포트 미실행. **read/tool 블록 실패(동기, 엔진 pass 내부)만** stop-on-failure로 리포트를 실행해 `partial`을 만든다. 근거: 새 접점을 만들지 않는다는 불변식 유지 + reject는 사용자 능동 종료라 부분 리포트 기대가 약함.
3. **approveRun continueRun 접점은 write 결과가 succeeded/failed 무관하게 호출한다.** 실패한 write도 `continuePlaybookRun`에 들어가되, 엔진이 `failed`를 재유도해 이후 tool 블록은 건너뛰고 리포트만 실행한다(→ partial/failed). 스펙 §5.3의 "방금 승인된 write가 failed면 재개하지 않는다"를 "tool 블록은 재개하지 않는다"로 해석 — 리포트 부분 집계는 §6.2 취지를 살린다.

---

### Task 1: RunRecord 플레이북 태그 확장 (@sangfor/runs)

**Files:**
- Modify: `packages/sangfor-runs/src/run-store.ts` (RunRecord 인터페이스, ListRunsOptions, createRun 입력·본문, listRuns 필터)
- Test: `tests/sangfor-runs-store.test.ts` (태그 왕복 1케이스 추가 — 기존 케이스는 무수정)

**Interfaces:**
- Consumes: 없음 (기존 RunStore 확장)
- Produces: `RunRecord`에 옵셔널 `playbookId?/playbookRunId?/playbookRev?/blockId?`; `ListRunsOptions.playbookRunId?`; `createRun` 입력에 동일 4필드. Task 5 엔진이 이 태그로 블록 run을 생성/조회한다.

- [ ] **Step 1: 실패하는 테스트 추가** (`tests/sangfor-runs-store.test.ts`의 `RunStore — 라이프사이클/영속/필터` describe 블록 안, 마지막 `it` 뒤에 추가)

```ts
  it('playbook 태그 왕복: 저장·조회·playbookRunId 필터 (하위호환)', () => {
    const store = new RunStore(dir);
    const a = store.createRun({
      toolId: 't1', toolSafety: 'read_only', args: {},
      initialStatus: 'running', playbookId: 'pb_1', playbookRunId: 'pbrun_1', playbookRev: 2, blockId: 'b1',
    });
    store.createRun({ toolId: 't2', toolSafety: 'read_only', args: {}, initialStatus: 'running' }); // 태그 없는 run
    const fetched = store.getRun(a.runId)!;
    expect(fetched.playbookId).toBe('pb_1');
    expect(fetched.playbookRunId).toBe('pbrun_1');
    expect(fetched.playbookRev).toBe(2);
    expect(fetched.blockId).toBe('b1');
    // playbookRunId 필터: 태그된 run만
    const filtered = store.listRuns({ playbookRunId: 'pbrun_1' });
    expect(filtered.map((r) => r.runId)).toEqual([a.runId]);
    // 태그 미지정 run에는 필드가 붙지 않는다 (JSON 최소화)
    const plain = store.listRuns({ toolId: 't2' })[0];
    expect('playbookRunId' in plain).toBe(false);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/sangfor-runs-store.test.ts -t "playbook 태그 왕복"`
Expected: FAIL — `createRun`이 `playbookId` 등을 모르고, `ListRunsOptions`에 `playbookRunId`가 없어 타입/런타임 불일치.

- [ ] **Step 3: RunRecord·ListRunsOptions 확장** (`run-store.ts`)

`RunRecord` 인터페이스의 `rejectedReason?: string;` 다음 줄에 추가:

```ts
  rejectedReason?: string;
  playbookId?: string;
  playbookRunId?: string;      // nowId('pbrun') — 한 플레이북 "실행"의 모든 블록 run이 공유
  playbookRev?: number;        // 실행에 사용된 리비전 (유도 상태 계산 기준)
  blockId?: string;            // 리비전 내 블록 id
```

`ListRunsOptions`의 `sweepId?: string;` 다음 줄에 추가:

```ts
  sweepId?: string;
  playbookRunId?: string;
```

- [ ] **Step 4: createRun 입력·본문 확장** (`run-store.ts`)

`createRun` 입력 타입을 확장 (`sweepId?: string;` 다음 줄):

```ts
    sweepId?: string;
    playbookId?: string;
    playbookRunId?: string;
    playbookRev?: number;
    blockId?: string;
```

`createRun` 본문에서 `if (input.sweepId) record.sweepId = input.sweepId;` 다음에 추가 (undefined 필드는 붙이지 않아 태그 없는 run의 JSON을 최소로 유지):

```ts
    if (input.sweepId) record.sweepId = input.sweepId;
    if (input.playbookId) record.playbookId = input.playbookId;
    if (input.playbookRunId) record.playbookRunId = input.playbookRunId;
    if (input.playbookRev !== undefined) record.playbookRev = input.playbookRev;
    if (input.blockId) record.blockId = input.blockId;
```

- [ ] **Step 5: listRuns 필터 확장** (`run-store.ts`)

`listRuns`의 `filtered` 계산에서 `(!opts.sweepId || r.sweepId === opts.sweepId)` 뒤에 조건 추가:

```ts
    const filtered = records.filter((r) =>
      (!opts.status || r.status === opts.status) &&
      (!opts.toolId || r.toolId === opts.toolId) &&
      (!opts.deviceId || r.deviceId === opts.deviceId) &&
      (!opts.sweepId || r.sweepId === opts.sweepId) &&
      (!opts.playbookRunId || r.playbookRunId === opts.playbookRunId));
```

- [ ] **Step 6: 통과 확인 + 무회귀**

Run: `pnpm exec vitest run tests/sangfor-runs-store.test.ts`
Expected: PASS (신규 + 기존 전부). 이어서 `npm run lint` → 에러 0.

- [ ] **Step 7: 커밋**

```bash
git add packages/sangfor-runs/src/run-store.ts tests/sangfor-runs-store.test.ts
git commit -m "feat(runs): playbook block tags on RunRecord (backward-compatible)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: PlaybookStore — 타입·검증·리비전 상태기계 (T-PB-1)

**Files:**
- Create: `apps/control-tower/src/playbook-store.ts` (이 태스크에서 파일 시작 — 타입 전체 + `PlaybookValidationError` + `PlaybookStore`. `AnalysisStore`/`AgentTaskStore`는 Task 3에서 같은 파일에 추가)
- Test: `tests/control-tower-playbook-store.test.ts` (PlaybookStore 부분 — Task 3에서 같은 파일에 스토어 2개 테스트 추가)

**Interfaces:**
- Consumes: `@sangfor/runs`의 `maskSecrets`, `@sangfor/shared`의 `nowId`/`resolveRepoData`.
- Produces: 타입 `PlaybookBlock`/`PlaybookRevision`/`Playbook`/`AnalysisVerdict`/`AnalysisImprovement`/`AnalysisProposal`/`PlaybookAnalysis`/`AgentTaskKind`/`AgentTask`. 클래스 `PlaybookStore`, 에러 `PlaybookValidationError(message, status=400)`. Task 4·5·6이 타입을, Task 5·6이 `PlaybookStore`를 사용.

- [ ] **Step 1: 실패하는 테스트 작성** (`tests/control-tower-playbook-store.test.ts` 신규)

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlaybookStore, PlaybookValidationError, type PlaybookBlock } from '../apps/control-tower/src/playbook-store.js';

const READ2: PlaybookBlock[] = [
  { id: 'b1', type: 'tool', toolId: 'sangfor.advisor_fortios_advanced', deviceId: 'dev_1' },
  { id: 'r1', type: 'report', title: '종합 리포트' },
];

describe('PlaybookStore — CRUD·검증·상태기계 (T-PB-1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pb-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('create → rev 1 draft, get/list 왕복, 재로드 생존', () => {
    const store = new PlaybookStore(dir);
    const pb = store.create({ name: '자문 루프', goal: '전체분석→보고서', blocks: READ2, authoredBy: 'agent:claude', note: '조립근거' });
    expect(pb.id).toMatch(/^pb_/);
    expect(pb.revisions).toHaveLength(1);
    expect(pb.revisions[0]).toMatchObject({ rev: 1, status: 'draft', authoredBy: 'agent:claude', note: '조립근거' });
    expect(store.get(pb.id)!.name).toBe('자문 루프');
    expect(new PlaybookStore(dir).get(pb.id)).toBeDefined(); // atomic write 후 재로드
    expect(store.activeRevision(pb)).toBeUndefined(); // 아직 승인본 없음
  });

  it('블록 검증 fail-closed: 빈 blocks / 중복 id / tool에 toolId 없음 / report에 args / report 2개', () => {
    const store = new PlaybookStore(dir);
    const base = { name: 'x', goal: 'g', authoredBy: 'a' };
    expect(() => store.create({ ...base, blocks: [] })).toThrow(PlaybookValidationError);
    expect(() => store.create({ ...base, blocks: [{ id: 'b1', type: 'tool', toolId: 't' }, { id: 'b1', type: 'tool', toolId: 't' }] })).toThrow(/중복/);
    expect(() => store.create({ ...base, blocks: [{ id: 'b1', type: 'tool' }] })).toThrow(/toolId/);
    expect(() => store.create({ ...base, blocks: [{ id: 'b1', type: 'report', args: { x: 1 } }] })).toThrow(/report/);
    expect(() => store.create({ ...base, blocks: [{ id: 'r1', type: 'report' }, { id: 'r2', type: 'report' }] })).toThrow(/report 블록은 최대 1개/);
  });

  it('저장 전 maskSecrets: 블록 args의 비밀 키는 *** (§7.5)', () => {
    const store = new PlaybookStore(dir);
    const pb = store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: [
      { id: 'b1', type: 'tool', toolId: 't', args: { host: 'h', password: 'hunter2', nested: { token: 'x' } } },
    ] });
    const args = pb.revisions[0].blocks[0].args as Record<string, unknown>;
    expect(args.password).toBe('***');
    expect((args.nested as Record<string, unknown>).token).toBe('***');
    expect(args.host).toBe('h'); // 비밀 아닌 키는 보존 → 템플릿도 보존
  });

  it('addRevision → rev N+1 draft, 상태기계: 승인/반려', () => {
    const store = new PlaybookStore(dir);
    const pb = store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: READ2 });
    const r2 = store.addRevision(pb.id, { blocks: READ2, authoredBy: 'agent:claude', note: '피드백 반영' });
    expect(r2.revisions).toHaveLength(2);
    expect(r2.revisions[1].rev).toBe(2);
    // 반려는 사유 필수
    expect(() => store.reviewRevision(pb.id, 2, { approve: false, reviewedBy: 'jmpark' })).toThrow(/사유/);
    const rejected = store.reviewRevision(pb.id, 2, { approve: false, reviewedBy: 'jmpark', rejectReason: 'HA 누락' });
    expect(rejected.revisions[1].status).toBe('rejected');
    expect(rejected.revisions[1].rejectReason).toBe('HA 누락');
    // rev 1 승인 → activeRevision
    const approved = store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'jmpark' });
    expect(store.activeRevision(approved)!.rev).toBe(1);
    // draft 아닌 리비전 재심사 → 409
    expect(() => store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'x' }))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  it('activeRevision = approved 중 최대 rev', () => {
    const store = new PlaybookStore(dir);
    const pb = store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: READ2 });
    store.addRevision(pb.id, { blocks: READ2, authoredBy: 'a' });
    store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'j' });
    const p2 = store.reviewRevision(pb.id, 2, { approve: true, reviewedBy: 'j' });
    expect(store.activeRevision(p2)!.rev).toBe(2);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-store.test.ts`
Expected: FAIL — `playbook-store.ts` 미존재.

- [ ] **Step 3: 타입 + PlaybookValidationError + PlaybookStore 구현** (`apps/control-tower/src/playbook-store.ts` 신규)

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowId, resolveRepoData } from '../../../packages/shared/src/index.js';
import { maskSecrets } from '../../../packages/sangfor-runs/src/index.js';

// ── 플레이북 정의 ────────────────────────────────────────────────────────────
export interface PlaybookBlock {
  id: string;                  // 리비전 내 유일, 템플릿 참조 앵커
  type: 'tool' | 'report';
  title?: string;
  toolId?: string;             // type==='tool' 필수
  args?: Record<string, unknown>;  // 값에 템플릿 문자열 허용 (Task 4)
  deviceId?: string;           // 지정 시 v1 인자 병합 규칙 재사용
}

export interface PlaybookRevision {
  rev: number;
  blocks: PlaybookBlock[];
  authoredBy: string;
  note?: string;
  status: 'draft' | 'approved' | 'rejected';
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectReason?: string;
}

export interface Playbook {
  id: string;
  name: string;
  goal: string;
  revisions: PlaybookRevision[];  // rev 오름차순
  createdAt: string;
  updatedAt: string;
}

// ── AI 분석 아티팩트 ─────────────────────────────────────────────────────────
export type AnalysisVerdict = 'accepted' | 'dismissed';

export interface AnalysisImprovement {
  observation: string;
  evidenceRunId?: string;
  recommendation: string;
  verdict?: AnalysisVerdict;
  reviewedBy?: string;
}

export interface AnalysisProposal {
  action: string;
  rationale: string;
  linkedPlaybookId?: string;
  verdict?: AnalysisVerdict;
  reviewedBy?: string;
}

export interface PlaybookAnalysis {
  schemaVersion: 1;
  id: string;
  playbookId: string;
  playbookRunId: string;
  summary: string;
  improvements: AnalysisImprovement[];
  proposals: AnalysisProposal[];
  authoredBy: string;
  createdAt: string;
}

// ── 에이전트 작업 큐 ─────────────────────────────────────────────────────────
export type AgentTaskKind = 'assemble' | 'revise' | 'analyze';

export interface AgentTask {
  id: string;
  kind: AgentTaskKind;
  payload: { goal?: string; playbookId?: string; playbookRunId?: string; feedback?: string };
  status: 'open' | 'done' | 'cancelled';
  result?: { playbookId?: string; rev?: number; analysisId?: string; note?: string };
  createdAt: string;
  closedAt?: string;
}

// status를 실어 api 계층이 400/404/409로 매핑 (RegistryValidationError는 항상 400이었지만
// 플레이북은 상태기계 위반=409, 미존재=404를 구분해야 한다).
export class PlaybookValidationError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

// create/addRevision 시 fail-closed 검증.
export function validateBlocks(blocks: PlaybookBlock[]): void {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new PlaybookValidationError('blocks는 비어있을 수 없습니다');
  }
  const seen = new Set<string>();
  let reportCount = 0;
  for (const b of blocks) {
    if (!b.id?.trim()) throw new PlaybookValidationError('block.id는 필수입니다');
    if (seen.has(b.id)) throw new PlaybookValidationError(`중복 block.id: ${b.id}`);
    seen.add(b.id);
    if (b.type === 'tool') {
      if (!b.toolId?.trim()) throw new PlaybookValidationError(`tool 블록 '${b.id}'에 toolId가 없습니다`);
    } else if (b.type === 'report') {
      if (b.toolId !== undefined || b.args !== undefined) {
        throw new PlaybookValidationError(`report 블록 '${b.id}'에는 toolId/args를 둘 수 없습니다`);
      }
      reportCount += 1;
    } else {
      throw new PlaybookValidationError(`알 수 없는 block.type: ${String((b as PlaybookBlock).type)}`);
    }
  }
  if (reportCount > 1) throw new PlaybookValidationError('report 블록은 최대 1개입니다');
}

function maskBlocks(blocks: PlaybookBlock[]): PlaybookBlock[] {
  return blocks.map((b) => (b.args ? { ...b, args: maskSecrets(b.args) } : b));
}

export class PlaybookStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
    this.path = join(this.dir, 'playbooks.json');
  }

  list(): Playbook[] { return this.load(); }
  get(id: string): Playbook | undefined { return this.load().find((p) => p.id === id); }

  create(input: { name: string; goal: string; blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Playbook {
    validateBlocks(input.blocks);
    const now = new Date().toISOString();
    const pb: Playbook = {
      id: nowId('pb'), name: input.name, goal: input.goal,
      revisions: [{ rev: 1, blocks: maskBlocks(input.blocks), authoredBy: input.authoredBy, note: input.note, status: 'draft', createdAt: now }],
      createdAt: now, updatedAt: now,
    };
    this.save([...this.load(), pb]);
    return pb;
  }

  addRevision(id: string, input: { blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Playbook {
    validateBlocks(input.blocks);
    const pbs = this.load();
    const pb = pbs.find((p) => p.id === id);
    if (!pb) throw new PlaybookValidationError(`unknown playbook: ${id}`, 404);
    const nextRev = Math.max(...pb.revisions.map((r) => r.rev)) + 1;
    pb.revisions.push({ rev: nextRev, blocks: maskBlocks(input.blocks), authoredBy: input.authoredBy, note: input.note, status: 'draft', createdAt: new Date().toISOString() });
    pb.updatedAt = new Date().toISOString();
    this.save(pbs);
    return pb;
  }

  reviewRevision(id: string, rev: number, verdict: { approve: boolean; reviewedBy: string; rejectReason?: string }): Playbook {
    const pbs = this.load();
    const pb = pbs.find((p) => p.id === id);
    if (!pb) throw new PlaybookValidationError(`unknown playbook: ${id}`, 404);
    const r = pb.revisions.find((x) => x.rev === rev);
    if (!r) throw new PlaybookValidationError(`unknown revision: ${rev}`, 404);
    if (r.status !== 'draft') throw new PlaybookValidationError(`리비전이 draft가 아닙니다: ${r.status}`, 409);
    if (!verdict.reviewedBy?.trim()) throw new PlaybookValidationError('reviewedBy는 필수입니다');
    if (!verdict.approve && !verdict.rejectReason?.trim()) throw new PlaybookValidationError('반려 사유(rejectReason)는 필수입니다');
    r.status = verdict.approve ? 'approved' : 'rejected';
    r.reviewedBy = verdict.reviewedBy;
    r.reviewedAt = new Date().toISOString();
    if (!verdict.approve) r.rejectReason = verdict.rejectReason!.trim();
    pb.updatedAt = new Date().toISOString();
    this.save(pbs);
    return pb;
  }

  activeRevision(pb: Playbook): PlaybookRevision | undefined {
    return pb.revisions.filter((r) => r.status === 'approved').sort((a, b) => b.rev - a.rev)[0];
  }

  private load(): Playbook[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Playbook[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error; // corrupt store must fail loud
    }
  }

  private save(pbs: Playbook[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(pbs, null, 2));
    renameSync(tmp, this.path);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-store.test.ts`
Expected: PASS (PlaybookStore 케이스 전부). `npm run lint` → 에러 0.

- [ ] **Step 5: 커밋**

```bash
git add apps/control-tower/src/playbook-store.ts tests/control-tower-playbook-store.test.ts
git commit -m "feat(control-tower): PlaybookStore — types, block validation, revision state machine (T-PB-1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: AnalysisStore + AgentTaskStore (T-PB-2)

**Files:**
- Modify: `apps/control-tower/src/playbook-store.ts` (같은 파일에 `AnalysisStore`·`AgentTaskStore` 추가)
- Test: `tests/control-tower-playbook-store.test.ts` (같은 파일에 describe 2개 추가)

**Interfaces:**
- Consumes: Task 2의 타입·`PlaybookValidationError`·`maskSecrets`.
- Produces: `AnalysisStore`(append/get/listByRun/setVerdict), `AgentTaskStore`(list/create/close/cancel). Task 5·6이 사용.

- [ ] **Step 1: 실패하는 테스트 추가** (`tests/control-tower-playbook-store.test.ts` 하단에 append)

```ts
import { AnalysisStore, AgentTaskStore, type PlaybookAnalysis } from '../apps/control-tower/src/playbook-store.js';

function analysisInput(over: Partial<PlaybookAnalysis> = {}): PlaybookAnalysis {
  return {
    schemaVersion: 1, id: 'anl_seed', playbookId: 'pb_1', playbookRunId: 'pbrun_1',
    summary: 'HA 미설정 2건', authoredBy: 'agent:claude', createdAt: '2026-07-04T00:00:00.000Z',
    improvements: [{ observation: 'HA off', recommendation: 'HA 설정', evidenceRunId: 'run_x' }],
    proposals: [{ action: 'HA 설정 플레이북', rationale: '가용성' }],
    ...over,
  };
}

describe('AnalysisStore — append/fold/verdict·마스킹 (T-PB-2)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anl-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('append는 id·createdAt를 발급하고 저장 전 maskSecrets, listByRun/get 조회', () => {
    const store = new AnalysisStore(dir);
    const saved = store.append(analysisInput({ id: undefined as unknown as string, createdAt: undefined as unknown as string, summary: 'token=abc123 노출', proposals: [{ action: 'x', rationale: 'y', linkedPlaybookId: undefined }] }));
    expect(saved.id).toMatch(/^anl_/);
    expect(saved.createdAt).toBeTruthy();
    expect(store.get(saved.id)!.summary).toBe('token=abc123 노출'); // summary는 키 기반 마스킹 대상 아님 (자유 텍스트)
    expect(store.listByRun('pbrun_1').map((a) => a.id)).toContain(saved.id);
  });

  it('setVerdict: improvements/proposals 항목 갱신은 새 스냅샷 append (fold last-wins), 범위 밖 400', () => {
    const store = new AnalysisStore(dir);
    const a = store.append(analysisInput({ id: undefined as unknown as string, createdAt: undefined as unknown as string }));
    const v = store.setVerdict(a.id, 'improvements', 0, 'accepted', 'jmpark');
    expect(v.improvements[0].verdict).toBe('accepted');
    expect(v.improvements[0].reviewedBy).toBe('jmpark');
    const v2 = store.setVerdict(a.id, 'proposals', 0, 'accepted', 'jmpark', 'pb_next');
    expect(v2.proposals[0].linkedPlaybookId).toBe('pb_next');
    // 재조회 시 최신 스냅샷 (fold)
    expect(store.get(a.id)!.proposals[0].linkedPlaybookId).toBe('pb_next');
    expect(() => store.setVerdict(a.id, 'improvements', 9, 'accepted', 'x')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => store.setVerdict('anl_none', 'improvements', 0, 'accepted', 'x')).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('AgentTaskStore — 큐 상태기계 (T-PB-2)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atask-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('create(open) → close(done) / cancel, open 아니면 409, 저장 전 maskSecrets', () => {
    const store = new AgentTaskStore(dir);
    const t = store.create({ kind: 'assemble', payload: { goal: '전체분석', feedback: undefined } });
    expect(t.id).toMatch(/^atask_/);
    expect(t.status).toBe('open');
    expect(store.list('open').map((x) => x.id)).toContain(t.id);
    const done = store.close(t.id, { playbookId: 'pb_1', rev: 1 });
    expect(done.status).toBe('done');
    expect(done.result!.playbookId).toBe('pb_1');
    expect(store.list('open')).toHaveLength(0);
    // 이미 done → 재close 409
    expect(() => store.close(t.id, {})).toThrow(expect.objectContaining({ status: 409 }));
    // cancel은 open만
    const t2 = store.create({ kind: 'analyze', payload: { playbookRunId: 'pbrun_1' } });
    expect(store.cancel(t2.id).status).toBe('cancelled');
    expect(() => store.cancel(t2.id)).toThrow(expect.objectContaining({ status: 409 }));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-store.test.ts`
Expected: FAIL — `AnalysisStore`/`AgentTaskStore` 미export.

- [ ] **Step 3: 두 스토어 구현** (`playbook-store.ts` 하단에 추가)

파일 상단 import에 `appendFileSync`/`readdirSync`를 추가:

```ts
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
```

파일 하단(PlaybookStore 뒤)에 추가:

```ts
const ANALYSIS_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// RunStore와 같은 append-only 스냅샷 JSONL. id별 last-wins fold. verdict 갱신은
// createdAt를 보존한 새 스냅샷을 같은 날짜 파일에 append (RunStore.transition과 동형).
export class AnalysisStore {
  private readonly dir: string;

  constructor(dir?: string) {
    const root = dir ?? resolveRepoData('data/runs', 'SANGFOR_RUNS_ROOT');
    this.dir = join(root, 'analyses');
  }

  append(analysis: PlaybookAnalysis): PlaybookAnalysis {
    const record: PlaybookAnalysis = maskSecrets({
      ...analysis,
      schemaVersion: 1,
      id: analysis.id ?? nowId('anl'),
      createdAt: analysis.createdAt ?? new Date().toISOString(),
    });
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${record.createdAt.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
    return record;
  }

  get(id: string): PlaybookAnalysis | undefined {
    return this.foldAll().get(id);
  }

  listByRun(playbookRunId: string): PlaybookAnalysis[] {
    return [...this.foldAll().values()]
      .filter((a) => a.playbookRunId === playbookRunId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  setVerdict(
    id: string, part: 'improvements' | 'proposals', index: number,
    verdict: AnalysisVerdict, reviewedBy: string, linkedPlaybookId?: string,
  ): PlaybookAnalysis {
    const current = this.get(id);
    if (!current) throw new PlaybookValidationError(`unknown analysis: ${id}`, 404);
    const arr = current[part];
    if (index < 0 || index >= arr.length) throw new PlaybookValidationError(`${part}[${index}] 범위 밖`, 400);
    arr[index].verdict = verdict;
    arr[index].reviewedBy = reviewedBy;
    if (part === 'proposals' && linkedPlaybookId) (arr[index] as AnalysisProposal).linkedPlaybookId = linkedPlaybookId;
    return this.append(current); // createdAt 보존 → 같은 날짜 파일, last-wins
  }

  private foldAll(): Map<string, PlaybookAnalysis> {
    const out = new Map<string, PlaybookAnalysis>();
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => ANALYSIS_FILE_RE.test(f)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw error;
    }
    for (const file of files) {
      const raw = readFileSync(join(this.dir, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as PlaybookAnalysis;
          if (rec && typeof rec.id === 'string') out.set(rec.id, rec);
        } catch {
          process.stderr.write(`[analyses] skipping unparseable line in ${file}\n`);
        }
      }
    }
    return out;
  }
}

// registry 패턴: 전체 JSON, atomic write.
export class AgentTaskStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
    this.path = join(this.dir, 'agent-tasks.json');
  }

  list(status?: AgentTask['status']): AgentTask[] {
    const all = this.load();
    return status ? all.filter((t) => t.status === status) : all;
  }

  create(input: { kind: AgentTaskKind; payload: AgentTask['payload'] }): AgentTask {
    const task: AgentTask = {
      id: nowId('atask'), kind: input.kind, payload: maskSecrets(input.payload ?? {}),
      status: 'open', createdAt: new Date().toISOString(),
    };
    this.save([...this.load(), task]);
    return task;
  }

  close(id: string, result: AgentTask['result']): AgentTask {
    return this.transition(id, (t) => {
      t.status = 'done';
      t.result = maskSecrets(result ?? {});
      t.closedAt = new Date().toISOString();
    });
  }

  cancel(id: string): AgentTask {
    return this.transition(id, (t) => {
      t.status = 'cancelled';
      t.closedAt = new Date().toISOString();
    });
  }

  private transition(id: string, mutate: (t: AgentTask) => void): AgentTask {
    const tasks = this.load();
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new PlaybookValidationError(`unknown agent-task: ${id}`, 404);
    if (t.status !== 'open') throw new PlaybookValidationError(`task가 open이 아닙니다: ${t.status}`, 409);
    mutate(t);
    this.save(tasks);
    return t;
  }

  private load(): AgentTask[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as AgentTask[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private save(tasks: AgentTask[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    renameSync(tmp, this.path);
  }
}
```

> **주의:** `PlaybookAnalysis.id`/`createdAt`는 인터페이스상 필수지만 `append`는 미발급 입력(`undefined`)을 받아 채운다. api 라우트(Task 6)가 `id`·`createdAt`를 제외한 body를 받으므로 실제 호출에서는 항상 미발급으로 들어온다. 테스트는 `undefined as unknown as string`로 이를 재현한다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-store.test.ts`
Expected: PASS (Task 2·3 전체). `npm run lint` → 에러 0.

- [ ] **Step 5: 커밋**

```bash
git add apps/control-tower/src/playbook-store.ts tests/control-tower-playbook-store.test.ts
git commit -m "feat(control-tower): AnalysisStore (append-only JSONL) + AgentTaskStore queue (T-PB-2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: playbook-engine.ts — 순수함수 3개 (T-PB-3)

**Files:**
- Create: `apps/control-tower/src/playbook-engine.ts`
- Test: `tests/control-tower-playbook-engine.test.ts` (순수함수 부분 — Task 5에서 같은 파일에 실행 통합 추가)

**Interfaces:**
- Consumes: `@sangfor/runs`의 `RunRecord`/`RunStatus` 타입, Task 2의 `Playbook`/`PlaybookRevision`/`PlaybookBlock`.
- Produces: `PlaybookRunStatus` 타입, `TemplateError`, `resolveTemplates(args, lookup)`, `derivePlaybookRunStatus(revision, blockRuns)`, `renderReport(playbook, rev, playbookRunId, blockRuns)`. Task 5 엔진과 Task 6 라우트가 사용.

**모듈 경계 (스펙 §5.3 확정):** 이 파일은 **부수효과 없는 순수함수 3개만** export한다. `renderReport`의 파일 저장은 호출자(Task 5 엔진) 몫이다. 상태를 가진 실행 루프는 여기 두지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성** (`tests/control-tower-playbook-engine.test.ts` 신규)

```ts
import { describe, expect, it } from 'vitest';
import { resolveTemplates, derivePlaybookRunStatus, renderReport, TemplateError } from '../apps/control-tower/src/playbook-engine.js';
import type { RunRecord } from '@sangfor/runs';
import type { Playbook, PlaybookRevision } from '../apps/control-tower/src/playbook-store.js';

function run(over: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1, runId: over.runId ?? 'run_x', toolId: 't', toolSafety: 'read_only',
    args: {}, status: 'succeeded', requestedAt: '2026-07-04T00:00:00.000Z', ...over,
  };
}

describe('resolveTemplates (T-PB-3)', () => {
  const lookup = (id: string) => id === 'b1'
    ? run({ runId: 'run_b1', blockId: 'b1', resultJson: { host: '10.0.0.1', summary: { pass: 3 }, list: [1, 2] } })
    : undefined;

  it('정확히 템플릿 하나 → 해석값(타입 보존), 부분 포함 → String 보간', () => {
    expect(resolveTemplates({ h: '{{blocks.b1.result.host}}' }, lookup)).toEqual({ h: '10.0.0.1' });
    expect(resolveTemplates({ n: '{{blocks.b1.result.summary.pass}}' }, lookup)).toEqual({ n: 3 }); // number 보존
    expect(resolveTemplates({ arr: '{{blocks.b1.result.list}}' }, lookup)).toEqual({ arr: [1, 2] }); // array 보존
    expect(resolveTemplates({ msg: 'host=({{blocks.b1.result.host}})' }, lookup)).toEqual({ msg: 'host=(10.0.0.1)' });
    expect(resolveTemplates({ deep: { x: '{{blocks.b1.result.host}}' }, plain: 5 }, lookup))
      .toEqual({ deep: { x: '10.0.0.1' }, plain: 5 });
  });

  it('블록 미완료/경로 없음 → TemplateError (해석 실패는 값이 아니라 예외)', () => {
    expect(() => resolveTemplates({ x: '{{blocks.b2.result.host}}' }, lookup)).toThrow(TemplateError);
    expect(() => resolveTemplates({ x: '{{blocks.b1.result.nope.deep}}' }, lookup)).toThrow(TemplateError);
    const pending = (id: string) => run({ runId: 'p', blockId: id, status: 'pending_approval', resultJson: undefined });
    expect(() => resolveTemplates({ x: '{{blocks.b1.result.host}}' }, pending)).toThrow(TemplateError);
  });
});

function rev(blocks: PlaybookRevision['blocks']): PlaybookRevision {
  return { rev: 1, blocks, authoredBy: 'a', status: 'approved', createdAt: '2026-07-04T00:00:00.000Z' };
}
const R = rev([
  { id: 'b1', type: 'tool', toolId: 't1' },
  { id: 'b2', type: 'tool', toolId: 't2' },
  { id: 'r1', type: 'report' },
]);

describe('derivePlaybookRunStatus (T-PB-3)', () => {
  it('pending 있으면 waiting_approval', () => {
    const runs = [run({ blockId: 'b1', status: 'succeeded' }), run({ blockId: 'b2', status: 'pending_approval' })];
    expect(derivePlaybookRunStatus(R, runs).status).toBe('waiting_approval');
  });
  it('실행 없는 블록 남음(실패 없음) → running', () => {
    expect(derivePlaybookRunStatus(R, [run({ blockId: 'b1', status: 'succeeded' })]).status).toBe('running');
  });
  it('모든 블록 succeeded → succeeded', () => {
    const runs = [run({ blockId: 'b1' }), run({ blockId: 'b2' }), run({ blockId: 'r1' })];
    expect(derivePlaybookRunStatus(R, runs).status).toBe('succeeded');
  });
  it('실패 + report succeeded → partial', () => {
    const runs = [run({ blockId: 'b1', status: 'failed' }), run({ blockId: 'r1', status: 'succeeded' })];
    expect(derivePlaybookRunStatus(R, runs).status).toBe('partial');
  });
  it('실패 + report 없음/미실행 → failed, blocks 매핑 반환', () => {
    const runs = [run({ runId: 'run_b1', blockId: 'b1', status: 'failed' })];
    const out = derivePlaybookRunStatus(R, runs);
    expect(out.status).toBe('failed');
    expect(out.blocks).toEqual([
      { blockId: 'b1', runId: 'run_b1', status: 'failed' },
      { blockId: 'b2', runId: undefined, status: undefined },
      { blockId: 'r1', runId: undefined, status: undefined },
    ]);
  });
});

describe('renderReport (T-PB-3)', () => {
  const pb: Playbook = {
    id: 'pb_1', name: '자문 루프', goal: '전체분석', createdAt: '', updatedAt: '',
    revisions: [rev([
      { id: 'b1', type: 'tool', toolId: 'sangfor.advisor_fortios', title: 'FortiOS 자문' },
      { id: 'r1', type: 'report' },
    ])],
  };
  const blockRuns = [run({
    runId: 'run_b1', blockId: 'b1', status: 'succeeded', resultSummary: 'ok=false pass=1 fail=1',
    resultJson: { evaluation: { specId: 's', ok: false, summary: { pass: 1, fail: 1 }, items: [
      { id: 'i1', label: 'HA 설정', verdict: 'FAIL', category: 'missing', observed: 'off', expected: 'on', reason: 'HA 비활성' },
      { id: 'i2', label: '펌웨어', verdict: 'PASS', category: 'ok', reason: 'ok' },
    ] } },
  })];

  it('FAIL 항목 취합 + 결정성(같은 입력=같은 출력) + 기계집계 고지', () => {
    const md = renderReport(pb, 1, 'pbrun_1', blockRuns);
    expect(md).toContain('자문 루프');
    expect(md).toContain('FortiOS 자문');
    expect(md).toContain('HA 설정');       // FAIL 항목 표
    expect(md).toContain('HA 비활성');       // reason
    expect(md).not.toContain('펌웨어');      // PASS 항목은 표에 없음
    expect(md).toContain('기계 집계');       // AI 분석과 구분 고지
    expect(renderReport(pb, 1, 'pbrun_1', blockRuns)).toBe(md); // 결정적
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-engine.test.ts`
Expected: FAIL — `playbook-engine.ts` 미존재.

- [ ] **Step 3: 순수함수 3개 구현** (`apps/control-tower/src/playbook-engine.ts` 신규)

```ts
import type { RunRecord, RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import type { Playbook, PlaybookRevision } from './playbook-store.js';

export type PlaybookRunStatus = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'partial';

export class TemplateError extends Error {
  constructor(public readonly template: string) { super(`템플릿 해석 실패: ${template}`); }
}

// {{blocks.<id>.result<.dot.path>}} — id/path는 [A-Za-z0-9_-]
const TEMPLATE_G = /\{\{\s*blocks\.([A-Za-z0-9_-]+)\.result((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const TEMPLATE_EXACT = /^\{\{\s*blocks\.([A-Za-z0-9_-]+)\.result((?:\.[A-Za-z0-9_-]+)*)\s*\}\}$/;

type Lookup = (blockId: string) => RunRecord | undefined;

function resolvePath(root: unknown, dotPath: string): unknown {
  if (!dotPath) return root; // '.result' 전체
  let cur = root;
  for (const key of dotPath.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') throw new TemplateError(`{{...result${dotPath}}}`);
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) throw new TemplateError(`{{...result${dotPath}}}`);
  }
  return cur;
}

function resolveOne(blockId: string, dotPath: string, lookup: Lookup): unknown {
  const rec = lookup(blockId);
  if (!rec || rec.status !== 'succeeded' || rec.resultJson === undefined) {
    throw new TemplateError(`{{blocks.${blockId}.result${dotPath}}}`);
  }
  return resolvePath(rec.resultJson, dotPath);
}

function resolveString(str: string, lookup: Lookup): unknown {
  const exact = str.match(TEMPLATE_EXACT);
  if (exact) return resolveOne(exact[1], exact[2], lookup); // 타입 보존
  return str.replace(TEMPLATE_G, (_m, id: string, path: string) => String(resolveOne(id, path, lookup)));
}

// 실패 시 TemplateError throw. 자기 playbookRun 내 블록만 lookup으로 넘어온다(§7.3 격리는 호출자 책임).
export function resolveTemplates(args: Record<string, unknown>, lookup: Lookup): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return resolveString(value, lookup);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(args) as Record<string, unknown>;
}

// 접근법 B: 리비전 블록 목록 + 블록 run 태그에서 상태를 유도 (별도 상태 레코드 없음).
export function derivePlaybookRunStatus(
  revision: PlaybookRevision,
  blockRuns: RunRecord[],
): { status: PlaybookRunStatus; blocks: Array<{ blockId: string; runId?: string; status?: RunStatus }> } {
  const byBlock = new Map<string, RunRecord>();
  for (const r of blockRuns) {
    if (!r.blockId) continue;
    const prev = byBlock.get(r.blockId);
    if (!prev || r.requestedAt > prev.requestedAt) byBlock.set(r.blockId, r);
  }
  const blocks = revision.blocks.map((b) => {
    const r = byBlock.get(b.id);
    return { blockId: b.id, runId: r?.runId, status: r?.status };
  });
  const statuses = blocks.map((b) => b.status);
  const reportBlock = revision.blocks.find((b) => b.type === 'report');
  const reportRun = reportBlock ? byBlock.get(reportBlock.id) : undefined;

  if (statuses.includes('pending_approval')) return { status: 'waiting_approval', blocks };
  if (statuses.includes('running')) return { status: 'running', blocks };
  if (statuses.some((s) => s === 'failed' || s === 'rejected')) {
    return { status: reportRun?.status === 'succeeded' ? 'partial' : 'failed', blocks };
  }
  if (statuses.every((s) => s === 'succeeded')) return { status: 'succeeded', blocks };
  return { status: 'running', blocks }; // 실패·대기·진행 없고 아직 시작 안 한 블록 남음
}

// v1 summarize의 EvaluationResult 판정과 동형 — 직접 | .evaluation | .evaluations[] 래핑 지원.
interface EvalItem { verdict: string; label: string; observed?: unknown; expected?: unknown; reason: string }
function evalItemsOf(resultJson: unknown): EvalItem[] {
  const pull = (e: unknown): EvalItem[] => {
    const items = (e as { items?: unknown })?.items;
    return Array.isArray(items)
      ? items.filter((i): i is EvalItem => !!i && typeof (i as EvalItem).verdict === 'string' && typeof (i as EvalItem).label === 'string')
      : [];
  };
  if (!resultJson || typeof resultJson !== 'object') return [];
  const r = resultJson as { items?: unknown; evaluation?: unknown; evaluations?: unknown[] };
  if (Array.isArray(r.items)) return pull(r);
  if (r.evaluation) return pull(r.evaluation);
  if (Array.isArray(r.evaluations)) return r.evaluations.flatMap(pull);
  return [];
}

// 결정적(LLM 없음). report 블록 이전의 블록 run들을 마크다운으로 집계.
export function renderReport(playbook: Playbook, rev: number, playbookRunId: string, blockRuns: RunRecord[]): string {
  const revision = playbook.revisions.find((r) => r.rev === rev);
  const byBlock = new Map<string, RunRecord>();
  for (const r of blockRuns) if (r.blockId) byBlock.set(r.blockId, r);
  const L: string[] = [];
  L.push(`# 플레이북 종합 리포트: ${playbook.name}`);
  L.push('');
  L.push(`- 목표: ${playbook.goal}`);
  L.push(`- 리비전: rev ${rev} · 실행 ID: ${playbookRunId}`);
  L.push('');

  const fails: Array<{ label: string; observed: string; expected: string; reason: string }> = [];
  const toolBlocks = (revision?.blocks ?? []).filter((b) => b.type === 'tool');
  for (const block of toolBlocks) {
    const r = byBlock.get(block.id);
    if (!r) continue; // 앞선 블록만 집계 (미실행은 생략)
    L.push(`## ${block.title ?? block.id} (${block.toolId})`);
    if (block.deviceId) L.push(`- 장비: ${block.deviceId}`);
    L.push(`- 상태: ${r.status}${r.resultSummary ? ` · ${r.resultSummary}` : ''}`);
    L.push(`- runId: ${r.runId}`);
    for (const item of evalItemsOf(r.resultJson)) {
      if (item.verdict === 'FAIL') {
        fails.push({ label: item.label, observed: String(item.observed ?? '-'), expected: String(item.expected ?? '-'), reason: item.reason });
      }
    }
    L.push('');
  }

  if (fails.length) {
    L.push('## FAIL 항목');
    L.push('');
    L.push('| 항목 | 관측 | 기대 | 사유 |');
    L.push('|---|---|---|---|');
    for (const f of fails) L.push(`| ${f.label} | ${f.observed} | ${f.expected} | ${f.reason} |`);
    L.push('');
    L.push('## 개선권고');
    for (const f of fails) L.push(`- **${f.label}**: ${f.reason}`);
    L.push('');
  } else {
    L.push('## FAIL 항목');
    L.push('');
    L.push('없음 (집계 대상 블록에서 FAIL 미검출).');
    L.push('');
  }

  L.push('---');
  L.push('> 이 보고서는 기계 집계입니다. AI 분석은 별도 아티팩트로 제출됩니다.');
  L.push('');
  return L.join('\n');
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-engine.test.ts`
Expected: PASS. `npm run lint` → 에러 0.

- [ ] **Step 5: 커밋**

```bash
git add apps/control-tower/src/playbook-engine.ts tests/control-tower-playbook-engine.test.ts
git commit -m "feat(control-tower): playbook-engine pure fns — resolveTemplates/deriveStatus/renderReport (T-PB-3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 실행 엔진 (createApi 내부) + approveRun continueRun 접점 (T-PB-4)

**Files:**
- Modify: `apps/control-tower/src/api.ts` (import 추가, `TowerOptions.playbookOutputDir`, 스토어 3개 인스턴스화, 엔진 프리미티브, `executePlaybook`/`continuePlaybookRun`/`getPlaybookRun` 메서드, `approveRun` continueRun 접점)
- Test: `tests/control-tower-playbook-engine.test.ts` (실행 통합 describe 추가 — 순수함수 테스트와 같은 파일)

**Interfaces:**
- Consumes: Task 2·3 스토어, Task 4 순수함수, v1 `execute`/`store`/`registry`/`bridge`/`originalArgs`/`listBridgeTools`/`applyMockCredentialFallback`/`mergeDeviceArgs`/`safetyOf`.
- Produces: `api.executePlaybook(id)`, `api.continuePlaybookRun(pbrunId)`, `api.getPlaybookRun(pbrunId)`. Task 6 라우트가 위임. T-PB-4 테스트는 `PlaybookStore(registryDir)`로 승인본을 시드한 뒤 이 메서드를 직접 호출.

- [ ] **Step 1: 실패하는 실행 통합 테스트 추가** (`tests/control-tower-playbook-engine.test.ts` 하단에 append — stub bridge를 띄운다)

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach } from 'vitest';
import { createApi } from '../apps/control-tower/src/api.js';
import { PlaybookStore } from '../apps/control-tower/src/playbook-store.js';

// read: EvaluationResult 반환 / write: pending 대상 / fail: isError
const ENGINE_TOOLS = {
  tools: [
    { name: 'eng.read', description: 'r', inputSchema: { type: 'object', properties: { host: { type: 'string' } } }, annotations: { title: 'r', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
    { name: 'eng.write', description: 'w', inputSchema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }, annotations: { title: 'w', readOnlyHint: false, destructiveHint: false }, category: 'pm' },
    { name: 'eng.fail', description: 'f', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'f', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
  ],
};

describe('플레이북 실행 엔진 (T-PB-4)', () => {
  let bridge: http.Server; let bridgeUrl: string;
  let runsDir: string; let registryDir: string; let outDir: string;

  function startBridge(): Promise<void> {
    bridge = http.createServer(async (req, res) => {
      const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mcp: 'connected' });
      if (req.method === 'GET' && req.url === '/tools') return send(200, ENGINE_TOOLS);
      if (req.method === 'POST' && req.url === '/tools/call') {
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.name === 'eng.fail') return send(200, { result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
        const payload = body.name === 'eng.read'
          ? { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 2, fail: 0 }, coverage: {} } }
          : { created: true, echo: body.arguments };
        return send(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
      }
      send(404, { error: 'nf' });
    });
    return new Promise((r) => bridge.listen(0, '127.0.0.1', () => { bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`; r(); }));
  }

  const mkApi = () => createApi({ bridgeUrl, runsDir, registryDir, playbookOutputDir: outDir, approvalSecret: 'sec', mockConsoleUrl: 'http://127.0.0.1:1' });

  beforeEach(async () => {
    runsDir = mkdtempSync(join(tmpdir(), 'eng-runs-'));
    registryDir = mkdtempSync(join(tmpdir(), 'eng-reg-'));
    outDir = mkdtempSync(join(tmpdir(), 'eng-out-'));
    await startBridge();
  });
  afterEach(async () => {
    await new Promise<void>((r) => bridge.close(() => r()));
    for (const d of [runsDir, registryDir, outDir]) rmSync(d, { recursive: true, force: true });
  });

  function seedApproved(blocks: import('../apps/control-tower/src/playbook-store.js').PlaybookBlock[]): string {
    const store = new PlaybookStore(registryDir);
    const pb = store.create({ name: 'p', goal: 'g', authoredBy: 'a', blocks });
    store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'jmpark' });
    return pb.id;
  }

  it('read 체인 + report → succeeded, report md 파일 생성', async () => {
    const api = mkApi();
    const id = seedApproved([
      { id: 'b1', type: 'tool', toolId: 'eng.read', args: { host: 'h1' } },
      { id: 'b2', type: 'tool', toolId: 'eng.read', args: { host: '{{blocks.b1.result.evaluation.specId}}' } }, // 템플릿 해석
      { id: 'r1', type: 'report' },
    ]);
    const out = await api.executePlaybook(id);
    expect(out.status).toBe('succeeded');
    const md = readFileSync(join(outDir, `${out.playbookRunId}.md`), 'utf8');
    expect(md).toContain('기계 집계');
    // b2가 b1 결과(specId 's')를 host로 받아 실행됨
    const runs = api.listRuns({ playbookRunId: out.playbookRunId });
    expect(runs.filter((r) => r.status === 'succeeded').length).toBe(3); // b1, b2, report
  });

  it('read 실패 → 이후 tool 건너뛰고 report만 실행 → partial', async () => {
    const api = mkApi();
    const id = seedApproved([
      { id: 'b1', type: 'tool', toolId: 'eng.fail' },
      { id: 'b2', type: 'tool', toolId: 'eng.read', args: { host: 'x' } },
      { id: 'r1', type: 'report' },
    ]);
    const out = await api.executePlaybook(id);
    expect(out.status).toBe('partial');
    const runs = api.listRuns({ playbookRunId: out.playbookRunId });
    expect(runs.find((r) => r.blockId === 'b1')!.status).toBe('failed');
    expect(runs.find((r) => r.blockId === 'b2')).toBeUndefined(); // 건너뜀
    expect(runs.find((r) => r.blockId === 'r1')!.status).toBe('succeeded'); // 부분 리포트
  });

  it('write 블록 도달 → pending_approval + 엔진 정지 (waiting_approval), report 미실행', async () => {
    const api = mkApi();
    const id = seedApproved([
      { id: 'b1', type: 'tool', toolId: 'eng.read', args: { host: 'h' } },
      { id: 'b2', type: 'tool', toolId: 'eng.write', args: { customer: 'acme' } },
      { id: 'r1', type: 'report' },
    ]);
    const out = await api.executePlaybook(id);
    expect(out.status).toBe('waiting_approval');
    const runs = api.listRuns({ playbookRunId: out.playbookRunId });
    expect(runs.find((r) => r.blockId === 'b2')!.status).toBe('pending_approval');
    expect(runs.find((r) => r.blockId === 'r1')).toBeUndefined(); // 아직 리포트 없음
  });

  it('write 승인 → continueRun으로 후속 report까지 → succeeded', async () => {
    const api = mkApi();
    const id = seedApproved([
      { id: 'b1', type: 'tool', toolId: 'eng.write', args: { customer: 'acme' } },
      { id: 'r1', type: 'report' },
    ]);
    const started = await api.executePlaybook(id);
    expect(started.status).toBe('waiting_approval');
    const pending = api.listRuns({ playbookRunId: started.playbookRunId }).find((r) => r.blockId === 'b1')!;
    await api.approveRun(pending.runId, { approvedBy: 'jmpark' });
    const derived = api.getPlaybookRun(started.playbookRunId);
    expect(derived.status).toBe('succeeded'); // 승인 후 report까지 이어짐
  });

  it('활성 리비전 없이 execute → 403', async () => {
    const api = mkApi();
    const store = new PlaybookStore(registryDir);
    const pb = store.create({ name: 'p', goal: 'g', authoredBy: 'a', blocks: [{ id: 'b1', type: 'tool', toolId: 'eng.read' }] });
    await expect(api.executePlaybook(pb.id)).rejects.toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-engine.test.ts -t "T-PB-4"`
Expected: FAIL — `api.executePlaybook` 등 미존재.

- [ ] **Step 3: import·옵션·스토어 인스턴스화** (`api.ts`)

상단 import 수정 — shared에서 `resolveRepoData` 추가:

```ts
import { nowId, resolveRepoData } from '../../../packages/shared/src/index.js';
```

playbook 모듈 import를 registry import 다음 줄에 추가:

```ts
import { PlaybookStore, AnalysisStore, AgentTaskStore, PlaybookValidationError, type Playbook, type PlaybookBlock, type PlaybookAnalysis, type AgentTask, type AnalysisVerdict } from './playbook-store.js';
import { resolveTemplates, derivePlaybookRunStatus, renderReport, TemplateError, type PlaybookRunStatus } from './playbook-engine.js';
```

`TowerOptions`에 옵션 1개 추가 (`mockConsoleUrl?: string;` 다음):

```ts
  mockConsoleUrl?: string;
  playbookOutputDir?: string;   // 리포트 산출물 경로 (테스트 주입용, 기본 resolveRepoData('outputs/playbooks'))
```

`createApi` 본문의 `const originalArgs = new Map<...>();` 다음에 스토어·경로 인스턴스화:

```ts
  const originalArgs = new Map<string, Record<string, unknown>>();
  const playbooks = new PlaybookStore(opts.registryDir);
  const analyses = new AnalysisStore(opts.runsDir);
  const agentTasks = new AgentTaskStore(opts.registryDir);
  const playbookOutputDir = opts.playbookOutputDir ?? resolveRepoData('outputs/playbooks');
```

파일 상단 import에 `mkdirSync`/`writeFileSync`가 필요하다. 기존 `api.ts`에 node:fs import가 없으면 추가:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
```

- [ ] **Step 4: 엔진 프리미티브 구현** (`api.ts`의 `execute`/`stripResultJson` 함수 다음, `return { ... }` 직전에 추가)

```ts
  const PB_LIMIT = { sinceDays: Infinity, limit: Infinity } as const;
  const blockRunsOf = (playbookRunId: string): RunRecord[] => store.listRuns({ playbookRunId, ...PB_LIMIT });
  const latestBlockRun = (playbookRunId: string, blockId: string): RunRecord | undefined =>
    blockRunsOf(playbookRunId).find((r) => r.blockId === blockId); // listRuns는 requestedAt 내림차순 → 최신

  // 블록 args 해석: 템플릿 → deviceId 병합 → mock 폴백. write 블록의 실행용 인자를 만든다.
  async function resolveBlockArgs(block: PlaybookBlock, playbookRunId: string, tool: BridgeTool): Promise<Record<string, unknown>> {
    let args = resolveTemplates(block.args ?? {}, (bid) => latestBlockRun(playbookRunId, bid));
    if (block.deviceId) {
      const device = registry.devices().find((d) => d.id === block.deviceId);
      if (!device) throw new ApiError(400, `unknown device: ${block.deviceId}`);
      const vendor = registry.vendorFor(device.product);
      if (!vendor) throw new ApiError(400, `no vendor descriptor for product: ${device.product}`);
      args = applyMockCredentialFallback(mergeDeviceArgs(vendor, device, args), vendor, tool.inputSchema);
    }
    return args;
  }

  function makeTags(pb: Playbook, rev: number, playbookRunId: string, blockId: string) {
    return { playbookId: pb.id, playbookRunId, playbookRev: rev, blockId };
  }

  // 한 tool 블록 실행. 반환: 'succeeded' | 'failed' | 'paused'(write pending).
  async function runToolBlock(pb: Playbook, rev: number, playbookRunId: string, block: PlaybookBlock): Promise<'succeeded' | 'failed' | 'paused'> {
    const tags = makeTags(pb, rev, playbookRunId, block.id);
    const tools = await listBridgeTools();
    const tool = tools.find((t) => t.name === block.toolId);
    if (!tool) {
      const rec = store.createRun({ toolId: block.toolId ?? 'unknown', toolSafety: 'read_only', args: block.args ?? {}, initialStatus: 'running', ...tags });
      store.transition(rec.runId, { status: 'failed', error: `unknown tool: ${block.toolId}`, finishedAt: new Date().toISOString() });
      return 'failed';
    }
    let args: Record<string, unknown>;
    try {
      args = await resolveBlockArgs(block, playbookRunId, tool);
    } catch (error) {
      const rec = store.createRun({ toolId: tool.name, toolSafety: safetyOf(tool), args: block.args ?? {}, initialStatus: 'running', ...tags });
      const msg = error instanceof TemplateError ? error.message : error instanceof ApiError ? error.message : String(error);
      store.transition(rec.runId, { status: 'failed', error: msg, finishedAt: new Date().toISOString() });
      return 'failed';
    }
    const safety = safetyOf(tool);
    if (safety === 'read_only') {
      const rec = store.createRun({ toolId: tool.name, toolSafety: 'read_only', args, deviceId: block.deviceId, initialStatus: 'running', ...tags });
      const final = await execute(rec.runId, tool.name, args);
      return final.status === 'succeeded' ? 'succeeded' : 'failed';
    }
    const rec = store.createRun({ toolId: tool.name, toolSafety: safety, args, deviceId: block.deviceId, initialStatus: 'pending_approval', ...tags });
    originalArgs.set(rec.runId, args); // 승인 시 실행용 (v1과 동일 규약)
    return 'paused';
  }

  async function runReportBlock(pb: Playbook, rev: number, playbookRunId: string, block: PlaybookBlock): Promise<void> {
    const priorRuns = blockRunsOf(playbookRunId); // report run 생성 전에 조회 → 자기 자신 제외
    const tags = makeTags(pb, rev, playbookRunId, block.id);
    const rec = store.createRun({ toolId: 'tower.report', toolSafety: 'read_only', args: {}, initialStatus: 'running', ...tags });
    try {
      const markdown = renderReport(pb, rev, playbookRunId, priorRuns);
      mkdirSync(playbookOutputDir, { recursive: true });
      const path = join(playbookOutputDir, `${playbookRunId}.md`);
      writeFileSync(path, markdown);
      store.transition(rec.runId, { status: 'succeeded', resultJson: { markdown, path }, resultSummary: markdown.split('\n')[0].slice(0, 200), finishedAt: new Date().toISOString() });
    } catch (error) {
      store.transition(rec.runId, { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
    }
  }

  // index부터 블록을 순차 실행. write pending 도달 시 반환(정지). stop-on-failure: 실패 후 tool은
  // 건너뛰되 report는 항상 실행. resume을 위해 startIndex 이전 블록들의 실패를 재유도한다.
  async function runBlocksFrom(pb: Playbook, rev: PlaybookRevision, playbookRunId: string, startIndex: number): Promise<void> {
    const priorByBlock = new Map<string, RunRecord>();
    for (const r of blockRunsOf(playbookRunId)) if (r.blockId) priorByBlock.set(r.blockId, r);
    let failed = rev.blocks.slice(0, startIndex).some((b) => {
      const st = priorByBlock.get(b.id)?.status;
      return st === 'failed' || st === 'rejected';
    });
    for (let i = startIndex; i < rev.blocks.length; i++) {
      const block = rev.blocks[i];
      if (block.type === 'report') { await runReportBlock(pb, rev.rev, playbookRunId, block); continue; }
      if (failed) continue; // 실패 후 tool 블록 건너뜀
      const outcome = await runToolBlock(pb, rev.rev, playbookRunId, block);
      if (outcome === 'paused') return; // write pending → 정지 (report는 승인 후 continueRun에서)
      if (outcome === 'failed') failed = true;
    }
  }

  function derivePlaybookRunState(pb: Playbook, rev: PlaybookRevision, playbookRunId: string) {
    const derived = derivePlaybookRunStatus(rev, blockRunsOf(playbookRunId));
    return { playbookRunId, playbookId: pb.id, rev: rev.rev, status: derived.status, blocks: derived.blocks };
  }
```

`PlaybookRevision` 타입을 import에 추가한다 (Task 2 export). `api.ts` playbook-store import에 `type PlaybookRevision`를 넣어라. `BridgeTool` 타입은 이미 bridge-client에서 import되어 있다.

- [ ] **Step 5: 공개 메서드 3개 추가** (`api.ts`의 `return { ... }` 객체 안, `mint(...)` 앞에 추가)

```ts
    async executePlaybook(playbookId: string): Promise<{ playbookRunId: string; playbookId: string; rev: number; status: PlaybookRunStatus; blocks: Array<{ blockId: string; runId?: string; status?: RunStatus }> }> {
      const pb = playbooks.get(playbookId);
      if (!pb) throw new ApiError(404, `unknown playbook: ${playbookId}`);
      const rev = playbooks.activeRevision(pb);
      if (!rev) throw new ApiError(403, '승인된 리비전이 없습니다');
      const playbookRunId = nowId('pbrun');
      await runBlocksFrom(pb, rev, playbookRunId, 0);
      return derivePlaybookRunState(pb, rev, playbookRunId);
    },

    async continuePlaybookRun(playbookRunId: string): Promise<void> {
      const runs = blockRunsOf(playbookRunId);
      const anchor = runs[0];
      if (!anchor?.playbookId || anchor.playbookRev === undefined) throw new ApiError(409, `재개 불가: ${playbookRunId} 태그 소실`);
      const pb = playbooks.get(anchor.playbookId);
      if (!pb) throw new ApiError(409, '재개 불가: 플레이북 없음');
      const rev = pb.revisions.find((r) => r.rev === anchor.playbookRev);
      if (!rev) throw new ApiError(409, '재개 불가: 리비전 없음');
      const done = new Map<string, RunStatus>();
      for (const r of runs) if (r.blockId) done.set(r.blockId, r.status);
      // 첫 번째 미완료 블록(run 없음 또는 pending/running)부터 재개
      let startIndex = rev.blocks.length;
      for (let i = 0; i < rev.blocks.length; i++) {
        const st = done.get(rev.blocks[i].id);
        if (st === undefined || st === 'pending_approval' || st === 'running') { startIndex = i; break; }
      }
      if (startIndex < rev.blocks.length) await runBlocksFrom(pb, rev, playbookRunId, startIndex);
    },

    getPlaybookRun(playbookRunId: string): { playbookRunId: string; playbookId?: string; rev?: number; status: PlaybookRunStatus; blocks: Array<{ blockId: string; runId?: string; status?: RunStatus }>; analyses: PlaybookAnalysis[] } {
      const runs = blockRunsOf(playbookRunId);
      const anchor = runs[0];
      if (!anchor?.playbookId || anchor.playbookRev === undefined) throw new ApiError(404, `unknown playbook run: ${playbookRunId}`);
      const pb = playbooks.get(anchor.playbookId);
      const rev = pb?.revisions.find((r) => r.rev === anchor.playbookRev);
      if (!pb || !rev) throw new ApiError(404, `playbook/revision missing for run: ${playbookRunId}`);
      const derived = derivePlaybookRunStatus(rev, runs);
      return { playbookRunId, playbookId: pb.id, rev: rev.rev, status: derived.status, blocks: derived.blocks, analyses: analyses.listByRun(playbookRunId) };
    },
```

- [ ] **Step 6: approveRun continueRun 접점 #2 추가** (`api.ts`의 `approveRun` 안, `originalArgs.delete(runId);` 다음, `return final;` 앞)

```ts
      const final = await execute(runId, record.toolId, args, signed);
      originalArgs.delete(runId);
      // 접점 #2 (스펙 §5.3): 플레이북 write run이면 후속 블록을 이어서 실행. 실패한 write도
      // continueRun에 들어가되 엔진이 실패를 재유도해 tool은 건너뛰고 report만 실행한다(→ partial/failed).
      if (record.playbookRunId) {
        await continueFromApprove(record.playbookRunId);
        return store.getRun(runId) ?? final; // 승인된 write run 레코드를 그대로 반환
      }
      return final;
```

`approveRun`은 `return { ... }` 객체 안의 메서드라 그 안에서 `continuePlaybookRun`을 직접 부를 수 없다(같은 객체의 다른 메서드는 `this.` 필요, 하지만 이 코드베이스는 `this` 미사용 패턴). 클로저 함수로 빼서 공유한다. **Step 5의 `continuePlaybookRun` 본문을 클로저 함수 `continueFromApprove`로 옮기고, 공개 메서드는 이를 위임**하도록 한다:

`return { ... }` 앞(엔진 프리미티브 다음)에 클로저 함수 추가:

```ts
  async function continueFromApprove(playbookRunId: string): Promise<void> {
    const runs = blockRunsOf(playbookRunId);
    const anchor = runs[0];
    if (!anchor?.playbookId || anchor.playbookRev === undefined) throw new ApiError(409, `재개 불가: ${playbookRunId} 태그 소실`);
    const pb = playbooks.get(anchor.playbookId);
    if (!pb) throw new ApiError(409, '재개 불가: 플레이북 없음');
    const rev = pb.revisions.find((r) => r.rev === anchor.playbookRev);
    if (!rev) throw new ApiError(409, '재개 불가: 리비전 없음');
    const done = new Map<string, RunStatus>();
    for (const r of runs) if (r.blockId) done.set(r.blockId, r.status);
    let startIndex = rev.blocks.length;
    for (let i = 0; i < rev.blocks.length; i++) {
      const st = done.get(rev.blocks[i].id);
      if (st === undefined || st === 'pending_approval' || st === 'running') { startIndex = i; break; }
    }
    if (startIndex < rev.blocks.length) await runBlocksFrom(pb, rev, playbookRunId, startIndex);
  }
```

그리고 공개 메서드 `continuePlaybookRun`은 위 본문 대신 `return continueFromApprove(playbookRunId);` 한 줄로 위임한다.

- [ ] **Step 7: 통과 확인 + 무회귀**

Run: `pnpm exec vitest run tests/control-tower-playbook-engine.test.ts`
Expected: PASS (T-PB-3·4 전부).
Run: `pnpm exec vitest run tests/control-tower-api.test.ts tests/control-tower-e2e.test.ts` → v1 무회귀 PASS.
Run: `npm run lint` → 에러 0.

- [ ] **Step 8: 커밋**

```bash
git add apps/control-tower/src/api.ts tests/control-tower-playbook-engine.test.ts
git commit -m "feat(control-tower): playbook execution engine in createApi + approve continue hook (T-PB-4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: API 라우트 전체 + CRUD/분석/큐 위임 메서드 (T-PB-5)

**Files:**
- Modify: `apps/control-tower/src/api.ts` (위임 메서드: 플레이북 CRUD·리뷰, 분석 제출·verdict, agent-task 큐)
- Modify: `apps/control-tower/src/server.ts` (§5.4 라우트 12개)
- Test: `tests/control-tower-playbook-api.test.ts` (신규 — T-PB-5. Task 7에서 같은 파일에 재개 테스트 추가)

**Interfaces:**
- Consumes: Task 5 엔진 메서드, Task 2·3 스토어(via 클로저), `PlaybookValidationError`.
- Produces: api 메서드 `listPlaybooks`/`createPlaybook`/`getPlaybook`/`addPlaybookRevision`/`reviewPlaybookRevision`/`submitAnalysis`/`setAnalysisVerdict`/`listAgentTasks`/`createAgentTask`/`closeAgentTask`/`cancelAgentTask`; server.ts 라우트 전부. Task 8 UI가 라우트 호출.

- [ ] **Step 1: 실패하는 API 테스트 작성** (`tests/control-tower-playbook-api.test.ts` 신규 — control-tower-api.test.ts의 stub bridge·startTower 헬퍼를 같은 형태로 복제)

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTowerServer } from '../apps/control-tower/src/server.js';

const TOOLS = { tools: [
  { name: 'p.read', description: 'r', inputSchema: { type: 'object', properties: { host: { type: 'string' } } }, annotations: { title: 'r', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
  { name: 'p.write', description: 'w', inputSchema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }, annotations: { title: 'w', readOnlyHint: false, destructiveHint: false }, category: 'pm' },
] };

let bridge: http.Server, bridgeUrl: string, runsDir: string, registryDir: string, outDir: string, tower: http.Server, towerUrl: string;

function startBridge(): Promise<void> {
  bridge = http.createServer(async (req, res) => {
    const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') return send(200, TOOLS);
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const payload = body.name === 'p.read'
        ? { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 1, fail: 0 }, coverage: {} } }
        : { created: true };
      return send(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
    }
    send(404, { error: 'nf' });
  });
  return new Promise((r) => bridge.listen(0, '127.0.0.1', () => { bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`; r(); }));
}
const urlOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
async function call(method: string, path: string, body?: unknown, base?: string, token = 'test-token') {
  const res = await fetch(`${base ?? towerUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
function startTower(): Promise<http.Server> {
  const s = createTowerServer({ bridgeUrl, runsDir, registryDir, playbookOutputDir: outDir, approvalSecret: 'sec', apiToken: 'test-token', mockConsoleUrl: 'http://127.0.0.1:1' });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'pbapi-runs-'));
  registryDir = mkdtempSync(join(tmpdir(), 'pbapi-reg-'));
  outDir = mkdtempSync(join(tmpdir(), 'pbapi-out-'));
  await startBridge();
  tower = await startTower();
  towerUrl = urlOf(tower);
});
afterEach(async () => {
  await new Promise<void>((r) => tower.close(() => r()));
  await new Promise<void>((r) => bridge.close(() => r()));
  for (const d of [runsDir, registryDir, outDir]) rmSync(d, { recursive: true, force: true });
});

const READ_REPORT = [
  { id: 'b1', type: 'tool', toolId: 'p.read', args: { host: 'h' } },
  { id: 'r1', type: 'report' },
];

describe('Playbook API — 조립·검증·실행 (T-PB-5)', () => {
  it('조립(draft 400 검증) → 승인 → 실행, draft 실행은 403', async () => {
    const bad = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: [] });
    expect(bad.status).toBe(400);
    const created = await call('POST', '/api/playbooks', { name: '자문', goal: '전체분석', authoredBy: 'agent:claude', blocks: READ_REPORT });
    expect(created.status).toBe(200);
    const pbId = String((created.body as { id: string }).id);
    // 승인 전 실행 → 403
    expect((await call('POST', `/api/playbooks/${pbId}/execute`, {})).status).toBe(403);
    // 승인
    const approved = await call('POST', `/api/playbooks/${pbId}/revisions/1/approve`, { reviewedBy: 'jmpark' });
    expect(approved.status).toBe(200);
    // 실행 → succeeded
    const run = await call('POST', `/api/playbooks/${pbId}/execute`, {});
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('succeeded');
    const pbrunId = String(run.body.playbookRunId);
    // playbook-run 조회 (유도 상태 + 블록 매핑 + 분석 목록)
    const detail = await call('GET', `/api/playbook-runs/${pbrunId}`);
    expect(detail.body.status).toBe('succeeded');
    expect((detail.body.blocks as unknown[]).length).toBe(2);
    expect(detail.body.analyses).toEqual([]);
    // 블록 run은 일반 이력에도 playbookRunId 필터로 보인다
    const listed = await call('GET', `/api/runs?playbookRunId=${pbrunId}`);
    expect((listed.body.runs as unknown[]).length).toBe(2);
  });

  it('리비전 diff용 데이터 형태: revisions 배열에 blocks·status·rejectReason', async () => {
    const created = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: READ_REPORT });
    const pbId = String((created.body as { id: string }).id);
    await call('POST', `/api/playbooks/${pbId}/revisions/1/reject`, { reviewedBy: 'j', reason: 'HA 누락' });
    const r2 = await call('POST', `/api/playbooks/${pbId}/revisions`, { authoredBy: 'agent:claude', note: '반영', blocks: READ_REPORT });
    const pb = r2.body as { revisions: Array<{ rev: number; status: string; rejectReason?: string; blocks: unknown[] }> };
    expect(pb.revisions).toHaveLength(2);
    expect(pb.revisions[0].status).toBe('rejected');
    expect(pb.revisions[0].rejectReason).toBe('HA 누락');
    expect(pb.revisions[1].blocks).toHaveLength(2);
    // reason 없는 reject → 400
    const c2 = await call('POST', '/api/playbooks', { name: 'y', goal: 'g', authoredBy: 'a', blocks: READ_REPORT });
    expect((await call('POST', `/api/playbooks/${String((c2.body as { id: string }).id)}/revisions/1/reject`, { reviewedBy: 'j' })).status).toBe(400);
  });

  it('agent-task 큐 왕복: 생성 → open 폴 → close(결과)', async () => {
    const t = await call('POST', '/api/agent-tasks', { kind: 'assemble', payload: { goal: '전체분석' } });
    const taskId = String((t.body as { id: string }).id);
    expect((await call('GET', '/api/agent-tasks?status=open')).body.tasks).toHaveLength(1);
    const closed = await call('PATCH', `/api/agent-tasks/${taskId}`, { result: { playbookId: 'pb_1', rev: 1 } });
    expect((closed.body as { status: string }).status).toBe('done');
    expect((await call('GET', '/api/agent-tasks?status=open')).body.tasks).toHaveLength(0);
    // cancel 경로
    const t2 = await call('POST', '/api/agent-tasks', { kind: 'analyze', payload: { playbookRunId: 'pbrun_1' } });
    const cancelled = await call('PATCH', `/api/agent-tasks/${String((t2.body as { id: string }).id)}`, { cancel: true });
    expect((cancelled.body as { status: string }).status).toBe('cancelled');
  });

  it('분석 제출 → verdict 채택(제안에 linkedPlaybookId)', async () => {
    // 실행 하나 만들어 playbookRunId 확보
    const created = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: READ_REPORT });
    const pbId = String((created.body as { id: string }).id);
    await call('POST', `/api/playbooks/${pbId}/revisions/1/approve`, { reviewedBy: 'j' });
    const run = await call('POST', `/api/playbooks/${pbId}/execute`, {});
    const pbrunId = String(run.body.playbookRunId);
    const submitted = await call('POST', `/api/playbook-runs/${pbrunId}/analysis`, {
      playbookId: pbId, playbookRunId: pbrunId, summary: 'HA 미설정', authoredBy: 'agent:claude',
      improvements: [{ observation: 'HA off', recommendation: 'HA 설정' }],
      proposals: [{ action: 'HA 플레이북', rationale: '가용성' }],
    });
    expect(submitted.status).toBe(200);
    const anlId = String((submitted.body as { id: string }).id);
    const verdict = await call('POST', `/api/analyses/${anlId}/verdict`, { part: 'proposals', index: 0, verdict: 'accepted', reviewedBy: 'jmpark', linkedPlaybookId: 'pb_next' });
    expect((verdict.body as { proposals: Array<{ verdict: string; linkedPlaybookId: string }> }).proposals[0].verdict).toBe('accepted');
    expect((verdict.body as { proposals: Array<{ linkedPlaybookId: string }> }).proposals[0].linkedPlaybookId).toBe('pb_next');
    // 재조회 시 분석이 playbook-run 상세에 붙는다
    expect((await call('GET', `/api/playbook-runs/${pbrunId}`)).body.analyses).toHaveLength(1);
    // 범위 밖 verdict → 400
    expect((await call('POST', `/api/analyses/${anlId}/verdict`, { part: 'improvements', index: 9, verdict: 'accepted', reviewedBy: 'x' })).status).toBe(400);
  });

  it('GET /api/playbooks 목록: activeRev + lastRun 유도상태', async () => {
    const created = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: READ_REPORT });
    const pbId = String((created.body as { id: string }).id);
    await call('POST', `/api/playbooks/${pbId}/revisions/1/approve`, { reviewedBy: 'j' });
    await call('POST', `/api/playbooks/${pbId}/execute`, {});
    const list = await call('GET', '/api/playbooks');
    const row = (list.body.playbooks as Array<{ id: string; activeRev?: number; lastRun?: { status: string } }>).find((p) => p.id === pbId)!;
    expect(row.activeRev).toBe(1);
    expect(row.lastRun!.status).toBe('succeeded');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-api.test.ts`
Expected: FAIL — 라우트·위임 메서드 미존재(404).

- [ ] **Step 3: 위임 메서드 추가** (`api.ts`의 `return { ... }` 안, `executePlaybook` 앞에 추가)

```ts
    listPlaybooks(): { playbooks: Array<Playbook & { activeRev?: number; lastRun?: { playbookRunId: string; status: PlaybookRunStatus } }> } {
      return {
        playbooks: playbooks.list().map((pb) => {
          const active = playbooks.activeRevision(pb);
          // 최근 실행: 이 플레이북 태그가 붙은 가장 최신 블록 run의 playbookRunId로 유도
          const latest = store.listRuns({ ...PB_LIMIT }).find((r) => r.playbookId === pb.id && r.playbookRunId);
          let lastRun: { playbookRunId: string; status: PlaybookRunStatus } | undefined;
          if (latest?.playbookRunId && active) {
            const rev = pb.revisions.find((r) => r.rev === latest.playbookRev) ?? active;
            lastRun = { playbookRunId: latest.playbookRunId, status: derivePlaybookRunStatus(rev, blockRunsOf(latest.playbookRunId)).status };
          }
          return { ...pb, activeRev: active?.rev, lastRun };
        }),
      };
    },

    createPlaybook(input: { name: string; goal: string; blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Playbook {
      try { return playbooks.create(input); }
      catch (error) { throw asApiError(error); }
    },

    getPlaybook(id: string): Playbook {
      const pb = playbooks.get(id);
      if (!pb) throw new ApiError(404, `unknown playbook: ${id}`);
      return pb;
    },

    addPlaybookRevision(id: string, input: { blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Playbook {
      try { return playbooks.addRevision(id, input); }
      catch (error) { throw asApiError(error); }
    },

    reviewPlaybookRevision(id: string, rev: number, verdict: { approve: boolean; reviewedBy: string; rejectReason?: string }): Playbook {
      try { return playbooks.reviewRevision(id, rev, verdict); }
      catch (error) { throw asApiError(error); }
    },

    submitAnalysis(playbookRunId: string, input: Omit<PlaybookAnalysis, 'id' | 'createdAt' | 'schemaVersion'>): PlaybookAnalysis {
      // 존재하는 실행인지 확인 (정보 격리: 임의 playbookRunId로 분석 주입 방지)
      this.getPlaybookRun(playbookRunId);
      return analyses.append({ ...input, playbookRunId, schemaVersion: 1 } as PlaybookAnalysis);
    },

    setAnalysisVerdict(id: string, input: { part: 'improvements' | 'proposals'; index: number; verdict: AnalysisVerdict; reviewedBy: string; linkedPlaybookId?: string }): PlaybookAnalysis {
      try { return analyses.setVerdict(id, input.part, input.index, input.verdict, input.reviewedBy, input.linkedPlaybookId); }
      catch (error) { throw asApiError(error); }
    },

    listAgentTasks(status?: AgentTask['status']): { tasks: AgentTask[] } {
      return { tasks: agentTasks.list(status) };
    },

    createAgentTask(input: { kind: AgentTask['kind']; payload: AgentTask['payload'] }): AgentTask {
      return agentTasks.create(input);
    },

    closeAgentTask(id: string, result: AgentTask['result']): AgentTask {
      try { return agentTasks.close(id, result); }
      catch (error) { throw asApiError(error); }
    },

    cancelAgentTask(id: string): AgentTask {
      try { return agentTasks.cancel(id); }
      catch (error) { throw asApiError(error); }
    },
```

`submitAnalysis`가 `this.getPlaybookRun`을 부른다 — 이 코드베이스의 `return { ... }` 메서드는 화살표가 아니라 축약 메서드이므로 `this`가 반환 객체를 가리킨다(`overview`가 이미 `this.health()`를 사용하는 것과 동일 패턴, api.ts 참조). 유지.

`asApiError` 헬퍼를 `createApi` 안(엔진 프리미티브 근처)에 추가 — `PlaybookValidationError.status`를 ApiError로 매핑:

```ts
  function asApiError(error: unknown): ApiError {
    if (error instanceof PlaybookValidationError) return new ApiError(error.status, error.message);
    if (error instanceof ApiError) return error;
    return new ApiError(500, error instanceof Error ? error.message : String(error));
  }
```

- [ ] **Step 4: server.ts 라우트 추가** (`apps/control-tower/src/server.ts`)

`GET /api/runs` 블록 다음(runMatch 처리 앞)에 플레이북 라우트 블록을 추가한다. 정규식 매칭 순서 주의 — 더 구체적인 경로를 먼저 둔다:

```ts
      // ── 플레이북 라우트 (§5.4) ──
      if (method === 'GET' && path === '/api/playbooks') return json(res, api.listPlaybooks());
      if (method === 'POST' && path === '/api/playbooks') {
        const b = await readJsonBody(req);
        return json(res, api.createPlaybook({
          name: String(b.name ?? ''), goal: String(b.goal ?? ''), authoredBy: String(b.authoredBy ?? ''),
          note: typeof b.note === 'string' ? b.note : undefined,
          blocks: Array.isArray(b.blocks) ? (b.blocks as PlaybookBlock[]) : [],
        }));
      }
      const pbRevApprove = path.match(/^\/api\/playbooks\/([^/]+)\/revisions\/(\d+)\/approve$/);
      if (method === 'POST' && pbRevApprove) {
        const b = await readJsonBody(req);
        return json(res, api.reviewPlaybookRevision(pbRevApprove[1], Number(pbRevApprove[2]), { approve: true, reviewedBy: String(b.reviewedBy ?? '') }));
      }
      const pbRevReject = path.match(/^\/api\/playbooks\/([^/]+)\/revisions\/(\d+)\/reject$/);
      if (method === 'POST' && pbRevReject) {
        const b = await readJsonBody(req);
        return json(res, api.reviewPlaybookRevision(pbRevReject[1], Number(pbRevReject[2]), { approve: false, reviewedBy: String(b.reviewedBy ?? ''), rejectReason: typeof b.reason === 'string' ? b.reason : undefined }));
      }
      const pbRevisions = path.match(/^\/api\/playbooks\/([^/]+)\/revisions$/);
      if (method === 'POST' && pbRevisions) {
        const b = await readJsonBody(req);
        return json(res, api.addPlaybookRevision(pbRevisions[1], {
          authoredBy: String(b.authoredBy ?? ''), note: typeof b.note === 'string' ? b.note : undefined,
          blocks: Array.isArray(b.blocks) ? (b.blocks as PlaybookBlock[]) : [],
        }));
      }
      const pbExecute = path.match(/^\/api\/playbooks\/([^/]+)\/execute$/);
      if (method === 'POST' && pbExecute) return json(res, await api.executePlaybook(pbExecute[1]));
      const pbGet = path.match(/^\/api\/playbooks\/([^/]+)$/);
      if (method === 'GET' && pbGet) return json(res, api.getPlaybook(pbGet[1]));

      const pbRunAnalysis = path.match(/^\/api\/playbook-runs\/([^/]+)\/analysis$/);
      if (method === 'POST' && pbRunAnalysis) {
        const b = await readJsonBody(req);
        return json(res, api.submitAnalysis(pbRunAnalysis[1], {
          playbookId: String(b.playbookId ?? ''), playbookRunId: pbRunAnalysis[1],
          summary: String(b.summary ?? ''), authoredBy: String(b.authoredBy ?? ''),
          improvements: Array.isArray(b.improvements) ? (b.improvements as never[]) : [],
          proposals: Array.isArray(b.proposals) ? (b.proposals as never[]) : [],
        }));
      }
      const pbRunGet = path.match(/^\/api\/playbook-runs\/([^/]+)$/);
      if (method === 'GET' && pbRunGet) return json(res, api.getPlaybookRun(pbRunGet[1]));

      const anlVerdict = path.match(/^\/api\/analyses\/([^/]+)\/verdict$/);
      if (method === 'POST' && anlVerdict) {
        const b = await readJsonBody(req);
        return json(res, api.setAnalysisVerdict(anlVerdict[1], {
          part: b.part === 'proposals' ? 'proposals' : 'improvements',
          index: Number(b.index), verdict: b.verdict === 'dismissed' ? 'dismissed' : 'accepted',
          reviewedBy: String(b.reviewedBy ?? ''), linkedPlaybookId: typeof b.linkedPlaybookId === 'string' ? b.linkedPlaybookId : undefined,
        }));
      }

      if (method === 'GET' && path === '/api/agent-tasks') {
        const status = url.searchParams.get('status');
        return json(res, api.listAgentTasks(status ? (status as AgentTask['status']) : undefined));
      }
      if (method === 'POST' && path === '/api/agent-tasks') {
        const b = await readJsonBody(req);
        return json(res, api.createAgentTask({ kind: b.kind as AgentTask['kind'], payload: (b.payload && typeof b.payload === 'object' ? b.payload : {}) as AgentTask['payload'] }));
      }
      const ataskPatch = path.match(/^\/api\/agent-tasks\/([^/]+)$/);
      if (method === 'PATCH' && ataskPatch) {
        const b = await readJsonBody(req);
        if (b.cancel === true) return json(res, api.cancelAgentTask(ataskPatch[1]));
        return json(res, api.closeAgentTask(ataskPatch[1], (b.result && typeof b.result === 'object' ? b.result : {}) as AgentTask['result']));
      }
```

server.ts 상단에 타입 import 추가 (기존 `import type { RunStatus }` 줄 옆):

```ts
import type { RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import type { PlaybookBlock, AgentTask } from './playbook-store.js';
```

- [ ] **Step 5: 통과 확인 + 무회귀**

Run: `pnpm exec vitest run tests/control-tower-playbook-api.test.ts`
Expected: PASS (T-PB-5).
Run: `npm test` → 전체 PASS (v1 무회귀 포함). `npm run lint` → 0.

- [ ] **Step 6: 커밋**

```bash
git add apps/control-tower/src/api.ts apps/control-tower/src/server.ts tests/control-tower-playbook-api.test.ts
git commit -m "feat(control-tower): playbook API routes + CRUD/analysis/agent-task delegation (T-PB-5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 재시작 재해석 폴백 (approveRun 접점 #1) (T-PB-6)

**Files:**
- Modify: `apps/control-tower/src/api.ts` (`approveRun`의 원본인자 소실 분기에 재해석 폴백 추가 + `reinterpretBlockArgs` 클로저)
- Test: `tests/control-tower-playbook-api.test.ts` (재개 describe 추가 — T-PB-6)

**Interfaces:**
- Consumes: Task 5 엔진(`resolveTemplates`/`resolveBlockArgs` 로직), v1 `originalArgs`.
- Produces: 타워 재시작(originalArgs 소실) 후에도 playbookRunId 있는 write 승인이 리비전+영속결과에서 args를 결정적으로 복원해 성공. playbookRunId **없는** run은 기존 400 유지(무회귀).

**핵심 (스펙 §5.3 접점 #1):** v1 `approveRun`은 `originalArgs` 맵에 args가 없으면 400을 던진다(타워 재시작 시 마스킹본 실행 방지). 플레이북 write run은 예외 — 리비전 블록의 args를 템플릿·병합 재해석으로 복원한다. 영속된 resultJson·리비전이 불변이므로 승인자가 본 것과 동일함이 보장된다.

- [ ] **Step 1: 실패하는 재개 테스트 추가** (`tests/control-tower-playbook-api.test.ts` 하단에 append — 위 헬퍼 재사용)

```ts
describe('Playbook API — 재개·재시작 (T-PB-6)', () => {
  const WRITE_REPORT = [
    { id: 'b1', type: 'tool', toolId: 'p.read', args: { host: 'h' } },
    { id: 'b2', type: 'tool', toolId: 'p.write', args: { customer: 'acme' } },
    { id: 'r1', type: 'report' },
  ];

  async function seedRunToWaiting(): Promise<{ pbId: string; pbrunId: string; pendingRunId: string }> {
    const created = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: WRITE_REPORT });
    const pbId = String((created.body as { id: string }).id);
    await call('POST', `/api/playbooks/${pbId}/revisions/1/approve`, { reviewedBy: 'j' });
    const run = await call('POST', `/api/playbooks/${pbId}/execute`, {});
    expect(run.body.status).toBe('waiting_approval');
    const pbrunId = String(run.body.playbookRunId);
    const pendingRunId = String((await call('GET', `/api/runs?playbookRunId=${pbrunId}`)).body.runs
      ? ((await call('GET', `/api/playbook-runs/${pbrunId}`)).body.blocks as Array<{ blockId: string; runId?: string }>).find((x) => x.blockId === 'b2')!.runId
      : '');
    return { pbId, pbrunId, pendingRunId };
  }

  it('write 승인 → continueRun으로 report까지 → succeeded', async () => {
    const { pbrunId, pendingRunId } = await seedRunToWaiting();
    const approved = await call('POST', `/api/runs/${pendingRunId}/approve`, { approvedBy: 'jmpark' });
    expect(approved.status).toBe(200);
    expect((await call('GET', `/api/playbook-runs/${pbrunId}`)).body.status).toBe('succeeded');
  });

  it('타워 재시작(새 서버 인스턴스) 후 승인 → 재해석 폴백으로 성공', async () => {
    const { pbrunId, pendingRunId } = await seedRunToWaiting();
    // 타워만 재시작 (같은 dirs, 새 createApi → originalArgs 맵 비어있음)
    await new Promise<void>((r) => tower.close(() => r()));
    tower = await startTower();
    const restarted = urlOf(tower);
    const approved = await call('POST', `/api/runs/${pendingRunId}/approve`, { approvedBy: 'jmpark' }, restarted);
    expect(approved.status).toBe(200); // 400 아님 — 재해석 성공
    expect((await call('GET', `/api/playbook-runs/${pbrunId}`, undefined, restarted)).body.status).toBe('succeeded');
  });

  it('playbookRunId 없는 pending의 재시작 후 승인은 여전히 400 (v1 무회귀)', async () => {
    // 단일 도구 write (플레이북 아님)
    const created = await call('POST', '/api/runs', { toolId: 'p.write', args: { customer: 'acme' } });
    const runId = String((created.body as { runId: string }).runId);
    await new Promise<void>((r) => tower.close(() => r()));
    tower = await startTower();
    const r = await call('POST', `/api/runs/${runId}/approve`, { approvedBy: 'x' }, urlOf(tower));
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/원본 인자 소실/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-api.test.ts -t "T-PB-6"`
Expected: 재시작 케이스 FAIL — 현재 approveRun은 playbook run도 400을 던진다.

- [ ] **Step 3: reinterpretBlockArgs 클로저 추가** (`api.ts`의 `continueFromApprove` 근처)

```ts
  // 접점 #1: 타워 재시작으로 originalArgs가 소실된 playbook write run의 args를
  // 리비전 블록 + 영속 결과에서 결정적으로 복원. 영속본이 불변이라 승인자가 본 것과 동일.
  async function reinterpretBlockArgs(record: RunRecord): Promise<Record<string, unknown>> {
    if (!record.playbookRunId || !record.playbookId || record.playbookRev === undefined || !record.blockId) {
      throw new ApiError(400, '원본 인자 소실 — 재요청 필요');
    }
    const pb = playbooks.get(record.playbookId);
    const rev = pb?.revisions.find((r) => r.rev === record.playbookRev);
    const block = rev?.blocks.find((b) => b.id === record.blockId);
    if (!pb || !rev || !block) throw new ApiError(409, '재해석 실패: 플레이북/리비전/블록 소실');
    const tools = await listBridgeTools();
    const tool = tools.find((t) => t.name === record.toolId);
    if (!tool) throw new ApiError(409, `재해석 실패: unknown tool ${record.toolId}`);
    return resolveBlockArgs(block, record.playbookRunId, tool);
  }
```

- [ ] **Step 4: approveRun 원본인자 소실 분기 교체** (`api.ts`의 `approveRun`)

기존:

```ts
      const args = originalArgs.get(runId);
      if (!args) throw new ApiError(400, '원본 인자 소실 — 재요청 필요');
```

교체 후 (`args`를 `let`으로, playbook run이면 재해석):

```ts
      let args = originalArgs.get(runId);
      if (!args) {
        // playbook write run은 재해석 폴백. 단일 도구 run은 기존대로 400 (마스킹본 실행 방지 · 무회귀).
        args = await reinterpretBlockArgs(record);
      }
```

`reinterpretBlockArgs`는 playbookRunId 없는 run이면 400을 그대로 던지므로 v1 무회귀가 유지된다.

- [ ] **Step 5: 통과 확인 + 무회귀**

Run: `pnpm exec vitest run tests/control-tower-playbook-api.test.ts`
Expected: PASS (T-PB-5·6 전부).
Run: `pnpm exec vitest run tests/control-tower-api.test.ts` → v1 승인/재시작 케이스 무회귀 PASS (특히 "타워 재시작 시 원본 인자 소실 → 승인 400").
Run: `npm test` 전체 PASS · `npm run lint` 0.

- [ ] **Step 6: 커밋**

```bash
git add apps/control-tower/src/api.ts tests/control-tower-playbook-api.test.ts
git commit -m "feat(control-tower): restart-safe write approval via block-args reinterpretation (T-PB-6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: UI 플레이북 패널 (ui.ts)

**Files:**
- Modify: `apps/control-tower/src/ui.ts` (네비 버튼 1 + 패널 1 + 클라이언트 JS 함수군)
- Test: `tests/control-tower-playbook-api.test.ts`의 UI 서빙 케이스 1개 추가(HTML에 한국어 레이블 포함 확인 — 렌더 로직은 수동 검증 §12)

**Interfaces:**
- Consumes: Task 6 라우트 전부.
- Produces: 플레이북 목록/상세/실행/분석 UI. **UI 제약 재확인:** 클라이언트 JS는 문자열 연결(+)만, backtick·`${` 금지.

- [ ] **Step 1: HTML 서빙 테스트 추가** (`tests/control-tower-playbook-api.test.ts` 하단)

```ts
describe('Playbook UI 서빙', () => {
  it('GET /는 플레이북 네비·패널 레이블을 포함한다', async () => {
    const res = await fetch(`${towerUrl}/`);
    const html = await res.text();
    expect(html).toContain('플레이북');
    expect(html).toContain('AI 조립 요청');
    expect(html).toContain('loadPlaybooks');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/control-tower-playbook-api.test.ts -t "UI 서빙"`
Expected: FAIL — ui.ts에 플레이북 마크업 없음.

- [ ] **Step 3: 네비 버튼 추가** (`ui.ts`의 `<nav id="nav">` 안, `장비 관리` 버튼 다음)

```html
      <button data-panel="devices">장비 관리</button>
      <button data-panel="playbooks">플레이북</button>
```

- [ ] **Step 4: 패널 마크업 추가** (`ui.ts`의 `<div id="devices" class="panel">...</div>` 닫는 태그 다음, `</section>` 앞)

```html
      <div id="playbooks" class="panel">
        <div class="row2">
          <div class="card">
            <h3>플레이북 목록</h3>
            <button class="primary" onclick="requestAssemble()">AI 조립 요청</button>
            <table id="pb-table" style="margin-top:10px"><thead><tr><th>이름</th><th>목표</th><th>활성rev</th><th>최근실행</th></tr></thead><tbody></tbody></table>
            <h3 style="margin-top:16px">에이전트 작업 큐 (open)</h3>
            <div id="pb-tasks" class="meta">로딩…</div>
          </div>
          <div class="card">
            <h3 id="pb-detail-title">플레이북 선택 대기</h3>
            <div id="pb-detail" class="meta">좌측에서 선택하세요.</div>
          </div>
        </div>
      </div>
```

- [ ] **Step 5: 네비 디스패치에 플레이북 추가** (`ui.ts`의 navButtons 클릭 핸들러 안)

```ts
      if (btn.dataset.panel === 'devices') loadDevices();
      if (btn.dataset.panel === 'playbooks') loadPlaybooks();
```

- [ ] **Step 6: 클라이언트 JS 함수군 추가** (`ui.ts`의 `loadOverview();` 호출 직전, `// ── 장비 관리 ──` 블록 뒤)

전부 문자열 연결(+)만 사용한다. backtick·`${` 금지.

```ts
  // ── 플레이북 ──
  var pbCache = {};
  window.loadPlaybooks = function () {
    Promise.all([req('GET', '/api/playbooks'), req('GET', '/api/agent-tasks?status=open')]).then(function (res) {
      var pbs = res[0].playbooks || [];
      pbCache = {};
      document.querySelector('#pb-table tbody').innerHTML = pbs.map(function (p) {
        pbCache[p.id] = p;
        var last = p.lastRun ? statusHtml(p.lastRun.status) : '<span class="meta">-</span>';
        return '<tr class="clickable" onclick="showPlaybook(\'' + esc(p.id) + '\')"><td>' + esc(p.name) + '</td><td class="meta">' + esc(p.goal).slice(0, 40) + '</td><td>' + (p.activeRev == null ? '-' : 'rev ' + p.activeRev) + '</td><td>' + last + '</td></tr>';
      }).join('');
      var tasks = res[1].tasks || [];
      $('pb-tasks').innerHTML = tasks.length === 0 ? '없음' : tasks.map(function (t) {
        return '<div style="margin:4px 0"><strong>' + esc(t.kind) + '</strong> <span class="meta">' + esc(JSON.stringify(t.payload)).slice(0, 80) + '</span> <button class="small" onclick="cancelTask(\'' + esc(t.id) + '\')">취소</button></div>';
      }).join('');
    }).catch(fail);
  };
  window.requestAssemble = function () {
    var goal = prompt('조립 목표 (goal)');
    if (!goal) return;
    req('POST', '/api/agent-tasks', { kind: 'assemble', payload: { goal: goal } })
      .then(function () { alert('AI 조립 요청을 큐에 등록했습니다. 에이전트가 draft를 제출하면 목록에 나타납니다.'); loadPlaybooks(); }).catch(fail);
  };
  window.cancelTask = function (id) {
    req('PATCH', '/api/agent-tasks/' + id, { cancel: true }).then(loadPlaybooks).catch(fail);
  };
  window.showPlaybook = function (id) {
    req('GET', '/api/playbooks/' + id).then(function (pb) {
      $('pb-detail-title').textContent = pb.name;
      var active = null;
      for (var i = pb.revisions.length - 1; i >= 0; i--) { if (pb.revisions[i].status === 'approved') { active = pb.revisions[i].rev; break; } }
      var html = '<div class="meta">' + esc(pb.goal) + '</div>';
      html += pb.revisions.map(function (r) { return renderRevision(pb.id, r, active); }).join('');
      html += '<div style="margin-top:10px"><button class="primary" ' + (active == null ? 'disabled' : '') + ' onclick="executePlaybook(\'' + esc(pb.id) + '\')">실행</button>';
      html += '<button class="small" onclick="requestRevise(\'' + esc(pb.id) + '\')" style="margin-left:8px">AI 수정 요청</button></div>';
      html += '<div id="pb-run" style="margin-top:12px"></div>';
      $('pb-detail').innerHTML = html;
    }).catch(fail);
  };
  function renderRevision(pbId, r, activeRev) {
    var badge = r.status === 'approved' ? '<span class="hl-ok">승인 rev ' + r.rev + '</span>'
      : r.status === 'rejected' ? '<span class="hl-bad">반려 rev ' + r.rev + '</span>'
      : '<span class="st-pending_approval">draft rev ' + r.rev + '</span>';
    var s = '<div class="card" style="margin:8px 0;padding:10px"><div>' + badge + (r.rev === activeRev ? ' <span class="badge sf-read_only">활성</span>' : '') + '</div>';
    s += '<div class="meta">' + (r.blocks || []).map(function (b) {
      return b.type === 'report' ? '📄 ' + esc(b.title || 'report') : '🔧 ' + esc(b.title || b.toolId) + (b.deviceId ? ' @' + esc(b.deviceId) : '');
    }).join(' → ') + '</div>';
    if (r.note) s += '<div class="meta">note: ' + esc(r.note) + '</div>';
    if (r.rejectReason) s += '<div class="hl-bad">반려사유: ' + esc(r.rejectReason) + '</div>';
    if (r.status === 'draft') {
      s += '<button class="small" onclick="reviewRev(\'' + esc(pbId) + '\',' + r.rev + ',true)">승인</button>';
      s += '<button class="small" onclick="reviewRev(\'' + esc(pbId) + '\',' + r.rev + ',false)">반려</button>';
    }
    return s + '</div>';
  }
  window.reviewRev = function (pbId, rev, approve) {
    var by = prompt('검토자 ID (reviewedBy)'); if (!by) return;
    var body = { reviewedBy: by };
    var path = '/api/playbooks/' + pbId + '/revisions/' + rev + (approve ? '/approve' : '/reject');
    if (!approve) { var reason = prompt('반려 사유'); if (!reason) return; body.reason = reason; }
    req('POST', path, body).then(function () { showPlaybook(pbId); loadPlaybooks(); }).catch(fail);
  };
  window.executePlaybook = function (pbId) {
    req('POST', '/api/playbooks/' + pbId + '/execute', {}).then(function (run) { renderRun(run.playbookRunId); }).catch(fail);
  };
  window.renderRun = function (pbrunId) {
    req('GET', '/api/playbook-runs/' + pbrunId).then(function (run) {
      var color = { succeeded: 'hl-ok', failed: 'hl-bad', partial: 'st-pending_approval', waiting_approval: 'st-pending_approval', running: 'st-running' };
      var h = '<div class="card" style="padding:10px"><div>실행 <span class="' + (color[run.status] || '') + '">' + esc(run.status) + '</span> <span class="meta">' + esc(pbrunId) + '</span></div>';
      h += '<div>' + run.blocks.map(function (b) {
        var st = b.status || '대기';
        var btn = b.status === 'pending_approval' ? ' <button class="small" onclick="approveBlock(\'' + esc(b.runId) + '\',\'' + esc(pbrunId) + '\')">승인</button><button class="small" onclick="rejectBlock(\'' + esc(b.runId) + '\',\'' + esc(pbrunId) + '\')">거부</button>' : '';
        return '<div class="meta">' + esc(b.blockId) + ': ' + statusHtml(st) + btn + '</div>';
      }).join('') + '</div>';
      h += '<button class="small" onclick="requestAnalyze(\'' + esc(pbrunId) + '\')">AI 분석 요청</button>';
      h += (run.analyses || []).map(function (a) { return renderAnalysis(a); }).join('');
      $('pb-run').innerHTML = h + '</div>';
    }).catch(fail);
  };
  window.approveBlock = function (runId, pbrunId) {
    var by = prompt('승인자 (approvedBy)'); if (!by) return;
    req('POST', '/api/runs/' + runId + '/approve', { approvedBy: by }).then(function () { renderRun(pbrunId); }).catch(fail);
  };
  window.rejectBlock = function (runId, pbrunId) {
    var reason = prompt('거부 사유'); if (!reason) return;
    req('POST', '/api/runs/' + runId + '/reject', { reason: reason }).then(function () { renderRun(pbrunId); }).catch(fail);
  };
  function renderAnalysis(a) {
    var s = '<div class="card" style="margin-top:8px;padding:10px"><div><strong>분석</strong> <span class="meta">' + esc(a.summary) + '</span></div>';
    s += (a.improvements || []).map(function (im, i) { return verdictRow(a.id, 'improvements', i, im.recommendation, im.verdict); }).join('');
    s += (a.proposals || []).map(function (pr, i) { return verdictRow(a.id, 'proposals', i, pr.action, pr.verdict); }).join('');
    return s + '</div>';
  }
  function verdictRow(anlId, part, index, label, verdict) {
    var done = verdict ? ' <span class="meta">(' + esc(verdict) + ')</span>' : '';
    var btns = verdict ? '' : '<button class="small" onclick="setVerdict(\'' + esc(anlId) + '\',\'' + part + '\',' + index + ',true)">채택</button><button class="small" onclick="setVerdict(\'' + esc(anlId) + '\',\'' + part + '\',' + index + ',false)">기각</button>';
    return '<div class="meta" style="margin:3px 0">[' + part + '] ' + esc(label) + done + ' ' + btns + '</div>';
  }
  window.setVerdict = function (anlId, part, index, accept) {
    var by = prompt('검토자'); if (!by) return;
    var body = { part: part, index: index, verdict: accept ? 'accepted' : 'dismissed', reviewedBy: by };
    if (accept && part === 'proposals') { var link = prompt('연결할 후속 플레이북 id (선택)'); if (link) body.linkedPlaybookId = link; }
    req('POST', '/api/analyses/' + anlId + '/verdict', body).then(function (a) {
      var pbrunId = a.playbookRunId; renderRun(pbrunId);
    }).catch(fail);
  };
  window.requestRevise = function (pbId) {
    var fb = prompt('수정 피드백 (feedback)'); if (!fb) return;
    req('POST', '/api/agent-tasks', { kind: 'revise', payload: { playbookId: pbId, feedback: fb } })
      .then(function () { alert('AI 수정 요청을 등록했습니다.'); loadPlaybooks(); }).catch(fail);
  };
  window.requestAnalyze = function (pbrunId) {
    req('POST', '/api/agent-tasks', { kind: 'analyze', payload: { playbookRunId: pbrunId } })
      .then(function () { alert('AI 분석 요청을 등록했습니다. 에이전트가 분석을 제출하면 이 화면에 나타납니다.'); }).catch(fail);
  };
```

- [ ] **Step 7: 통과 확인 + 무회귀**

Run: `pnpm exec vitest run tests/control-tower-playbook-api.test.ts -t "UI 서빙"` → PASS.
Run: `pnpm exec vitest run tests/control-tower-api.test.ts -t "Tower UI 서빙"` → v1 UI 무회귀 PASS.
Run: `npm run lint` → 0 (ui.ts는 문자열 템플릿이라 tsc가 JS 문법 오류는 못 잡는다 — Step 8에서 실기동으로 검증).

- [ ] **Step 8: 실기동 스모크 (backtick/`${` 혼입 시 여기서 드러난다)**

```bash
MCP_NO_SERVE=1 pnpm exec tsx -e "import('./apps/control-tower/src/ui.js').then(function(m){ var h=m.dashboardHtml(); if(h.indexOf('loadPlaybooks')<0) throw new Error('missing panel'); console.log('ui ok', h.length); })"
```
Expected: `ui ok <숫자>` 출력. 에러 시 클라이언트 JS의 backtick/`${` 혼입 점검.

- [ ] **Step 9: 커밋**

```bash
git add apps/control-tower/src/ui.ts tests/control-tower-playbook-api.test.ts
git commit -m "feat(control-tower): playbook UI panel — assemble/review/execute/analyze (vanilla JS)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: E2E 협업 루프 (T-PB-7) + .gitignore + 최종 검증

**Files:**
- Modify: `tests/control-tower-e2e.test.ts` (T-PB-7 describe 추가 — 기존 T-INT-1·2는 무수정)
- Modify: `.gitignore` (`outputs/playbooks/` 추가)
- 신규 코드 없음. 발견된 결함만 수정.

**Interfaces:**
- Consumes: 전 태스크 산출물. `createApi`를 in-process로 구동(control-tower-e2e.test.ts의 실 guard bridge 스타일 재사용 가능하나, T-PB-7은 stub bridge로 충분).

- [ ] **Step 1: .gitignore에 리포트 산출물 경로 추가**

`.gitignore`의 "Local-only debug/spike scripts" 블록 다음에 추가:

```
# Playbook report outputs (runtime — 로컬 산출물)
outputs/playbooks/
```

- [ ] **Step 2: E2E 루프 1바퀴 테스트 추가** (`tests/control-tower-e2e.test.ts` 하단에 append)

```ts
// ─── T-PB-7: 협업 루프 1바퀴 (조립→승인→실행→일시정지→승인→재개→분석→채택) ───
import { mkdtempSync as mkdtemp7, rmSync as rm7 } from 'node:fs';
import { join as join7 } from 'node:path';
import { tmpdir as tmp7 } from 'node:os';
import { createApi as createApi7 } from '../apps/control-tower/src/api.js';
import { PlaybookStore as PBStore7, AnalysisStore as AnlStore7 } from '../apps/control-tower/src/playbook-store.js';

const PB7_TOOLS = { tools: [
  { name: 'e.read', description: 'r', inputSchema: { type: 'object', properties: { host: { type: 'string' } } }, annotations: { title: 'r', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
  { name: 'e.write', description: 'w', inputSchema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }, annotations: { title: 'w', readOnlyHint: false, destructiveHint: false }, category: 'pm' },
] };

describe('T-PB-7 — 플레이북 협업 루프 1바퀴', () => {
  let bridge7: http.Server; let url7: string; let dir7: string; let out7: string;
  beforeAll(async () => {
    bridge7 = http.createServer(async (req, res) => {
      const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mcp: 'connected' });
      if (req.method === 'GET' && req.url === '/tools') return send(200, PB7_TOOLS);
      if (req.method === 'POST' && req.url === '/tools/call') {
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const payload = body.name === 'e.read'
          ? { evaluation: { specId: 's', ok: false, summary: { pass: 1, fail: 1 }, coverage: {}, items: [{ id: 'i1', label: 'HA', verdict: 'FAIL', category: 'missing', observed: 'off', expected: 'on', reason: 'HA 비활성' }] } }
          : { created: true };
        return send(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
      }
      send(404, { error: 'nf' });
    });
    await new Promise<void>((r) => bridge7.listen(0, '127.0.0.1', () => { url7 = `http://127.0.0.1:${(bridge7.address() as AddressInfo).port}`; r(); }));
    dir7 = mkdtemp7(join7(tmp7(), 'pb7-'));
    out7 = mkdtemp7(join7(tmp7(), 'pb7-out-'));
  });
  afterAll(async () => {
    await new Promise<void>((r) => bridge7.close(() => r()));
    rm7(dir7, { recursive: true, force: true }); rm7(out7, { recursive: true, force: true });
  });

  it('read 2 + write 1 + report → 일시정지 → 승인 → 재개 → report md → 분석 제출 → 채택', async () => {
    const api = createApi7({ bridgeUrl: url7, runsDir: join7(dir7, 'runs'), registryDir: join7(dir7, 'reg'), playbookOutputDir: out7, approvalSecret: 'sec', mockConsoleUrl: 'http://127.0.0.1:1' });
    // 조립(draft) — 에이전트 대행
    const store = new PBStore7(join7(dir7, 'reg'));
    const pb = store.create({ name: '자문 루프', goal: '전체분석→보고서→개선안', authoredBy: 'agent:claude', blocks: [
      { id: 'b1', type: 'tool', toolId: 'e.read', args: { host: 'h1' } },
      { id: 'b2', type: 'tool', toolId: 'e.read', args: { host: 'h2' } },
      { id: 'b3', type: 'tool', toolId: 'e.write', args: { customer: 'acme' } },
      { id: 'r1', type: 'report' },
    ] });
    // 승인
    store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'jmpark' });
    // 실행 → write에서 일시정지
    const started = await api.executePlaybook(pb.id);
    expect(started.status).toBe('waiting_approval');
    // 승인 → 재개 → report까지
    const pending = api.listRuns({ playbookRunId: started.playbookRunId }).find((r) => r.blockId === 'b3')!;
    await api.approveRun(pending.runId, { approvedBy: 'jmpark' });
    const done = api.getPlaybookRun(started.playbookRunId);
    expect(done.status).toBe('succeeded');
    // report md 생성 확인
    const reportRun = api.listRuns({ playbookRunId: started.playbookRunId }).find((r) => r.toolId === 'tower.report')!;
    expect(reportRun.status).toBe('succeeded');
    // 분석 제출 → 채택(제안에 linkedPlaybookId)
    const anl = api.submitAnalysis(started.playbookRunId, {
      playbookId: pb.id, playbookRunId: started.playbookRunId, summary: 'HA 미설정 관측',
      authoredBy: 'agent:claude',
      improvements: [{ observation: 'HA off', recommendation: 'HA 설정' }],
      proposals: [{ action: 'HA 설정 플레이북', rationale: '가용성' }],
    });
    const v = api.setAnalysisVerdict(anl.id, { part: 'proposals', index: 0, verdict: 'accepted', reviewedBy: 'jmpark', linkedPlaybookId: 'pb_followup' });
    expect(v.proposals[0].verdict).toBe('accepted');
    expect(v.proposals[0].linkedPlaybookId).toBe('pb_followup');
    // 분석이 실행 상세에 붙는다
    expect(api.getPlaybookRun(started.playbookRunId).analyses).toHaveLength(1);
  });
});
```

- [ ] **Step 3: 전체 테스트/타입/빌드**

```bash
npm test        # 기존 385 + 신규(T-PB-1~7) 전부 PASS (0 fail, 기존 skip 2건 허용)
npm run lint    # 에러 0
```

하나라도 실패하면 superpowers:systematic-debugging으로 원인 규명 → 수정 → 재실행. **기존 테스트를 고치는 방향의 수정은 금지**(Global Constraints "v1 무회귀" 위반 신호).

- [ ] **Step 4: 수용 기준 수동 체크 (스펙 §12 — mock 3프로세스 기동)**

기동 (한 셸에서 시크릿 export 후):
```bash
export SANGFOR_OPERATOR_APPROVAL_SECRET=dev-secret
pnpm dev:mock-console &      # :3400
pnpm dev:http-bridge &       # :3600 (같은 시크릿 env 상속)
pnpm dev:control-tower       # :3700
```

브라우저 `http://127.0.0.1:3700` → `플레이북` 패널:

1. [ ] [AI 조립 요청](goal 입력) → 큐에 assemble task 등록됨. **에이전트 대행(이 세션):** `POST /api/playbooks`로 read 2 + write 1(`sangfor.pm_create_engagement`) + report 블록 draft 등록 → task close.
2. [ ] 상세 뷰에서 블록 순서·리비전 확인 → [승인]
3. [ ] [실행] → advisor read 2 즉시 → `pm_create_engagement`(write) 일시정지(waiting_approval)
4. [ ] 실행 뷰 또는 대시보드 승인 큐에서 [승인] → 재개 → report 블록 → `outputs/playbooks/<pbrunId>.md` 생성 확인 → 유도 상태 succeeded
5. [ ] [AI 분석 요청] → analyze task 등록. **에이전트 대행:** `POST /api/playbook-runs/:id/analysis`로 개선/제안 제출 → 분석 카드 표시
6. [ ] 개선포인트 [채택], 제안포인트 [채택](후속 플레이북 id 연결) → verdict 반영
7. [ ] 반려 루프: 새 draft [반려](사유) → [AI 수정 요청] → rev 2 draft → diff(블록 목록) 확인 → [승인]
8. [ ] 타워 프로세스만 재시작 → waiting 플레이북의 write [승인] → 재개 성공(재해석 폴백)
9. [ ] v1 무회귀: 단일 도구 승인/sweep/이력 화면 동작 불변, playbookRunId 없는 pending의 재시작 후 승인은 여전히 400

- [ ] **Step 5: 이슈 발견 시 수정 커밋, 클린이면 마무리**

체크 실패 항목은 개별 `fix(control-tower): ...` 커밋 후 해당 체크부터 재검증. 전부 통과하면:

```bash
git add .gitignore tests/control-tower-e2e.test.ts
git commit -m "test(e2e): playbook collaboration loop end-to-end (T-PB-7) + gitignore report outputs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

이어서 superpowers:finishing-a-development-branch로 마무리 옵션(머지/PR) 제시.

---

## 스펙 커버리지 매핑 (Self-Review 결과)

| 스펙 § | 요구 | 태스크 |
|---|---|---|
| §2 범위 1 플레이북 저장소 | `playbook-store.ts` + `playbooks.json` | Task 2 |
| §2 범위 2 실행 엔진 | 유도 상태 + 순차/정지/재개 | Task 4(유도·순수함수), 5(실행), 7(재개) |
| §2 범위 3 내장 리포트 블록 | `renderReport` + `outputs/playbooks/*.md` | Task 4(렌더), 5(파일 저장) |
| §2 범위 4 분석 아티팩트 | `AnalysisStore` + `analyses/*.jsonl` | Task 3, 6 |
| §2 범위 5 에이전트 작업 큐 | `AgentTaskStore` + `agent-tasks.json` | Task 3, 6 |
| §2 범위 6 API·UI 확장 | 라우트 + 패널 | Task 6, 8 |
| §2 범위 7 RunRecord 태그 | 옵셔널 4필드 | Task 1 |
| §5.1 데이터 모델 전체 | 타입 전부 | Task 2, 3 |
| §5.2 저장소 3종(패턴·마스킹) | PlaybookStore/AnalysisStore/AgentTaskStore | Task 2, 3 |
| §5.2 블록 검증 fail-closed | `validateBlocks` | Task 2 |
| §5.3 템플릿 문법·결정성 | `resolveTemplates` | Task 4 |
| §5.3 유도 상태 규칙 6항 | `derivePlaybookRunStatus` | Task 4 |
| §5.3 모듈 경계(순수함수 3개) | engine export 제한 | Task 4 |
| §5.3 실행 흐름(execute/continueRun·stop-on-failure) | 엔진 프리미티브 | Task 5 |
| §5.3 approveRun 접점 2곳 | #1 재해석 / #2 continueRun | Task 7 / Task 5 |
| §5.3 리포트 마크다운 규칙 | `renderReport`(FAIL 표·고지) | Task 4 |
| §5.4 API 라우트 12행 | server.ts 라우트 | Task 6 |
| §5.5 UI(목록/상세/실행/분석·diff) | 플레이북 패널 | Task 8 |
| §6.1~6.4 핵심 플로우 | 조립·실행·리포트·분석 | Task 5·6·8, E2E Task 9 |
| §7 보안 불변식 7종 | Global Constraints + 태스크별 | 전 태스크(Task 2 마스킹·5 격리·7 무회귀) |
| §8 에러 처리 표 9행 | 403/템플릿실패/reject/409/400/파싱skip | Task 2·3·4·5·6·7 |
| §9 테스트 전략 T-PB-1~7 | 신규 3파일 + e2e | Task 2~9 |
| §10 env·gitignore | outputs/playbooks/ | Task 9 |
| §11 기존 시스템 영향(무수정 범위) | mcp-server/operator/bridge FROZEN | Global Constraints |
| §12 수용 기준 4항 | 최종 검증 체크리스트 | Task 9 |

**스펙 이탈(의도적, 근거 헤더 §스펙 이탈 참조):** ① `TowerOptions.playbookOutputDir` 추가(테스트 주입, env 아님) ② reject는 리포트 미실행 → failed(§8·§5.3 "접점 2곳" 우선, §6.2와 상충 해소) ③ approveRun continueRun 접점은 write succeeded/failed 무관 호출(실패 write도 리포트 부분집계, §6.2 취지 보존).

## 실행 핸드오프

**플랜 완료. `docs/superpowers/plans/2026-07-04-playbook-implementation.md`에 저장됨. 두 실행 옵션:**

**1. Subagent-Driven (권장)** — 태스크마다 새 서브에이전트 디스패치, 태스크 간 리뷰, 빠른 이터레이션. `superpowers:subagent-driven-development`.

**2. Inline Execution** — 이 세션에서 체크포인트 배치 실행. `superpowers:executing-plans`.

**토큰 경제 참고:** 각 태스크는 명확한 스펙(파일·요구·수용기준·테스트 명령)을 갖추었으므로 구현은 `opencode-coder` 에이전트에 위임하고, 반환된 diff·테스트 증거를 메인 루프가 리뷰하는 방식이 CLAUDE.md 라우팅 정책에 부합한다.
