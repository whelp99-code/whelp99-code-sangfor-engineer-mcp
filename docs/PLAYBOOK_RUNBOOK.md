# 플레이북 런북 (Playbook Runbook)

Control Tower(`:3700`)의 플레이북을 실제로 돌리는 절차. 설계 근거는
`docs/superpowers/specs/2026-07-04-playbook-design.md`에 있다.

플레이북 = 순서가 있는 블록 묶음(`tool` 블록 여러 개 + `report` 블록 최대 1개).
리비전 단위로 저장되고, **사람이 승인한 활성 리비전만** 실행된다.

## 0. 스택 기동

```bash
export SANGFOR_API_TOKEN=<타워/브리지 공용 토큰>
export SANGFOR_OPERATOR_APPROVAL_SECRET=<승인 서명 비밀>

pnpm dev:mock-console     # :3400 (실장비 대신 쓰는 모의 콘솔)
pnpm dev:http-bridge      # :3600 (MCP 도구를 HTTP로 노출)
pnpm dev:control-tower    # :3700 (대시보드 + 플레이북 엔진)
```

타워는 기동할 때 기본 플레이북을 **멱등하게** 시드한다(로그: `기본 플레이북 시드: N건 생성`).
끄려면 `SANGFOR_TOWER_SEED_PLAYBOOKS=0`.

## 1. 기본 제공 플레이북

| seedKey | 내용 | 조건 |
|---|---|---|
| `tower-selfcheck` | `store_health` → `rag_index_summary` → `list_spec_coverage` → 리포트 | 항상 1건 |
| `device-checkup:<deviceId>` | 해당 벤더의 `advisorTools` 전부 → 리포트 | 등록 장비 1대당 1건 |

장비별 블록은 `data/registry/vendors.json`의 `advisorTools`에서 유도한다 — product를
코드에 박지 않으므로 벤더를 추가하면 시드도 따라온다. 장비를 새로 등록한 뒤에는
UI의 **기본 플레이북 시드** 버튼(또는 `POST /api/playbooks/seed`)으로 그 장비 몫만 추가된다.

시드된 rev 1은 `draft`다. 시드가 승인 게이트를 우회하지 않는다.

## 2. 승인 → 실행 → 리포트

```bash
T=$SANGFOR_API_TOKEN; B=http://127.0.0.1:3700
curl -s $B/api/playbooks -H "authorization: Bearer $T"                     # id 확인
curl -s -X POST $B/api/playbooks/$PB/revisions/1/approve \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"reviewedBy":"jmpark"}'
curl -s -X POST $B/api/playbooks/$PB/execute \
  -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{}'
```

- 승인 전 실행은 `403 승인된 리비전이 없습니다`.
- 읽기전용 블록은 즉시 실행된다. **write/destructive 블록은 `pending_approval` run을
  만들고 실행을 멈춘다** — UI 승인 큐에서 승인하면 그 지점부터 재개된다.
- 블록 하나가 실패하면 이후 tool 블록은 건너뛰고 `report`만 실행된다(→ `partial`).
- 리포트는 `outputs/playbooks/<playbookRunId>.md`에 쓰인다. FAIL 표와 함께
  **미확인(INDETERMINATE) 항목**을 따로 싣는다 — 근거가 없어 판정하지 못한 항목을
  통과로 읽으면 안 된다.

블록 인자에 앞 블록 결과를 끼울 수 있다: `{{blocks.<blockId>.result.<dot.path>}}`.
문자열 전체가 템플릿이면 타입이 보존되고, 해석 실패는 그 블록을 `failed`로 만든다.

## 3. 에이전트 협업 루프 (MCP)

UI의 **AI 조립 요청 / AI 수정 요청 / AI 분석 요청** 버튼은 작업을 실행하지 않고
`agent-tasks.json` 큐에 `open` 작업만 넣는다. 실제 조립·분석은 외부 에이전트가 한다
(설계상 타워는 LLM을 내장하지 않고, **자동 폴링 데몬도 비범위**다 — 폴링 주체는 에이전트다).

Cursor/Claude 등 MCP client는 다음 9개 도구로 이 루프를 돈다. 타워 주소는
`SANGFOR_TOWER_URL`(기본 `http://127.0.0.1:3700`), 인증은 `SANGFOR_API_TOKEN`.

| 도구 | 성격 | 용도 |
|---|---|---|
| `sangfor_playbook_list` | read | 목록 + 활성 rev + 최근 실행 상태 |
| `sangfor_playbook_get` | read | 리비전·블록 전체 |
| `sangfor_playbook_run_status` | read | 유도 상태 + 블록별 runId + 제출된 분석 |
| `sangfor_playbook_agent_tasks` | read | `open` 작업 큐 조회 (여기서 일감을 집는다) |
| `sangfor_playbook_create` | write | draft rev 1 생성 |
| `sangfor_playbook_add_revision` | write | 수정 루프 — 새 draft rev 추가 |
| `sangfor_playbook_execute` | write | 활성 rev 실행 |
| `sangfor_playbook_submit_analysis` | write | append-only 분석(개선·제안) 제출 |
| `sangfor_playbook_close_agent_task` | write | 작업을 done으로 닫고 산출물 기록 |

전형적인 루프:

1. `playbook_agent_tasks` → `assemble` 작업을 집는다.
2. `playbook_create`로 draft를 제출한다 (블록 검증 실패는 400으로 그대로 돌아온다).
3. `playbook_close_agent_task`로 `{playbookId, note}`를 남기고 닫는다.
4. 사람이 UI에서 rev를 승인한다.
5. `playbook_execute` → `playbook_run_status`로 결과를 읽는다.
6. `playbook_submit_analysis`로 관찰·권고를 제출하고, 사람이 UI에서 채택/기각한다.
7. 채택된 권고는 `playbook_add_revision`으로 다음 draft가 된다.

### 경계 (의도된 제약)

- **리비전 승인/반려는 MCP에 없다.** 승인은 UI에서 사람이 한다. 도구가 승인을 대신하지 않는다.
- `playbook_execute`가 장비를 직접 바꾸지 않는다. write 블록에서 멈추고 별도 사람 승인을 기다린다.
- 블록의 `toolId`로 `sangfor_playbook_*`를 쓸 수 없다(400). 플레이북 중첩 실행은 비범위다.
- 플레이북 상태의 기록자는 타워 하나다. 다른 프로세스가 `data/registry/playbooks.json`을
  직접 쓰면 atomic-rename이 서로를 덮어 유실된다.

## 4. 트러블슈팅

| 증상 | 원인 / 조치 |
|---|---|
| `control tower unreachable` | 타워 미기동 또는 `SANGFOR_TOWER_URL` 오설정 |
| `HTTP 401/403` | `SANGFOR_API_TOKEN`이 타워와 다르다 |
| `403 승인된 리비전이 없습니다` | rev를 아직 승인하지 않았다 |
| `bridge unreachable` | `:3600` 미기동 — 블록 run이 `failed`로 기록된다 |
| 실행이 `waiting_approval`에서 멈춤 | write 블록 대기 — UI 승인 큐에서 승인하면 재개 |
| `원본 인자 소실 — 재요청 필요` | 타워 재시작으로 in-memory 원본 인자가 사라졌다. 플레이북 run은 블록 정의에서 재해석되지만, 단일 도구 run은 재요청해야 한다 |
| 리포트가 "FAIL 없음"인데 `ok=false` | 미확인(INDETERMINATE) 섹션을 보라 — 근거 부족으로 판정하지 못한 항목이다 |
