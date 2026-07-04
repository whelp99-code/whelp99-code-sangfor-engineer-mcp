# 플레이북 설계문서 (Playbook Design Spec)

> **작성일:** 2026-07-04 · **상태:** 사용자 승인된 설계(A+ 루프 × 접근법 B)의 상세화 · **다음 단계:** `docs/superpowers/plans/`의 구현 플랜
>
> **전제:** 이 스펙은 Control Tower v1(`docs/superpowers/specs/2026-07-03-control-tower-design.md` + 구현 플랜 12태스크)이 완료된 코드베이스 위에 얹힌다. §4의 "전제 계약"은 v1 플랜이 확정한 인터페이스를 그대로 인용한 것이므로 신뢰하고 사용하되, 구현 시점에 실제 코드와 대조하라.

---

## 1. 목적

MCP 도구들을 **블록으로 배치·연결한 플레이북**을 저장·검증·실행한다. 핵심 협업 모델:

- **블록과 연결은 AI가** — 외부 에이전트(Claude 등)가 목표를 받아 플레이북을 조립(draft)하고, 실행 결과를 분석해 **개선포인트·제안포인트**를 제출하며, 반려·결과 피드백을 반영해 **수정 리비전**을 제출한다.
- **검증은 PM/사용자가** — draft 리비전의 승인/반려, 실행 중 write 블록의 승인, AI 분석 항목의 채택/기각 전부 사람이 한다.
- 예시 시나리오(사용자 제시): "전체분석 → 보고서 작성 → 개선안 제공" = advisor 블록들 + 내장 리포트 블록 + AI 분석 루프.

## 2. 범위 / 비범위

### 범위

| # | 항목 | 산출물 |
|---|------|--------|
| 1 | 플레이북 정의·리비전 저장소 | `apps/control-tower/src/playbook-store.ts` + `data/registry/playbooks.json` |
| 2 | 실행 엔진(순차·일시정지·재개·유도 상태) | `apps/control-tower/src/playbook-engine.ts` |
| 3 | 내장 종합 리포트 블록 | 엔진 내 렌더러 + `outputs/playbooks/*.md` |
| 4 | AI 분석 아티팩트(개선·제안포인트) | `AnalysisStore` + `data/runs/analyses/*.jsonl` |
| 5 | 에이전트 작업 큐 | `AgentTaskStore` + `data/registry/agent-tasks.json` |
| 6 | API·UI 확장 | `api.ts`/`server.ts`/`ui.ts` 확장 (플레이북 패널) |
| 7 | RunRecord 태그 확장 | `@sangfor/runs`에 옵셔널 필드 4개 |

### 비범위 (명시적 제외 — 후속 스펙)

- **조건 분기(if/else)·병렬 블록·루프 블록.** v1 블록은 선형 순차 실행만.
- **스케줄/주기 실행.** 실행은 UI 버튼 또는 API 호출.
- **타워 내장 LLM 조립.** 조립·분석은 외부 에이전트(사용자 확정). 에이전트 큐가 인터페이스.
- **에이전트 자동 폴링 데몬.** 큐는 API로 노출만 — 폴링은 에이전트 쪽 책임.
- **플레이북 간 중첩 호출**(플레이북 블록이 다른 플레이북 실행).
- **분석 아티팩트 수정.** 분석은 append-only, verdict(채택/기각)만 갱신.

## 3. 아키텍처 개요 (협업 루프)

```
[에이전트]                      [타워 (:3700)]                        [PM/사용자 (UI)]
    │  POST /api/playbooks (draft rev)   │                                │
    │────────────────────────────────────▶  playbooks.json                │
    │                                     │   rev diff 표시 ──────────────▶ 승인/반려
    │                                     │                                │
    │                                     │  POST /api/playbooks/:id/execute (승인 rev만)
    │                                     │   블록 순차 실행 = 기존 RunStore run (태깅)
    │                                     │   read → 즉시 · write → pending + 정지
    │                                     │   승인 큐 ────────────────────▶ [승인] → 재개
    │                                     │   report 블록 → outputs/playbooks/<runId>.md
    │  GET /api/agent-tasks?status=open   │                                │
    │◀────────────────────────────────────  [AI 분석 요청] 버튼 → agent-task(open)
    │  POST /api/playbook-runs/:id/analysis                                │
    │────────────────────────────────────▶  analyses.jsonl ───────────────▶ 채택/기각
    │  POST /api/playbooks/:id/revisions  │                                │
    │────────────────────────────────────▶  (수정 루프 반복)               │
```

- **접근법 B(사용자 확정):** 플레이북 "실행"의 상태 레코드는 저장하지 않는다. 블록 run들의 태그(`playbookRunId` 등)와 해당 리비전의 블록 목록에서 상태를 **매번 유도**한다.
- write 블록 승인은 **v1 run 승인 게이트를 그대로 재사용** — 새 승인 체계를 발명하지 않는다.

## 4. 전제 계약 (v1이 제공 — 구현 에이전트 필독)

- `@sangfor/runs`: `RunStore.createRun/transition/getRun/listRuns/pendingApprovals`, `RunRecord`(schemaVersion 1, resultJson은 저장 시 maskSecrets+500KB 캡), append-only JSONL.
- `apps/control-tower/src/api.ts`: `createApi(opts: TowerOptions)` — `createRun`(read 즉시/write pending + 메모리 `originalArgs` 맵), `approveRun`(민팅→실행→최종 전이), `rejectRun`, `ApiError(status, message)`, `summarize()`.
- `apps/control-tower/src/registry.ts`: `Registry`, `mergeDeviceArgs(vendor, device, userArgs)`, `applyMockCredentialFallback(args, vendor, inputSchema)`, atomic write 패턴(`.tmp`+renameSync), `RegistryValidationError`.
- `apps/control-tower/src/bridge-client.ts`: `BridgeClient.listTools/callTool`, `safetyOf(tool)`.
- `apps/control-tower/src/server.ts`: `createTowerServer(opts)`, `/api/*` checkAuth 게이트, ApiError→status 매핑.
- bridge tool-guard: write/destructive는 유효한 SignedApproval(action `bridge.tool-call`, 단일사용 nonce) 첨부 시 통과.
- `nowId(prefix)` (`@sangfor/shared`).

## 5. 컴포넌트 설계

### 5.1 데이터 모델 (전체 정의 — 그대로 구현)

```ts
// ── 플레이북 정의 (playbook-store.ts) ──────────────────────────────────────
export interface PlaybookBlock {
  id: string;                  // 리비전 내 유일, 템플릿 참조 앵커. 예: 'b1'
  type: 'tool' | 'report';
  title?: string;              // UI 표시명 (한국어 가능)
  toolId?: string;             // type==='tool' 필수. 예: 'sangfor.advisor_fortios_advanced'
  args?: Record<string, unknown>;  // 값에 템플릿 문자열 허용 (§5.3)
  deviceId?: string;           // 지정 시 v1 인자 병합 규칙 재사용
}

export interface PlaybookRevision {
  rev: number;                 // 1부터 증가
  blocks: PlaybookBlock[];
  authoredBy: string;          // 예: 'agent:claude', 'user:jmpark'
  note?: string;               // 조립 근거 / 반려 피드백에 대한 응답
  status: 'draft' | 'approved' | 'rejected';
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectReason?: string;       // status==='rejected'일 때 필수 — AI가 다음 리비전에서 읽음
}

export interface Playbook {
  id: string;                  // nowId('pb')
  name: string;
  goal: string;                // 조립 목표 원문 (AI 입력)
  revisions: PlaybookRevision[];  // rev 오름차순. "활성 리비전" = status==='approved' 중 최대 rev
  createdAt: string;
  updatedAt: string;
}

// ── RunRecord 태그 확장 (@sangfor/runs — 옵셔널 4필드 추가, 하위호환) ───────
export interface RunRecord {
  // ... 기존 필드 전부 유지 ...
  playbookId?: string;
  playbookRunId?: string;      // nowId('pbrun')
  playbookRev?: number;        // 실행에 사용된 리비전 — 유도 상태가 이 rev의 블록 목록을 기준으로 계산
  blockId?: string;
}
// ListRunsOptions에도 playbookRunId?: string 필터 추가.

// ── AI 분석 아티팩트 (playbook-store.ts) ───────────────────────────────────
export type AnalysisVerdict = 'accepted' | 'dismissed';

export interface AnalysisImprovement {
  observation: string;         // 관찰 사실
  evidenceRunId?: string;      // 근거 블록 run
  recommendation: string;      // 개선 권고
  verdict?: AnalysisVerdict;   // PM 채택/기각 (미설정 = 검토 대기)
  reviewedBy?: string;
}

export interface AnalysisProposal {
  action: string;              // 제안 액션. 예: 'HA 미설정 2건 → 설정변경 플레이북'
  rationale: string;
  linkedPlaybookId?: string;   // 채택 후 후속 draft 플레이북과 연결
  verdict?: AnalysisVerdict;
  reviewedBy?: string;
}

export interface PlaybookAnalysis {
  schemaVersion: 1;
  id: string;                  // nowId('anl')
  playbookId: string;
  playbookRunId: string;
  summary: string;
  improvements: AnalysisImprovement[];  // 개선포인트
  proposals: AnalysisProposal[];        // 제안포인트
  authoredBy: string;          // 예: 'agent:claude'
  createdAt: string;
}

// ── 에이전트 작업 큐 (playbook-store.ts) ───────────────────────────────────
export type AgentTaskKind = 'assemble' | 'revise' | 'analyze';

export interface AgentTask {
  id: string;                  // nowId('atask')
  kind: AgentTaskKind;
  payload: {
    goal?: string;             // assemble: 조립 목표
    playbookId?: string;       // revise/analyze
    playbookRunId?: string;    // analyze
    feedback?: string;         // revise: 반려 사유·PM 코멘트
  };
  status: 'open' | 'done' | 'cancelled';
  result?: { playbookId?: string; rev?: number; analysisId?: string; note?: string };
  createdAt: string;
  closedAt?: string;
}
```

### 5.2 저장소 (`playbook-store.ts`)

| 저장소 | 파일 | 방식 |
|---|---|---|
| `PlaybookStore` | `data/registry/playbooks.json` (`SANGFOR_REGISTRY_ROOT` 앵커) | registry 패턴: 전체 JSON, atomic write. 없으면 `[]` 생성 |
| `AnalysisStore` | `data/runs/analyses/<YYYY-MM-DD>.jsonl` (`SANGFOR_RUNS_ROOT` 앵커 하위) | RunStore 패턴: append-only 스냅샷, id별 last-wins fold. verdict 갱신 = 새 스냅샷 append |
| `AgentTaskStore` | `data/registry/agent-tasks.json` | registry 패턴: atomic write |

핵심 메서드 (시그니처 — 그대로 구현):

```ts
export class PlaybookStore {
  constructor(dir?: string);   // Registry와 같은 dir 규칙
  list(): Playbook[];
  get(id: string): Playbook | undefined;
  create(input: { name: string; goal: string; blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Playbook;  // rev 1 draft
  addRevision(id: string, input: { blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Playbook;  // rev N+1 draft
  reviewRevision(id: string, rev: number, verdict: { approve: boolean; reviewedBy: string; rejectReason?: string }): Playbook;
  // draft가 아닌 리비전 재심사 → PlaybookValidationError. reject에 rejectReason 없으면 에러.
  activeRevision(pb: Playbook): PlaybookRevision | undefined;  // approved 중 최대 rev
}
export class PlaybookValidationError extends Error {}

export class AnalysisStore {
  constructor(dir?: string);
  append(analysis: PlaybookAnalysis): PlaybookAnalysis;              // 저장 전 maskSecrets
  get(id: string): PlaybookAnalysis | undefined;
  listByRun(playbookRunId: string): PlaybookAnalysis[];
  setVerdict(id: string, part: 'improvements' | 'proposals', index: number,
             verdict: AnalysisVerdict, reviewedBy: string, linkedPlaybookId?: string): PlaybookAnalysis;
}

export class AgentTaskStore {
  constructor(dir?: string);
  list(status?: AgentTask['status']): AgentTask[];
  create(input: { kind: AgentTaskKind; payload: AgentTask['payload'] }): AgentTask;
  close(id: string, result: AgentTask['result']): AgentTask;   // open이 아니면 에러
  cancel(id: string): AgentTask;
}
```

**블록 검증 (create/addRevision 시, fail-closed):** blocks 비어있으면 에러 · block.id 중복 에러 · `type:'tool'`인데 toolId 없으면 에러 · `type:'report'` 블록은 args/toolId 금지 · report 블록은 0~1개(마지막 위치 권장이나 강제하지 않음 — 실행 시 앞선 블록만 집계).

### 5.3 실행 엔진 (`playbook-engine.ts`)

**템플릿 문법 (확정):**

- 형식: `{{blocks.<blockId>.result.<dot.path>}}` — `<dot.path>`는 해당 블록 run의 **저장된 resultJson**(마스킹·500KB 캡 적용본) 안의 점 표기 경로. `result`만 쓰면 resultJson 전체.
- arg 값이 **정확히 템플릿 하나**인 문자열 → 해석된 값(모든 JSON 타입)으로 치환. 문자열 안에 템플릿이 **부분 포함** → 각 템플릿을 `String(값)`으로 문자열 보간.
- **결정성:** 해석은 항상 RunStore에 영속된 resultJson 기준. 따라서 재시작 전후 해석 결과가 동일하다. (주의: 마스킹본이므로 상류 결과의 비밀값을 하류로 파이프할 수 없다 — 의도된 fail-closed. 자격증명은 장비 레지스트리 credentialEnv로만 주입.)
- 해석 실패(블록 미존재·미완료·경로 없음) → 해당 블록 run을 `failed`(`error: '템플릿 해석 실패: {{...}}'`)로 기록하고 정지.

**모듈 시그니처:**

```ts
export type PlaybookRunStatus = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'partial';

// 순수 함수 — 단위 테스트 대상
export function resolveTemplates(
  args: Record<string, unknown>,
  lookup: (blockId: string) => RunRecord | undefined,   // 같은 playbookRunId의 블록 run
): Record<string, unknown>;                              // 실패 시 TemplateError throw

export function derivePlaybookRunStatus(
  revision: PlaybookRevision,
  blockRuns: RunRecord[],       // listRuns({ playbookRunId }) 결과
): { status: PlaybookRunStatus; blocks: Array<{ blockId: string; runId?: string; status?: RunStatus }> };

export function renderReport(
  playbook: Playbook, rev: number, playbookRunId: string,
  blockRuns: RunRecord[],       // report 블록 이전의 블록 run들
): string;                      // 마크다운
```

**모듈 경계 (확정):** `playbook-engine.ts`는 위 **순수 함수 3개만** export한다 (단위 테스트 대상, 부수효과 없음 — `renderReport`의 파일 저장은 호출자 몫). 상태를 가진 실행 루프(`executePlaybook(playbookId)` / `continuePlaybookRun(playbookRunId)`)는 **v1 `createApi` 내부에 구현**한다 — sweep과 같은 방식으로 closure의 `bridge`/`store`/`registry`/`originalArgs`/`execute()` 프리미티브에 직접 접근하며, 별도 의존성 주입 계층을 만들지 않는다(YAGNI). API 라우트는 이 두 메서드에 위임한다.

**유도 상태 규칙 (`derivePlaybookRunStatus` — 확정):**

1. 해당 rev의 블록 목록을 기준으로 blockId별 최신 run을 매핑한다.
2. `pending_approval` run이 하나라도 있으면 → `waiting_approval`
3. `running` run이 있거나, 실패 없이 아직 run이 없는 블록이 남았으면 → `running`
4. 모든 블록이 `succeeded` → `succeeded`
5. `failed`/`rejected` 블록이 있고 report 블록이 `succeeded` → `partial` (부분 리포트 존재)
6. 그 외 실패 존재 → `failed`

**실행 흐름 (`execute`/`continueRun`):**

- `execute`: 활성 리비전 없으면 `ApiError(403, '승인된 리비전이 없습니다')`. `playbookRunId = nowId('pbrun')` 발급 후 첫 블록부터 `runBlocksFrom(0)`.
- `runBlocksFrom(i)`: 블록을 순서대로 —
  - **tool 블록:** args 템플릿 해석 → deviceId 있으면 v1 병합 규칙 적용 → safetyOf 판정.
    - read_only → run 생성(`running`, 태그 4종) → 실행 → 실패 시 **정지**(이후 report 블록만 실행, §아래).
    - write/destructive → run 생성(`pending_approval`, 태그 4종) + originalArgs 맵 저장 → **엔진 리턴** (유도 상태 = waiting_approval).
  - **report 블록:** 앞선 블록 run들을 조회해 `renderReport` → `outputs/playbooks/<playbookRunId>.md` 저장(mkdir -p) → run 기록(toolId `'tower.report'`, toolSafety `'read_only'`, resultJson `{ markdown, path }`, resultSummary 첫 줄).
  - stop-on-failure: tool 블록 실패 시 이후 tool 블록은 실행하지 않되, **report 블록은 항상 실행**해 부분 리포트를 남긴다(→ 유도 상태 partial).
- `continueRun`: 태그된 run들에서 마지막 완료 블록 위치를 찾아 그 다음 블록부터 `runBlocksFrom`. 방금 승인된 write 블록이 `failed`면 재개하지 않는다(정지 → failed/partial).

**v1 `approveRun`과의 접점 (v1 api.ts 수정 2곳 — 명시적 허용):**

1. 승인 대상 run에 `playbookRunId`가 있고 `originalArgs` 맵에 없으면(타워 재시작) → 400 대신 **템플릿·병합 재해석으로 args를 결정적으로 복원**해 진행한다. 저장된 resultJson·리비전이 불변이므로 승인자가 본 것과 동일함이 보장된다 — 단일 도구 실행의 소실 규칙(400)은 그대로 유지.
2. 승인 실행이 `succeeded`로 끝나고 run에 `playbookRunId`가 있으면 → `engine.continueRun(playbookRunId)`을 이어서 호출(응답은 run 레코드 그대로, 재개는 비동기 fire-and-forget이 아니라 **await 후 응답** — 다음 read 블록들까지 완료된 유도 상태를 UI가 즉시 볼 수 있게).

**리포트 마크다운 규칙 (`renderReport` — 결정적, LLM 없음):**

헤더(플레이북명·goal·rev·playbookRunId·시각) → 블록별 섹션(title/toolId/장비/상태/resultSummary/runId) → EvaluationResult 형태(v1 `summarize` 판정 로직 재사용)면 FAIL 항목 표: `item.label | observed | expected | reason` → 말미 "개선권고" 목록 = 모든 FAIL 항목의 reason 취합. AI 분석과 혼동되지 않도록 문서 말미에 "이 보고서는 기계 집계입니다. AI 분석은 별도 아티팩트로 제출됩니다." 고지.

### 5.4 API 라우트 (전체 — `/api/*` 기존 checkAuth 게이트)

| 메서드·경로 | 요청 | 응답 | 설명 |
|---|---|---|---|
| `GET /api/playbooks` | — | `{ playbooks: Array<Playbook & { activeRev?: number; lastRun?: { playbookRunId; status } }> }` | 목록 + 최근 실행 유도상태 |
| `POST /api/playbooks` | `{ name, goal, blocks, authoredBy, note? }` | `Playbook` | 조립(draft rev 1). 블록 검증 실패 400 |
| `GET /api/playbooks/:id` | — | `Playbook` | 상세(전체 리비전) |
| `POST /api/playbooks/:id/revisions` | `{ blocks, authoredBy, note? }` | `Playbook` | 수정(draft rev N+1) |
| `POST /api/playbooks/:id/revisions/:rev/approve` | `{ reviewedBy }` | `Playbook` | draft→approved. draft 아니면 409 |
| `POST /api/playbooks/:id/revisions/:rev/reject` | `{ reviewedBy, reason }` | `Playbook` | draft→rejected. reason 필수 400 |
| `POST /api/playbooks/:id/execute` | `{}` | `{ playbookRunId, status, blocks }` | 활성 rev 실행. 없으면 403 |
| `GET /api/playbook-runs/:id` | — | `{ playbookId, rev, status, blocks[], analyses[] }` | 유도 상태 + 블록별 run 매핑 + 분석 목록 |
| `POST /api/playbook-runs/:id/analysis` | `PlaybookAnalysis`(id·시각 제외) | `PlaybookAnalysis` | AI 분석 제출 (에이전트) |
| `POST /api/analyses/:id/verdict` | `{ part: 'improvements'\|'proposals', index, verdict, reviewedBy, linkedPlaybookId? }` | `PlaybookAnalysis` | 채택/기각 |
| `GET /api/agent-tasks` | query: `status` | `{ tasks: AgentTask[] }` | 에이전트 폴 |
| `POST /api/agent-tasks` | `{ kind, payload }` | `AgentTask` | UI 버튼([AI 조립/수정/분석 요청]) |
| `PATCH /api/agent-tasks/:id` | `{ result }` 또는 `{ cancel: true }` | `AgentTask` | 에이전트 결과 제출(close) / 취소 |

- 실행 이력 화면과의 연결: `GET /api/runs?playbookRunId=...` (ListRunsOptions 확장) — 블록 run들이 일반 이력에도 그대로 보인다.

### 5.5 UI (플레이북 패널 1개 추가 — 기존 idiom)

- 네비에 `플레이북` 추가. **목록 뷰:** 이름·goal·활성 rev·최근 실행 상태 뱃지·[AI 조립 요청] 버튼(목표 prompt → agent-task 생성).
- **상세 뷰:** 블록 순서 카드(제목·toolId·안전등급 뱃지·장비·args 요약) · 리비전 히스토리(draft면 [승인][반려], 이전 승인본과 **블록 단위 diff**: 추가/삭제/변경 색상) · [실행] · [AI 수정 요청](피드백 prompt) · draft/rejected는 실행 버튼 비활성.
- **실행 뷰:** 블록별 상태색 진행 표시(read 녹/write 황/실패 적/대기 점멸) · waiting이면 해당 블록에 [승인][거부](기존 approve/reject API 그대로) · report 완료 시 마크다운 렌더(pre) + 파일 경로 · [AI 분석 요청] 버튼 · 분석 카드: summary + 개선포인트/제안포인트 항목별 [채택][기각], 채택된 제안에 [후속 플레이북 연결] 표시.
- **대시보드 위젯 반영:** 승인 대기 큐에 플레이북 블록 run도 자연히 뜸(기존 pendingApprovals) — 항목에 플레이북명 병기.

## 6. 핵심 플로우

### 6.1 조립 → 검증

```
[AI 조립 요청] 버튼(goal 입력) → agent-task(assemble, open)
에이전트: GET /api/agent-tasks?status=open → 도구 카탈로그(GET /api/tools)·장비(GET /api/devices) 참조
        → POST /api/playbooks { blocks: [...], authoredBy: 'agent:claude', note: 조립근거 }
        → PATCH /api/agent-tasks/:id { result: { playbookId, rev: 1 } }
PM: 상세 뷰에서 블록 검토 → [승인] (또는 [반려] + 사유 → AI 수정 루프 §6.4)
```

### 6.2 실행 · 일시정지 · 재개

```
[실행] → execute → 블록 순차 실행 (블록 run은 playbookId/playbookRunId/playbookRev/blockId 태깅)
  read 블록: 즉시 실행 (v1 §6.1과 동일 경로)
  write 블록: pending_approval + 엔진 정지 → 유도 상태 waiting_approval
[승인] (대시보드 큐 또는 실행 뷰) → v1 approveRun → 민팅→bridge→실행
  → succeeded면 engine.continueRun: 다음 블록부터 이어서 (report까지)
  → failed/rejected면 정지 → report 블록만 실행 → 유도 상태 partial|failed
타워 재시작 후: pending 블록 run의 원본 인자는 리비전+영속 결과에서 결정적 재해석 → 승인·재개 가능
```

### 6.3 리포트 블록

read 블록들의 결과를 §5.3 규칙으로 마크다운 집계. 예시 시나리오의 "보고서 작성"이 이 블록 — LLM 없이 결정적. "개선안 제공"의 1차 층(기계 집계: FAIL 항목·권고 취합)도 여기서 나온다.

### 6.4 AI 분석 → 채택 → 수정/후속

```
실행 완료 → [AI 분석 요청] → agent-task(analyze, open)
에이전트: GET /api/playbook-runs/:id (+ 필요시 GET /api/runs/:runId 상세)
        → POST /api/playbook-runs/:id/analysis { summary, improvements[], proposals[] }
PM: 분석 카드에서 항목별 [채택]/[기각]
  개선포인트 채택 → (AI 수정 요청과 연계) agent-task(revise) → 에이전트가 rev N+1 draft 제출 → §6.1 검증
  제안포인트 채택 → 에이전트가 후속 플레이북 draft 생성 → verdict에 linkedPlaybookId 기록
```

## 7. 보안 불변식 (전 태스크 공통)

1. **승인된 리비전만 실행 가능.** draft/rejected 실행 요청은 403. 승인된 리비전은 **불변**(수정 = 새 draft 리비전).
2. **write 블록 승인은 v1 run 게이트 그대로.** 새 승인 체계·nonce 발명 금지. bridge의 action-bound 단일사용 승인 경로를 재사용.
3. **템플릿은 자기 playbookRun 내 블록 결과만 참조.** 다른 실행·다른 플레이북의 run 참조 불가 (정보 격리).
4. **템플릿 해석은 마스킹본 기준** — 상류 비밀값의 하류 파이프 불가(의도된 fail-closed). 자격증명 주입은 registry credentialEnv 경로만.
5. **모든 신규 저장물에 저장 전 maskSecrets** (플레이북 args, 분석, agent-task payload/result).
6. **모든 신규 라우트는 기존 `/api` 토큰 게이트 뒤.** 에이전트도 같은 Bearer 토큰 사용.
7. **v1 무회귀:** 단일 도구 실행·승인·sweep·이력 동작은 바이트 단위 동일. 특히 v1의 원본인자 소실→400 규칙은 **playbookRunId 없는 run에 그대로 유지**.

## 8. 에러 처리

| 상황 | 동작 |
|---|---|
| 활성 리비전 없이 execute | 403 `'승인된 리비전이 없습니다'` |
| 템플릿 해석 실패 | 해당 블록 run `failed`(error에 템플릿 원문) → 정지 → report만 실행 → partial/failed |
| write 블록 거부(reject) | run `rejected` → 재개 없음 → 유도 상태 failed (report 있으면 partial) |
| 재개 시점에 리비전을 찾을 수 없음(파일 손상 등) | continueRun이 ApiError(409) — pending run은 그대로(수동 처리 가능) |
| draft 아닌 리비전 승인/반려 | 409 |
| 블록 검증 실패(중복 id, toolId 누락 등) | 400 (사유 명시) |
| agent-task close 대상이 open 아님 | 409 |
| 분석 verdict의 part/index 범위 밖 | 400 |
| report 블록 렌더 실패(디스크 등) | report run `failed` — 플레이북은 failed/partial, 앞선 블록 결과는 이력에 보존 |

## 9. 테스트 전략 (기존 전체 무회귀 필수)

| ID | 파일 | 검증 내용 |
|---|---|---|
| T-PB-1 | `tests/control-tower-playbook-store.test.ts` | Playbook/리비전 CRUD·검증(중복 blockId, report 블록 규칙)·활성 리비전 규칙·승인/반려 상태기계·atomic write·재로드 |
| T-PB-2 | 〃 | AnalysisStore append/fold/verdict 갱신·maskSecrets 강제. AgentTaskStore open→done/cancelled 상태기계 |
| T-PB-3 | `tests/control-tower-playbook-engine.test.ts` | `resolveTemplates`: 전체치환/문자열보간/경로누락 실패/마스킹본 기준. `derivePlaybookRunStatus`: 5개 상태 전부 + rev 기준 계산. `renderReport`: FAIL 취합·결정성(같은 입력=같은 출력) |
| T-PB-4 | 〃 | 실행 통합(stub bridge): read 체인 성공 → succeeded / read 실패 → report만 실행 → partial / write 도달 → waiting + 엔진 정지 |
| T-PB-5 | `tests/control-tower-playbook-api.test.ts` | 라우트 전부(§5.4 표)·draft 실행 403·리비전 diff용 데이터 형태·agent-task 큐 왕복·분석 제출→verdict |
| T-PB-6 | 〃 | **재개:** write 승인 → continueRun으로 후속 블록+report까지 · 타워 재시작(새 서버 인스턴스) 후 승인 → 재해석 폴백으로 재개 성공 · playbookRunId 없는 run은 기존 400 유지(무회귀) |
| T-PB-7 | `tests/control-tower-e2e.test.ts`에 추가 | 루프 1바퀴 e2e: 조립(draft)→승인→실행(read 2+write 1+report)→일시정지→승인→재개→report md 생성→분석 제출→채택(linkedPlaybookId) |

## 10. 파일 경로·환경변수

- 신규 env 없음. 저장 경로는 기존 앵커 재사용: `SANGFOR_REGISTRY_ROOT`(playbooks/agent-tasks), `SANGFOR_RUNS_ROOT`(analyses).
- `.gitignore` 추가: `outputs/playbooks/` (리포트 산출물은 로컬 데이터).

## 11. 기존 시스템 영향

- `apps/mcp-server`, `packages/sangfor-operator`, `apps/http-bridge`: **무수정**
- `packages/sangfor-runs`: RunRecord 옵셔널 필드 4개 + ListRunsOptions.playbookRunId 필터 (하위호환 — 기존 테스트 무수정 통과 필수)
- `apps/control-tower/src/api.ts`: approveRun 접점 2곳(§5.3) + 신규 메서드 위임 · `server.ts`: 라우트 추가 · `ui.ts`: 플레이북 패널
- 신규: `playbook-store.ts`, `playbook-engine.ts`

## 12. 수용 기준

1. 전체 테스트/lint/build clean (v1 수용 기준 유지 + T-PB-1~7).
2. mock 3프로세스 기동 상태에서 루프 1바퀴 수동 확인:
   - [AI 조립 요청] → (에이전트 대행: 이 세션이) draft 등록 → UI 블록 diff 확인 → 승인
   - 실행: advisor 블록 2(read) → `sangfor.pm_create_engagement`(write) 일시정지 → 승인 → 재개 → report 블록 → `outputs/playbooks/*.md` 생성 확인
   - [AI 분석 요청] → 분석 제출 → 개선포인트 채택·제안포인트 채택(후속 draft 연결)
   - 반려 루프: draft 반려(사유) → [AI 수정 요청] → rev 2 draft → diff → 승인
3. 타워 재시작 후 waiting 플레이북의 write 블록 승인 → 재개 성공 (재해석 폴백 경로).
4. v1 무회귀: 단일 도구 승인 흐름·sweep·이력 화면 동작 불변, playbookRunId 없는 pending의 재시작 후 승인은 여전히 400.
