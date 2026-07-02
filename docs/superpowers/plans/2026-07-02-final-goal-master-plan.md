# Sangfor Engineer MCP — 최종목표 완성 마스터플랜 (2026-07-02)

> **For agentic workers:** 이 계획은 **opencode**로 실행한다. 태스크 단위 실행 절차·프롬프트·게이트는 **Part 9 (실행 방법 — opencode)** 를 먼저 읽을 것. Steps use checkbox (`- [ ]`) syntax for tracking. (Claude Code로 실행할 경우에만: superpowers:executing-plans 또는 superpowers:subagent-driven-development 사용.)

**Goal:** north-star("필드 엔지니어 1인 대체 → PM")를 향해, 현재 유일하게 비어 있는 **실행(execution) 계층**을 HCI/SCP 단일 가역 write 수직 슬라이스(mock-first)로 관통하고, 보안제품 read-only 자문 3서비스를 심화하며, 남은 신뢰 잔여물(R1 nonce 재사용, R3 원격 write 정책)을 봉인한다.

**Architecture:** 기존 4 apps + 27 packages 모노레포에 `@sangfor/hci-client`(Keystone v2.0 문서계약 기반, 무의존성 HTTP)와 `@sangfor/config-state`(XHR pool→ConfigState 매핑) 2개 패키지를 신설하고, `apps/mock-sangfor-console`을 OpenStack fixture 서버로 확장해 실장비/VPN 게이트와 무관하게 `plan → approve → apply → read-back verify → 복원` 파이프라인을 TDD로 완성한다. 실장비 단계(M3/M4)는 "코드 작성"이 아니라 "캡처·대조·승격" 이벤트로 축소된다.

**Tech Stack:** TypeScript ESM(NodeNext), pnpm 10.28.1 workspace, tsx 직접실행, Vitest, node:http/https(신규 클라이언트 무의존성), Playwright(기존 operator), Prisma(선택적 graceful degrade).

---

## 목차

- Part 1. 프로젝트 전체 분석 (2026-07-02 기준, 코드 근거)
- Part 2. 전략적 판단 — 작성자 의견
- Part 3. 마일스톤 로드맵 M0~M7 + 게이트
- Part 4. 상세 태스크 M0 (Task 1~4) — 신뢰 잔여 봉인
- Part 5. 상세 태스크 M1 (Task 5~13) — HCI 실행 수직 슬라이스 (mock-first)
- Part 6. 상세 태스크 M2 (Task 14~16) — 자문 3서비스 심화
- Part 7. 게이트드 마일스톤 M3~M6 — 런북 + 계약
- Part 8. M7 위임 확대 규칙 / 사용자 결정 필요 / 리스크 / 검증 명령

---

## Global Constraints (모든 태스크에 적용 — 위반은 리뷰 반려 사유)

1. **INDETERMINATE ≠ PASS.** 판정 불가·미관측·근거 없음은 절대 정상으로 세지 않는다. `ok`는 positive evidence가 있을 때만 true.
2. **날조 금지.** 기대값·설정값·인용은 데이터(매뉴얼 인용, 실측 캡처)에서만. 출처를 못 찾으면 항목을 추가하지 않는다.
3. **fail-closed.** 셀렉터/이름 매칭이 정확히 1건이 아니면 abort. secret 미설정이면 거부. 스토어/로더 오류는 기능 저하가 아니라 실행 거부.
4. **read-back oracle 전용.** HTTP 202나 화면 diff는 성공 증거가 아니다. 근거: 공식 HCI OpenAPI 문서 — *"If the quota is insufficient, the returned response code is still 202 but the volume capacity remains unchanged"* (`API_HCI_SCP_open-api_Eng.Ver` cinder §volume expand). 모든 verify는 독립 GET read-back으로만.
5. **write 게이트.** 모든 write는 `SignedApproval`(action-bound HMAC, `SANGFOR_OPERATOR_APPROVAL_SECRET`) + `SANGFOR_ALLOW_REAL_EXECUTION`(비-loopback 대상 시) + nonce 단일사용(Task 1 이후)을 통과해야 한다.
6. **추측 auth 코드 금지.** 실장비 캡처 전에 작성하는 인증 코드는 공식 문서 계약을 그대로 구현한 것만 허용하며 `HCI_AUTH_CONTRACT_STATUS = 'doc_contract_unverified_on_real_device'` 라벨을 항상 노출한다. Janus(SCP) 인증은 캡처(M4) 전 구현 금지.
7. **검증 명령.** 각 태스크 완료 시 `pnpm test && pnpm run lint` 통과 필수(전체 기존 214 tests 포함). 빌드 영향 태스크는 `pnpm run build`도.
8. **커밋 규약.** Conventional Commits(`feat(scope):`, `fix(scope):`, `docs:`), 태스크당 1커밋 이상, 테스트와 구현을 같은 커밋에.
9. **시크릿 금지.** 실 자격증명·토큰·VPN 비밀번호를 코드/fixture/계획서에 커밋하지 않는다. 감사 원장은 마스킹 후 기록.
10. **신규 패키지 등록 3종 세트.** `packages/<name>/package.json`(`{"name":"@sangfor/<short>","type":"module","main":"src/index.ts"}`) + `tsconfig.json`의 `paths` + `vitest.config.ts`의 `alias`. 등록 후 `pnpm install`로 워크스페이스 링크.
11. **MCP 신규 도구 annotations 의무.** mutator는 `apps/mcp-server/src/index.ts`의 `WRITE_TOOLS`(줄 521~533) 또는 `DESTRUCTIVE_TOOLS`(줄 511~518)에 반드시 등록하고 `tests/mcp-tool-annotations.test.ts`의 개수/집합 검증을 갱신한다(현재 66 도구 = D6/W30/R30).
12. **작업 브랜치.** 마일스톤별 브랜치(`feat/m0-trust-residuals`, `feat/m1-hci-slice`, `feat/m2-advisory-depth`)에서 작업, 마일스톤 완료 시 main 머지.
13. **한국어 산출물.** 리포트·가이드·사용자 대면 문서는 한국어(코드 주석·식별자는 영어).

---

# Part 1. 프로젝트 전체 분석 (2026-07-02 기준)

## 1.1 시스템이 이미 완성한 것

| 계층 | 상태 | 근거 |
|------|------|------|
| ITAC Excel → 제품 매핑 → 변경계획 → DOCX/PPTX 가이드 | **완성** | `packages/sangfor-product-adapters`(Excel unzip 파싱, docx-builder), `sangfor-pptx`. outputs/에 v6 산출물 19종 |
| 위험도 분류·승인 게이트 | **완성** | `sangfor-approval`(keyword 4단계), SignedApproval HMAC(`sangfor-operator/src/approval.ts`) |
| 자문 서비스②(설정 후 검증)·③(진단) | **완성(1차)** | `sangfor-spec`(evaluateSpec, INDETERMINATE≠PASS 코드 강제), 실장비 진단 산출 `outputs/diagnosis/{EPP_6.0.4,IAG_13.0.120}_live_diagnosis.{md,docx}` |
| RAG 지식 | **완성(해시 임베딩)** | `data/rag/index.json` 4,756청크(HCI 2478/IAG 853/NDR 566/EPP 462/CC 397), 전부 official |
| 안전 게이트 | **완성(잔여 2건)** | operator HMAC 승인(H1), pm keyed 해시체인(H2), wiki 토큰(H3), http-bridge annotations 기반 fail-closed 인가, 127.0.0.1 기본 바인드+Bearer. 테스트 214 pass, tsc/lint clean |
| PM 데이터 골격 | **완성(엔진 아님)** | `sangfor-pm`(Engagement/WorkItem/PmEvent 해시체인 + DeviceOccupancy 락) |
| 정직한 대체율 | **완성** | `sangfor-competency`(evidence 실파일 필수, 현재 12.5% = 2/16 atoms) |
| MCP 표면 | 66 도구 | `apps/mcp-server/src/index.ts:54-507`, D6/W30/R30 annotations |

## 1.2 비어 있는 것 — 코드 근거

| # | 갭 | 근거 (파일:줄) |
|---|-----|---------------|
| G1 | **실행기 미부착** — 모든 게이트 통과 후에도 mutation 0 | `packages/sangfor-product-adapters/src/index.ts:624` — `reason: 'Execution gate passed. Real executor is not attached in this package yet; no mutation was performed.'` |
| G2 | **HCI/SCP HTTP 클라이언트 0** — `apiCatalogStatus:'ready'`는 문자열 카탈로그뿐 | 같은 파일 `HCI_SCP_ENDPOINTS`(187-195): `POST /janus/v2/public-key`, `GET /openstack/volume/v2/volumes` 등 문자열만. janus/keystone 구현 파일 0개 |
| G3 | **R1: 승인 nonce 재사용** — 만료창 내 동일 (action,nonce,expiresAt) 재사용 가능 | `packages/sangfor-operator/src/approval.ts:13-15` 주석으로 정직하게 문서화됨 |
| G4 | **R3: 원격 write 정책 미명문화** — `WHELP99_ENFORCE_SAFE_TOOLS=false` + 공개 바인드 + 토큰이면 원격 write 호출 가능 | `apps/http-bridge/src/tool-guard.ts:44-61` (destructive는 항상 차단, write는 토글에만 의존) |
| G5 | dry-run이 `navigate/scroll/wait`를 실제 수행(비파괴지만 무제한 URL) | `packages/sangfor-operator/src/index.ts:452` 부근 — dry-run 단락은 click/type/select만 가드 |
| G6 | 문서 드리프트 — 폐기된 `SANGFOR_OPERATOR_APPROVAL_TOKEN`이 여전히 표기 | `docs/INCLUDED_HIGH_RISK_SCOPE.md` "Non-negotiable controls" §3 |
| G7 | ConfigState 수집이 스크립트 산개(라이브러리·MCP 도구 미통합) | `scripts/epp-diagnose.ts`(34줄, /tmp 하드코딩), `scripts/device-collect.ts` |
| G8 | CC ConfigState 미수집(0회), IAG deep-config 판정불가 3건 잔존 | `docs/DEVICE_DIAGNOSIS_RUNBOOK.md` "다음 개선" |

**이미 해소된 것으로 확인(계획 불필요):** 제안서의 operator blind-write(`:372`)와 firstMatch(`:356`)는 현재 코드에 없음 — `clickUniqueTextTarget/typeUniqueInputTarget/selectUniqueTarget`이 매칭≠1이면 `strictTargetError`로 throw(fail-closed 완료). verifier `:379` false-pass도 수정 완료(`computeLiveVerificationOk`).

## 1.3 데이터·문서 자산

- **Spec 시드:** `data/specs/` 6제품 7파일 24항목 (CC 3.0.98/EPP 6.0.4/HCI 6.11.3/IAG 13.0.120×2/NGFW 8.0.107/XDR 3.0.98).
- **HCI/SCP OpenAPI 원문:** `/Volumes/My Passport/00. Attached/5. HCI/API_HCI_SCP_open-api_Eng.Ver- Overview & user guide.docx` (2026-07-02 마운트·추출 검증 완료. Keystone v2.0 tokens 요청/응답, cinder volume CRUD, X-Client-Token 멱등, 202-무변경 함정이 전부 예제와 함께 명시).
- **수집 매뉴얼:** 외장드라이브 `_SupportDocs/` PDF 4종 + IAG(224섹션)/XDR(180섹션) 마크다운 크롤 → 이미 RAG 인제스트됨.
- **safety/competency:** `data/safety/capability-safety.json`(기본 human_only), `data/competency/{work-atoms,capability-maturity}.json` (물리 분리 유지).
- **실장비:** EPP 10.80.1.106 / CC .107 / IAG .108 — **FortiClient VPN 필요(현재 미연결)**. HCI 실장비는 **존재/접근 미확인**(§Part 8 결정 1).

## 1.4 접근성 현실 (2026-07-02)

- 장비망 10.80.1.x는 VPN 없이는 도달 불가(`curl` 타임아웃 검증됨). FortiClient GUI 자동 구동은 화면기록/접근성 권한 블로커로 미해결 → **사람이 Connect하는 것이 M3 게이트**.
- 백업파일(.bcf/.zip/.info)은 암호화 확정 → ConfigState는 **라이브 backend read로만**. 백업 파서 트랙은 영구 drop.
- 실장비 브라우저 조작 경로 = aside-browser 스킬(ExtJS는 snapshot, Vue SPA는 XHR 캡처).

---

# Part 2. 전략적 판단 — 작성자 의견

**의견 1. "최종목표 완성"은 기능 목록이 아니라 신뢰 사다리다.**
사용자가 2026-07-02 명시했듯 "1인 대체 → PM"은 먼 north-star이지 지금의 build target이 아니다. 위임은 신뢰의 부산물로 열린다. 따라서 이 계획의 각 마일스톤은 "기능 추가"가 아니라 **검증 가능한 증적(evidence) 1개씩을 산출**하도록 설계했다: M0=재사용 불가 승인, M1=mock에서 무인 apply→verify→복원 완주 증적, M2=진단 커버리지 확대, M3/M4=실장비 증적. `data/competency`의 field_verified 승격은 항상 증거 파일 링크와 함께만 한다.

**의견 2. mock-first가 옳다 — 게이트를 기다리며 멈추지 말 것.**
기존 제안서는 "Phase 0 실장비 인증 spike가 전체 게이트"라 했지만, 이번 분석에서 **OpenAPI 문서가 요청/응답 예제까지 완전한 계약을 제공함을 실측 확인**했다(문서 추출 검증 완료). 따라서 클라이언트·상태기계·read-back·감사원장 전부를 문서 계약 + mock fixture로 지금 TDD 가능하다. 실장비 spike는 "구현 착수 조건"이 아니라 "**mock과 실장비의 계약 드리프트를 대조하는 검증 이벤트**"로 역할이 바뀐다. 이것이 이 계획과 기존 제안서의 가장 큰 차이다.

**의견 3. 인증 리스크는 하향 조정한다(근거 있음).**
제안서가 우려한 "Janus public-key 핸드셰이크 미상"은 **HCI aCMP OpenAPI에는 해당 없음** — 문서 전문 검색 결과 public-key/RSA/encrypt 언급 없이 표준 Keystone v2.0 `passwordCredentials` 평문 JSON(TLS 위)이다. Janus는 SCP 쪽 카탈로그(`/janus/v2/*`)에만 남아 있으므로, **1차 타깃을 SCP가 아닌 HCI(aCMP) OpenAPI로 고정**하고 Janus는 M4 캡처 뒤로 미룬다. 남은 실질 리스크는 "랩에 HCI 장비가 있는가 + OpenAPI 기능/tenant 계정이 활성인가"로 이동했다(§Part 8 결정 1·2).

**의견 4. read-back oracle은 취향이 아니라 벤더 문서가 강제하는 사실이다.**
공식 문서에 "쿼터 부족 시에도 202를 반환하지만 용량은 불변"이 명시돼 있다. 이 함정을 mock에 시나리오로 심어(`X-Mock-Scenario: quota-silent-noop`) **"202를 믿으면 실패하는 회귀 테스트"를 영구 게이트**로 만든다(Task 6/13). false-pass 방지 원칙이 HCI 트랙에도 코드로 박힌다.

**의견 5. 부록A의 디스커버리 게이트 중 2개는 이미 통과했다 — 계획을 갱신해야 한다.**
(a) "EPP/CC 콘솔 매뉴얼 0종" → 2026-07-01 support.sangfor.com 수집으로 EPP 462·CC 397청크 확보, 해소. (b) "백업 포맷 스파이크" → 암호화 확정으로 백업 트랙 영구 drop, 라이브 read로 대체 확정. 남은 게이트는 "실장비 버전 확정"(M3) 하나다. 따라서 spec 확대(Task 16)는 게이트 없이 즉시 가능하다.

**의견 6. 보안제품 write는 이 계획에서도 영구 자문이다.**
EPP/IAG/CC/NDR 자동 write는 로드맵에 없다(부록A 결론 유지). AI↔사람 경계 6+6 원칙 그대로. HCI/SCP 자동 write와 병존.

**의도적으로 하지 않는 것(defer/drop 재확인):** prune/delete·비가역 op(복원용 delete-volume은 destructive 도구로 격리), 자동 역방향 롤백(단일 가역 op 외), 비공식 XHR API 디스커버리, PM 엔진(CPM/자동 dispatch), KPI 대시보드, 파인튜닝 잡 제출, RAG 임베딩 승격(hash→semantic, 설계문서 존재하나 우선순위 아님), 백업 파서.

---

# Part 3. 마일스톤 로드맵

```
[지금 실행 가능 — 게이트 없음]
 M0 신뢰 잔여 봉인          Task 1~4    (~3일)
 M1 HCI 실행 수직 슬라이스   Task 5~13   (~2·3주, mock-first)   ← 실행계층 갭 G1·G2를 닫는 본체
 M2 자문 3서비스 심화        Task 14~16  (~1주, M1과 병렬 가능)

[게이트드 — 사람/장비 조건 필요]
 M3 (게이트 G-VPN: FortiClient 연결)     실장비 read-only 캠페인: CC 최초 수집·IAG deep·버전 확정
 M4 (게이트 G-HCI: HCI 장비+tenant 계정)  인증 캡처·계약 대조 → read-only smoke → create-volume 실장비 1회 관통 → 승격
 M5 (게이트 M3 통과)                      EPP/CC spec 확대 심화
 M6 (게이트 M4 통과)                      HCI 운영점검 리포트 + 주기 진단 + 정직한 대체율 갱신

[north-star]
 M7 위임 확대 반복 규칙 (빌드 아님 — Part 8 §M7)
```

| 마일스톤 | Exit Criteria (전부 충족 시 완료) |
|----------|----------------------------------|
| M0 | 동일 nonce 승인 2회째 거부 회귀테스트, 원격 write 기본 거부 회귀테스트, navigate origin 가드, 문서 드리프트 0 |
| M1 | mock에서 ①같은 X-Client-Token 재시도 중복생성 0 ②quota-silent-noop 주입 시 FAILED_HALT(read-back FAIL) ③사람 개입 0회 apply→verify→(승인된)복원 완주 ④전 과정 마스킹 원장 기록·체인 검증 ⑤read-back≠기대 시 자동 halt(false-pass 0) |
| M2 | `sangfor.collect_device_config`로 pool 파일→진단 리포트 원스톱, context_dependent 분류 동작, spec 24→40+ 항목(전부 출처 인용) |
| M3 | 3장비 진단 리포트 갱신, CC ConfigState ≥5키, 실장비 버전 진실표 문서화 |
| M4 | 제안서 §5 Exit Criteria 5항목 전부(실장비), safety_class·maturity 증거 링크와 함께 승격 |
| M5 | EPP/CC spec이 실장비 버전과 정확 일치 디렉터리로 확장 |
| M6 | HCI 헬스 DOCX 리포트 + launchd 주기 진단 + 대체율 리포트 자동 갱신 |

---

# Part 4. 상세 태스크 — M0 신뢰 잔여 봉인

### Task 1: 승인 nonce 단일사용 store (redteam R1 봉인)

**Files:**
- Create: `packages/sangfor-operator/src/nonce-store.ts`
- Modify: `packages/sangfor-operator/src/index.ts:178-197` (`assertRealExecutionAllowed`)
- Modify: `packages/sangfor-operator/src/approval.ts:13-15` (잔여 주석 갱신)
- Modify: `.env.example` (SANGFOR_NONCE_STORE_PATH 추가)
- Test: `tests/operator-nonce-store.test.ts`

**Interfaces:**
- Consumes: `verifyExecutionApproval`(approval.ts), `resolveRepoData(subdir: string, envVar?: string): string`(@sangfor/shared), `LiveExecutionApproval`(nonce/expiresAt 필드 존재 확인됨, index.ts:47-56)
- Produces: `FileNonceStore.consume(nonce, expiresAt, now?): { ok: boolean; reason?: string }`, `consumeApprovalNonce(approval: { nonce: string; expiresAt: string }, now?: Date)` — Task 12의 HCI apply 도구도 이 함수를 재사용한다.

- [ ] **Step 1: 실패 테스트 작성** — `tests/operator-nonce-store.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileNonceStore } from '../packages/sangfor-operator/src/nonce-store.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import { assertRealExecutionAllowed, startOperatorSession } from '@sangfor/operator';

const future = () => new Date(Date.now() + 5 * 60_000).toISOString();

describe('FileNonceStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nonce-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rejects the second consumption of the same nonce (replay)', () => {
    const store = new FileNonceStore(join(dir, 'nonces.json'));
    expect(store.consume('n1', future()).ok).toBe(true);
    const replay = store.consume('n1', future());
    expect(replay.ok).toBe(false);
    expect(replay.reason).toMatch(/already used/);
  });

  it('allows distinct nonces', () => {
    const store = new FileNonceStore(join(dir, 'nonces.json'));
    expect(store.consume('n1', future()).ok).toBe(true);
    expect(store.consume('n2', future()).ok).toBe(true);
  });

  it('garbage-collects expired records (an expired nonce may be re-consumed; expiry itself is rejected upstream)', () => {
    const path = join(dir, 'nonces.json');
    writeFileSync(path, JSON.stringify({ consumed: [{ nonce: 'old', expiresAt: new Date(Date.now() - 1000).toISOString(), consumedAt: new Date().toISOString() }] }));
    const store = new FileNonceStore(path);
    expect(store.consume('old', future()).ok).toBe(true);
  });

  it('fails closed when the store file is corrupt', () => {
    const path = join(dir, 'nonces.json');
    writeFileSync(path, 'not-json');
    const result = new FileNonceStore(path).consume('n1', future());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fail-closed/);
  });
});

describe('assertRealExecutionAllowed + nonce single-use', () => {
  let dir: string;
  const OLD = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nonce-gate-'));
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = 'test-secret';
    process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
  });
  afterEach(() => {
    process.env = { ...OLD };
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a verified approval when its nonce was already consumed', () => {
    const session = startOperatorSession({ mode: 'lab', product: 'HCI', targetUrl: 'https://10.80.1.9' });
    const action = { type: 'click', target: '#save', dryRun: false } as const;
    const base = { approvedBy: 'tester', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1', nonce: 'once-only', expiresAt: future() };
    const approval = { ...base, approvalToken: signApprovalToken('test-secret', { type: action.type, target: action.target }, base) };
    expect(() => assertRealExecutionAllowed(session, action as never, approval)).not.toThrow();
    expect(() => assertRealExecutionAllowed(session, action as never, approval)).toThrow(/already used/);
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm exec vitest run tests/operator-nonce-store.test.ts` → FAIL ("nonce-store.js를 찾을 수 없음").
  주의: `startOperatorSession` 입력 필드명이 다르면 `tests/operator-execution-gate.test.ts`의 arrange 패턴에 맞춰 조정(동작 기대치는 불변).

- [ ] **Step 3: 구현** — `packages/sangfor-operator/src/nonce-store.ts`

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveRepoData } from '@sangfor/shared';

// Durable single-use store for live-execution approval nonces (closes redteam R1:
// replay of a verified (action, nonce, expiresAt) tuple within its expiry window).
// Fail-closed: any storage error refuses consumption, which refuses execution.

export interface NonceConsumeResult { ok: boolean; reason?: string; }

interface StoreShape { consumed: Array<{ nonce: string; expiresAt: string; consumedAt: string }>; }

export function defaultNonceStorePath(): string {
  return process.env.SANGFOR_NONCE_STORE_PATH ?? join(resolveRepoData('runtime'), 'approval-nonces.json');
}

export class FileNonceStore {
  constructor(private readonly filePath: string = defaultNonceStorePath()) {}

  consume(nonce: string, expiresAt: string, now: Date = new Date()): NonceConsumeResult {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const state = this.load();
      const live = state.consumed.filter((r) => new Date(r.expiresAt).getTime() >= now.getTime());
      if (live.some((r) => r.nonce === nonce)) {
        return { ok: false, reason: `approval nonce already used: ${nonce}` };
      }
      live.push({ nonce, expiresAt, consumedAt: now.toISOString() });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ consumed: live }, null, 2));
      renameSync(tmp, this.filePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `nonce store unavailable (fail-closed): ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private load(): StoreShape {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreShape;
      if (!parsed || !Array.isArray(parsed.consumed)) throw new Error('nonce store shape invalid');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { consumed: [] };
      throw error; // corrupt store must fail closed, not silently reset
    }
  }
}

let sharedStore: FileNonceStore | null = null;
let sharedStorePath: string | null = null;

export function consumeApprovalNonce(approval: { nonce: string; expiresAt: string }, now?: Date): NonceConsumeResult {
  const path = defaultNonceStorePath();
  if (!sharedStore || sharedStorePath !== path) {
    sharedStore = new FileNonceStore(path);
    sharedStorePath = path;
  }
  return sharedStore.consume(approval.nonce, approval.expiresAt, now);
}
```

`packages/sangfor-operator/src/index.ts` — ① import 추가 ② `assertRealExecutionAllowed`의 `if (!verdict.ok) { throw ... }` 직후에 삽입 ③ 패키지 재수출:

```ts
import { consumeApprovalNonce } from './nonce-store.js';
// ... assertRealExecutionAllowed 내부, verdict 검증 통과 직후:
  // Single-use: a verified approval consumes its nonce; replay within the
  // expiry window is rejected by the durable store (closes redteam R1).
  const consumed = consumeApprovalNonce({ nonce: approval!.nonce, expiresAt: approval!.expiresAt });
  if (!consumed.ok) {
    throw new Error(`Live execution approval rejected: ${consumed.reason}.`);
  }
// ... 파일 하단 재수출부에:
export { FileNonceStore, consumeApprovalNonce, defaultNonceStorePath } from './nonce-store.js';
```

`approval.ts:13-15`의 잔여(Residual) 주석을 다음으로 교체: `// Single-use enforcement lives in ./nonce-store (FileNonceStore) — a verified nonce is consumed durably; replay within the window is rejected.`
`.env.example` 안전 게이트 섹션에 추가: `# SANGFOR_NONCE_STORE_PATH=  # (선택) 승인 nonce 단일사용 store 경로. 기본 data/runtime/approval-nonces.json`
`data/runtime/`은 `.gitignore`에 추가(런타임 상태는 커밋 금지).

- [ ] **Step 4: 통과 확인** — `pnpm exec vitest run tests/operator-nonce-store.test.ts` → PASS. 이어서 `pnpm test && pnpm run lint` 전체 통과(기존 operator-approval/execution-gate 스위트가 nonce 재사용을 하지 않는지 확인 — 재사용 시 각 테스트에 고유 nonce 부여로 수정).
- [ ] **Step 5: 커밋** — `git add -A && git commit -m "feat(operator): durable single-use nonce store closes approval replay (redteam R1)"`

---

### Task 2: 원격 write 정책 명문화 + 코드화 (redteam R3 봉인)

**Files:**
- Modify: `apps/http-bridge/src/tool-guard.ts` (`authorizeToolCall` 확장)
- Modify: `apps/http-bridge/src/server.ts:167-176` (파라미터 전달)
- Modify: `packages/shared/src/index.ts` (loopback 판정 함수 export — 이미 내부에 있으면 export만)
- Modify: `.env.example`, `docs/INCLUDED_HIGH_RISK_SCOPE.md`
- Test: `tests/http-bridge-authorize.test.ts` (케이스 추가)

**Interfaces:**
- Consumes: 기존 `authorizeToolCall({ name, toolListResult, enforceWhitelist })`, shared의 `assertBindSafety`가 내부 사용하는 loopback 판정(127/8 + IPv6-mapped + '::1' + 빈 문자열→loopback, commit 357d239 참조)
- Produces: `authorizeToolCall(params: { name: string; toolListResult: unknown; enforceWhitelist: boolean; remoteBind?: boolean; allowRemoteWrite?: boolean }): ToolAuthDecision`, shared `isLoopbackHost(host: string): boolean`

**정책(문서화되는 불변식):** ① destructive는 어떤 조건에서도 원격 거부(기존 유지) ② **비-loopback 바인드에서 write 도구는 `WHELP99_ENFORCE_SAFE_TOOLS=false`여도 거부** ③ 예외는 `SANGFOR_ALLOW_REMOTE_WRITE=true`를 명시했을 때만(이때도 `SANGFOR_API_TOKEN` 필수 — 기존 `assertBindSafety`가 보장) ④ loopback 바인드는 기존 동작 불변.

- [ ] **Step 1: 실패 테스트 추가** — `tests/http-bridge-authorize.test.ts`에 append (기존 헬퍼 `toolList(...)` 형태가 있으면 재사용, 없으면 아래 인라인 사용):

```ts
const listWith = (name: string, readOnlyHint: boolean, destructiveHint: boolean) =>
  ({ tools: [{ name, annotations: { readOnlyHint, destructiveHint } }] });

describe('remote write policy (R3)', () => {
  it('refuses a write tool on a remote bind even with the whitelist disabled', () => {
    const d = authorizeToolCall({ name: 'w', toolListResult: listWith('w', false, false), enforceWhitelist: false, remoteBind: true, allowRemoteWrite: false });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/remote/i);
  });
  it('allows a write tool on a remote bind only with explicit SANGFOR_ALLOW_REMOTE_WRITE', () => {
    const d = authorizeToolCall({ name: 'w', toolListResult: listWith('w', false, false), enforceWhitelist: false, remoteBind: true, allowRemoteWrite: true });
    expect(d.allow).toBe(true);
  });
  it('still refuses destructive tools remotely regardless of every toggle', () => {
    const d = authorizeToolCall({ name: 'x', toolListResult: listWith('x', false, true), enforceWhitelist: false, remoteBind: true, allowRemoteWrite: true });
    expect(d.allow).toBe(false);
  });
  it('read-only tools are unaffected by remote bind', () => {
    const d = authorizeToolCall({ name: 'r', toolListResult: listWith('r', true, false), enforceWhitelist: true, remoteBind: true, allowRemoteWrite: false });
    expect(d.allow).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인** — 해당 파일만 실행 → 새 4케이스 FAIL.
- [ ] **Step 3: 구현** — `tool-guard.ts`의 `authorizeToolCall`을 다음으로 교체(기존 불변식 주석 유지+확장):

```ts
export function authorizeToolCall(params: {
  name: string;
  toolListResult: unknown;
  enforceWhitelist: boolean;
  remoteBind?: boolean;        // bridge is bound beyond loopback
  allowRemoteWrite?: boolean;  // SANGFOR_ALLOW_REMOTE_WRITE === 'true'
}): ToolAuthDecision {
  const { name, toolListResult, enforceWhitelist, remoteBind = false, allowRemoteWrite = false } = params;
  const annotations = findToolAnnotations(toolListResult, name);
  if (!annotations) {
    return { allow: false, status: 403, error: `Tool annotations unavailable; refusing call: ${name}` };
  }
  if (annotations.destructiveHint) {
    return { allow: false, status: 403, error: `Destructive tool refused by MCP annotations: ${name}` };
  }
  const isWrite = annotations.readOnlyHint !== true;
  if (isWrite && remoteBind && !allowRemoteWrite) {
    return { allow: false, status: 403, error: `Write tool refused on a remote (non-loopback) bind: ${name}. Set SANGFOR_ALLOW_REMOTE_WRITE=true only for an authorized deployment.` };
  }
  if (enforceWhitelist && !isToolAllowedByAnnotations(toolListResult, name)) {
    return { allow: false, status: 403, error: `Tool is not annotated read-only: ${name}` };
  }
  return { allow: true };
}
```

`packages/shared/src/index.ts`: `assertBindSafety`가 쓰는 loopback 판정이 비공개 함수라면 이름을 `isLoopbackHost`로 export(로직 이동 금지, export만). 없다면 추가:

```ts
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '' || h === 'localhost' || h === '::1') return true;
  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h;
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m !== null && Number(m[1]) === 127;
}
```

`apps/http-bridge/src/server.ts`: import에 `isLoopbackHost` 추가, 상수 2개, 호출부 확장:

```ts
const REMOTE_BIND = !isLoopbackHost(BIND_HOST);
const ALLOW_REMOTE_WRITE = process.env.SANGFOR_ALLOW_REMOTE_WRITE === "true";
// /tools/call 내:
const decision = authorizeToolCall({ name, toolListResult: list.error ? null : list.result, enforceWhitelist, remoteBind: REMOTE_BIND, allowRemoteWrite: ALLOW_REMOTE_WRITE });
```

`.env.example`에 `# SANGFOR_ALLOW_REMOTE_WRITE=  # 기본 미설정 = 비-loopback 바인드에서 write 도구 전면 거부(R3). true는 승인된 배포에서만.` 추가.
`docs/INCLUDED_HIGH_RISK_SCOPE.md` "Non-negotiable controls"에 항목 추가: `8. Over HTTP (http-bridge): destructive tools are always refused; write tools are refused on a non-loopback bind unless SANGFOR_ALLOW_REMOTE_WRITE=true (and a bearer token is mandatory on any non-loopback bind).`

- [ ] **Step 4: 통과 확인** — `pnpm exec vitest run tests/http-bridge-authorize.test.ts tests/http-bridge-guard.test.ts tests/http-guard.test.ts` PASS 후 전체 `pnpm test && pnpm run lint`.
- [ ] **Step 5: 커밋** — `git commit -m "feat(http-bridge): refuse remote writes by default; explicit SANGFOR_ALLOW_REMOTE_WRITE opt-in (redteam R3)"`

---

### Task 3: dry-run navigate origin 가드

**Files:**
- Modify: `packages/sangfor-operator/src/index.ts` (`executeLiveConsoleAction` 도입부)
- Test: `tests/operator-fail-closed.test.ts` (케이스 추가)

**Interfaces:**
- Produces: `assertNavigationWithinTarget(session: { targetUrl?: string }, action: { type: string; target?: string }): void` (export — 단위 테스트 대상)

**배경:** dry-run 단락(click/type/select만 가드)에서 `navigate/scroll/wait`는 실제 수행된다. 의미론은 유지하되(관찰은 dry-run의 목적), navigate가 세션 origin 밖으로 나가는 것만 fail-closed로 막는다.

- [ ] **Step 1: 실패 테스트** — `tests/operator-fail-closed.test.ts`에 추가:

```ts
import { assertNavigationWithinTarget } from '@sangfor/operator';

describe('navigate origin guard', () => {
  it('allows same-origin and relative navigation', () => {
    const s = { targetUrl: 'https://10.80.1.9/console' };
    expect(() => assertNavigationWithinTarget(s, { type: 'navigate', target: 'https://10.80.1.9/vols' })).not.toThrow();
    expect(() => assertNavigationWithinTarget(s, { type: 'navigate', target: '/vols' })).not.toThrow();
    expect(() => assertNavigationWithinTarget(s, { type: 'click', target: 'Save' })).not.toThrow();
  });
  it('blocks cross-origin navigation even in dry-run', () => {
    const s = { targetUrl: 'https://10.80.1.9/console' };
    expect(() => assertNavigationWithinTarget(s, { type: 'navigate', target: 'https://evil.example/x' })).toThrow(/outside the session origin/);
  });
  it('blocks navigate without a session targetUrl', () => {
    expect(() => assertNavigationWithinTarget({}, { type: 'navigate', target: 'https://10.80.1.9/' })).toThrow(/targetUrl/);
  });
});
```

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — index.ts에 추가하고 `executeLiveConsoleAction`에서 `assertRealExecutionAllowed(...)` 호출 직후(즉 dry-run 여부와 무관하게) 호출:

```ts
export function assertNavigationWithinTarget(session: { targetUrl?: string }, action: { type: string; target?: string }): void {
  if (action.type !== 'navigate' || !action.target) return;
  if (!session.targetUrl) throw new Error('navigate requires a session targetUrl.');
  const origin = new URL(session.targetUrl);
  const target = new URL(action.target, origin);
  if (target.origin !== origin.origin) {
    throw new Error(`navigate blocked: ${target.origin} is outside the session origin ${origin.origin} (fail-closed).`);
  }
}
```

- [ ] **Step 4: 통과 확인 + 전체 스위트.**
- [ ] **Step 5: 커밋** — `git commit -m "fix(operator): pin dry-run navigate to the session origin (fail-closed)"`

---

### Task 4: 문서 드리프트 제거

**Files:**
- Modify: `docs/INCLUDED_HIGH_RISK_SCOPE.md` (§Non-negotiable controls)

- [ ] **Step 1:** 항목 3·4를 현행 SignedApproval 체계로 교체:

```markdown
3. `SANGFOR_OPERATOR_APPROVAL_SECRET` set in the runtime environment (server-side HMAC key; approvals are unforgeable without it — fail-closed)
4. Tool call approval payload containing a **signed, action-bound, time-bound approval**:
   - `approvedBy`, `changeTicketId`, `rollbackPlanId`
   - `nonce` (single-use — replay is rejected by a durable store)
   - `expiresAt` (ISO 8601; expired approvals are rejected)
   - `approvalToken` = HMAC-SHA256 over (fields above + action type + action target)
```

- [ ] **Step 2:** 같은 문서에 Task 2에서 추가한 원격 write 정책 항목이 반영됐는지 재확인(중복 추가 금지).
- [ ] **Step 3:** `grep -rn "SANGFOR_OPERATOR_APPROVAL_TOKEN" docs/ README.md` → 0건 확인.
- [ ] **Step 4: 커밋** — `git commit -m "docs: high-risk scope reflects signed approvals + remote-write policy"`

---

# Part 5. 상세 태스크 — M1 HCI 실행 수직 슬라이스 (mock-first)

> 목적: 갭 G1(실행기 미부착)·G2(HCI 클라이언트 0)를 **실장비 없이** 닫는다. 모든 코드는 공식 OpenAPI 문서(`API_HCI_SCP_open-api_Eng.Ver- Overview & user guide.docx`, © 2020 Sangfor)의 예제 계약을 그대로 구현하고, `doc_contract_unverified_on_real_device` 라벨로 정직성을 유지한다. M4에서 실장비 캡처와 대조 후 라벨을 승격한다.

### Task 5: HCI OpenAPI 카탈로그 + fixture 커밋

**Files:**
- Create: `data/hci-api/catalog.json`
- Create: `tests/fixtures/hci-openapi/tokens-request.json`
- Create: `tests/fixtures/hci-openapi/tokens-response.json`
- Create: `tests/fixtures/hci-openapi/volume-create-response.json`
- Create: `tests/fixtures/hci-openapi/volume-detail-available.json`
- Test: `tests/hci-catalog.test.ts`

**Interfaces:**
- Produces: `data/hci-api/catalog.json` — Task 6(mock)·Task 7(client)·M4(대조)의 단일 진실원. `contractStatus` 필드는 M4 전까지 `doc_contract_unverified_on_real_device` 고정.

- [ ] **Step 1: fixture 4종 작성** (전부 공식 문서 예제에서 발췌·축약 — 값 창작 금지):

`tokens-request.json`:
```json
{
  "auth": {
    "tenantName": "lab",
    "passwordCredentials": { "username": "admin", "password": "REPLACE_AT_RUNTIME" }
  }
}
```

`tokens-response.json` (문서 §4.1 응답 예제의 구조 그대로, 값만 mock 표기):
```json
{
  "access": {
    "token": {
      "issued_at": "2026-07-02T00:00:00.000000Z",
      "expires": "2026-07-02T01:00:00.000000Z",
      "id": "mock-token-0001",
      "tenant": { "enabled": true, "description": "", "name": "lab", "id": "mocktenant0001" }
    },
    "serviceCatalog": [
      { "endpoints": [{ "publicURL": "http://127.0.0.1:3400/openstack/identity/v2.0" }], "type": "identity", "name": "keystone" },
      { "endpoints": [{ "publicURL": "http://127.0.0.1:3400/openstack/volume/v2/mocktenant0001" }], "type": "volume", "name": "cinder" },
      { "endpoints": [{ "publicURL": "http://127.0.0.1:3400/openstack/compute/v2" }], "type": "compute", "name": "nova" },
      { "endpoints": [{ "publicURL": "http://127.0.0.1:3400/openstack/image" }], "type": "image", "name": "glance" }
    ],
    "user": { "username": "admin", "roles": [{ "name": "tenant" }], "name": "admin" }
  }
}
```

`volume-create-response.json` (문서 cinder create 응답 구조):
```json
{
  "volume": {
    "status": "creating",
    "attachments": [],
    "availability_zone": "mock-az",
    "bootable": "false",
    "encrypted": false,
    "multiattach": false,
    "volume_type": null,
    "name": "volume_001",
    "description": "create volume",
    "snapshot_id": null,
    "source_volid": null,
    "id": "vol-0001",
    "size": 10
  }
}
```

`volume-detail-available.json`: 위와 동일 구조에 `"status": "available"`.

- [ ] **Step 2: 카탈로그 작성** — `data/hci-api/catalog.json`:

```json
{
  "source": {
    "document": "API_HCI_SCP_open-api_Eng.Ver- Overview & user guide.docx",
    "publisher": "Sangfor", "year": 2020,
    "location": "/Volumes/My Passport/00. Attached/5. HCI/",
    "contractStatus": "doc_contract_unverified_on_real_device"
  },
  "auth": {
    "type": "keystone_v2_password",
    "endpoint": "POST {base}/openstack/identity/v2.0/tokens",
    "requestShape": "auth.tenantName + auth.passwordCredentials{username,password}",
    "tokenHeader": "X-Auth-Token",
    "notes": ["serviceCatalog in the token response is the endpoint directory", "token has expires; refresh before expiry"]
  },
  "idempotency": {
    "header": "X-Client-Token",
    "rule": "same URL + same params + same X-Client-Token = same request; server returns the prior result without re-execution"
  },
  "services": {
    "identity": { "base": "{acmp}/openstack/identity/v2.0", "readOnly": ["GET /tenants"] },
    "volume": {
      "base": "{acmp}/openstack/volume/v2/{project_id}",
      "readOnly": ["GET /volumes", "GET /volumes/detail", "GET /volumes/{volume_id}"],
      "write": ["POST /volumes (202)", "PUT /volumes/{volume_id}", "DELETE /volumes/{volume_id} (202)"],
      "trap": "quota-exceeded extend returns 202 while the volume stays unchanged — 202 is NOT proof of effect; verify by GET read-back"
    },
    "compute": { "base": "{acmp}/openstack/compute/v2", "readOnly": ["GET /servers", "GET /servers/detail", "GET /servers/{id}", "GET /flavors", "GET /flavors/detail"] },
    "image": { "base": "{acmp}/openstack/image", "readOnly": ["GET /v2/images"] },
    "scpJanus": { "status": "capture_gated", "note": "SCP uses /janus/v2/public-key + /janus/v2/login; DO NOT implement before the M4 real-device capture" }
  }
}
```

- [ ] **Step 3: 테스트** — `tests/hci-catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('hci api catalog', () => {
  const catalog = JSON.parse(readFileSync('data/hci-api/catalog.json', 'utf8'));
  it('carries the honesty label until M4 verifies it on a real device', () => {
    expect(catalog.source.contractStatus).toBe('doc_contract_unverified_on_real_device');
  });
  it('pins the read-back trap note on the volume service', () => {
    expect(catalog.services.volume.trap).toMatch(/202 is NOT proof of effect/);
  });
  it('gates janus behind real-device capture', () => {
    expect(catalog.services.scpJanus.status).toBe('capture_gated');
  });
});
```

- [ ] **Step 4:** `pnpm exec vitest run tests/hci-catalog.test.ts` PASS → **커밋** `git commit -m "feat(hci): commit doc-contract API catalog + fixtures from official OpenAPI guide"`

---

### Task 6: mock-sangfor-console에 OpenStack fixture 서버 추가

**Files:**
- Create: `apps/mock-sangfor-console/src/openstack.ts`
- Modify: `apps/mock-sangfor-console/src/server.ts` (라우팅 연결 + 서버 팩토리 export)
- Test: `tests/mock-openstack.test.ts`

**Interfaces:**
- Consumes: Task 5 fixture의 응답 구조(키 이름을 그대로 재현)
- Produces: `createMockConsoleServer(): http.Server` (server.ts), `createOpenStackMock(): { handle(req, res): Promise<boolean>; stats(): { tokensIssued: number; volumeCreates: number } }` — Task 7~13의 모든 테스트 대상 서버. 고정 자격증명 `admin` / `mock-password` / tenant `lab`. 시나리오 헤더 `X-Mock-Scenario: quota-silent-noop`(202 반환하되 미생성 — 문서의 202-무변경 함정 재현). 테스트 전용 라우트 `POST /openstack/__mock/expire-tokens`.

- [ ] **Step 1: 실패 테스트** — `tests/mock-openstack.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';

let base = '';
let server: ReturnType<typeof createMockConsoleServer>;

beforeAll(async () => {
  server = createMockConsoleServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const auth = () => fetch(`${base}/openstack/identity/v2.0/tokens`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ auth: { tenantName: 'lab', passwordCredentials: { username: 'admin', password: 'mock-password' } } }),
});

describe('mock openstack: keystone', () => {
  it('issues a token + serviceCatalog for valid credentials', async () => {
    const res = await auth();
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.access.token.id).toMatch(/^mock-token-/);
    expect(body.access.token.tenant.id).toBe('mocktenant0001');
    const types = body.access.serviceCatalog.map((s: any) => s.type);
    expect(types).toEqual(expect.arrayContaining(['identity', 'volume', 'compute', 'image']));
  });
  it('rejects bad credentials with 401', async () => {
    const res = await fetch(`${base}/openstack/identity/v2.0/tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: { tenantName: 'lab', passwordCredentials: { username: 'admin', password: 'wrong' } } }),
    });
    expect(res.status).toBe(401);
  });
});

describe('mock openstack: volumes', () => {
  let token = '';
  let volBase = '';
  beforeAll(async () => {
    const body = await (await auth()).json() as any;
    token = body.access.token.id;
    volBase = body.access.serviceCatalog.find((s: any) => s.type === 'volume').endpoints[0].publicURL
      .replace(/^http:\/\/127\.0\.0\.1:\d+/, base); // catalog carries the default port; rebase to the ephemeral one
  });
  const H = () => ({ 'content-type': 'application/json', 'x-auth-token': token });

  it('requires a valid token (401 otherwise)', async () => {
    const res = await fetch(`${volBase}/volumes`, { headers: { 'x-auth-token': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('creates a volume with 202 → creating → available on subsequent GETs', async () => {
    const create = await fetch(`${volBase}/volumes`, {
      method: 'POST', headers: { ...H(), 'x-client-token': 'ct-1' },
      body: JSON.stringify({ volume: { name: 'vol-a', size: 10, description: 'd' } }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json() as any).volume;
    expect(created.status).toBe('creating');
    const g1 = (await (await fetch(`${volBase}/volumes/${created.id}`, { headers: H() })).json() as any).volume;
    const g2 = (await (await fetch(`${volBase}/volumes/${created.id}`, { headers: H() })).json() as any).volume;
    expect([g1.status, g2.status]).toContain('available');
  });

  it('is idempotent on X-Client-Token (no duplicate volume)', async () => {
    const mk = () => fetch(`${volBase}/volumes`, {
      method: 'POST', headers: { ...H(), 'x-client-token': 'ct-same' },
      body: JSON.stringify({ volume: { name: 'vol-idem', size: 5 } }),
    });
    const a = (await (await mk()).json() as any).volume;
    const b = (await (await mk()).json() as any).volume;
    expect(b.id).toBe(a.id);
    const list = (await (await fetch(`${volBase}/volumes/detail`, { headers: H() })).json() as any).volumes;
    expect(list.filter((v: any) => v.name === 'vol-idem')).toHaveLength(1);
  });

  it('reproduces the documented 202-silent-noop trap under X-Mock-Scenario', async () => {
    const before = (await (await fetch(`${volBase}/volumes/detail`, { headers: H() })).json() as any).volumes.length;
    const res = await fetch(`${volBase}/volumes`, {
      method: 'POST', headers: { ...H(), 'x-client-token': 'ct-noop', 'x-mock-scenario': 'quota-silent-noop' },
      body: JSON.stringify({ volume: { name: 'ghost', size: 999 } }),
    });
    expect(res.status).toBe(202); // lies, like the real device can
    const after = (await (await fetch(`${volBase}/volumes/detail`, { headers: H() })).json() as any).volumes.length;
    expect(after).toBe(before); // nothing was actually created
  });

  it('deletes with 202 and the volume eventually 404s', async () => {
    const created = (await (await fetch(`${volBase}/volumes`, {
      method: 'POST', headers: { ...H(), 'x-client-token': 'ct-del' },
      body: JSON.stringify({ volume: { name: 'vol-del', size: 1 } }),
    })).json() as any).volume;
    const del = await fetch(`${volBase}/volumes/${created.id}`, { method: 'DELETE', headers: H() });
    expect(del.status).toBe(202);
    await fetch(`${volBase}/volumes/${created.id}`, { headers: H() }); // deleting
    await fetch(`${volBase}/volumes/${created.id}`, { headers: H() }); // gone after grace reads
    const last = await fetch(`${volBase}/volumes/${created.id}`, { headers: H() });
    expect(last.status).toBe(404);
  });

  it('expire-tokens helper invalidates issued tokens (drives the client 401-refresh path)', async () => {
    await fetch(`${base}/openstack/__mock/expire-tokens`, { method: 'POST' });
    const res = await fetch(`${volBase}/volumes`, { headers: H() });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: 실패 확인** — `createMockConsoleServer` 미존재로 FAIL.
- [ ] **Step 3: 구현** — `apps/mock-sangfor-console/src/openstack.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';

// In-memory OpenStack fixture faithful to the official HCI OpenAPI guide
// (keystone v2.0 passwordCredentials, cinder volumes, X-Client-Token idempotency,
// and the documented "202 but nothing changed" quota trap).

const MOCK_USER = 'admin';
const MOCK_PASSWORD = 'mock-password';
const MOCK_TENANT = 'lab';
const MOCK_TENANT_ID = 'mocktenant0001';

interface MockVolume {
  id: string; name: string; status: string; size: number;
  description: string | null; reads: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function createOpenStackMock(port = 3400) {
  const tokens = new Map<string, { expiresAt: number }>();
  const volumes = new Map<string, MockVolume>();
  const clientTokenLedger = new Map<string, { status: number; body: unknown }>();
  let tokenSeq = 0; let volSeq = 0;
  let volumeCreates = 0;

  const volumeView = (v: MockVolume) => ({
    id: v.id, name: v.name, status: v.status, size: v.size, description: v.description,
    attachments: [], bootable: 'false', encrypted: false, multiattach: false,
    availability_zone: 'mock-az', volume_type: null, snapshot_id: null, source_volid: null,
  });

  function authed(req: IncomingMessage): boolean {
    const t = String(req.headers['x-auth-token'] ?? '');
    const rec = tokens.get(t);
    return Boolean(rec && rec.expiresAt > Date.now());
  }

  function stepVolume(v: MockVolume): MockVolume {
    v.reads += 1;
    if (v.status === 'creating' && v.reads >= 2) v.status = 'available';
    if (v.status === 'deleting' && v.reads >= 2) volumes.delete(v.id);
    return v;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = (req.url ?? '/').split('?')[0];
    if (!url.startsWith('/openstack/')) return false;

    if (req.method === 'POST' && url === '/openstack/__mock/expire-tokens') {
      tokens.clear(); json(res, 200, { ok: true }); return true;
    }

    if (req.method === 'POST' && url === '/openstack/identity/v2.0/tokens') {
      const body = await readBody(req);
      const cred = body?.auth?.passwordCredentials;
      if (body?.auth?.tenantName !== MOCK_TENANT || cred?.username !== MOCK_USER || cred?.password !== MOCK_PASSWORD) {
        json(res, 401, { error: { code: 401, title: 'Unauthorized', message: 'invalid credentials' } });
        return true;
      }
      const id = `mock-token-${String(++tokenSeq).padStart(4, '0')}`;
      tokens.set(id, { expiresAt: Date.now() + 60 * 60_000 });
      const base = `http://127.0.0.1:${port}`;
      json(res, 200, {
        access: {
          token: {
            issued_at: new Date().toISOString(), expires: new Date(Date.now() + 3_600_000).toISOString(),
            id, tenant: { enabled: true, description: '', name: MOCK_TENANT, id: MOCK_TENANT_ID },
          },
          serviceCatalog: [
            { endpoints: [{ publicURL: `${base}/openstack/identity/v2.0` }], type: 'identity', name: 'keystone' },
            { endpoints: [{ publicURL: `${base}/openstack/volume/v2/${MOCK_TENANT_ID}` }], type: 'volume', name: 'cinder' },
            { endpoints: [{ publicURL: `${base}/openstack/compute/v2` }], type: 'compute', name: 'nova' },
            { endpoints: [{ publicURL: `${base}/openstack/image` }], type: 'image', name: 'glance' },
          ],
          user: { username: MOCK_USER, roles: [{ name: 'tenant' }], name: MOCK_USER },
        },
      });
      return true;
    }

    if (!authed(req)) { json(res, 401, { error: { code: 401, title: 'Unauthorized', message: 'token missing/expired' } }); return true; }

    const volRoot = `/openstack/volume/v2/${MOCK_TENANT_ID}/volumes`;

    if (req.method === 'GET' && (url === volRoot || url === `${volRoot}/detail`)) {
      json(res, 200, { volumes: [...volumes.values()].map(volumeView) });
      return true;
    }

    if (req.method === 'GET' && url.startsWith(`${volRoot}/`)) {
      const id = url.slice(volRoot.length + 1);
      const v = volumes.get(id);
      if (!v) { json(res, 404, { itemNotFound: { code: 404, message: `Volume ${id} could not be found.` } }); return true; }
      json(res, 200, { volume: volumeView(stepVolume(v)) });
      return true;
    }

    if (req.method === 'POST' && url === volRoot) {
      const clientToken = String(req.headers['x-client-token'] ?? '');
      if (clientToken && clientTokenLedger.has(clientToken)) {
        const prior = clientTokenLedger.get(clientToken)!;
        json(res, prior.status, prior.body);
        return true;
      }
      const body = await readBody(req);
      const input = body?.volume ?? {};
      if (req.headers['x-mock-scenario'] === 'quota-silent-noop') {
        // Faithful to the documented trap: 202 returned, nothing actually created.
        json(res, 202, { volume: { ...input, id: 'ghost-never-created', status: 'creating' } });
        return true;
      }
      volumeCreates += 1;
      const v: MockVolume = {
        id: `vol-${String(++volSeq).padStart(4, '0')}`,
        name: String(input.name ?? ''), size: Number(input.size ?? 0),
        description: input.description != null ? String(input.description) : null,
        status: 'creating', reads: 0,
      };
      volumes.set(v.id, v);
      const responseBody = { volume: volumeView(v) };
      if (clientToken) clientTokenLedger.set(clientToken, { status: 202, body: responseBody });
      json(res, 202, responseBody);
      return true;
    }

    if (req.method === 'DELETE' && url.startsWith(`${volRoot}/`)) {
      const id = url.slice(volRoot.length + 1);
      const v = volumes.get(id);
      if (!v) { json(res, 404, { itemNotFound: { code: 404, message: `Volume ${id} could not be found.` } }); return true; }
      v.status = 'deleting'; v.reads = 0;
      res.writeHead(202); res.end();
      return true;
    }

    json(res, 404, { error: { code: 404, message: `no mock route: ${req.method} ${url}` } });
    return true;
  }

  return { handle, stats: () => ({ tokensIssued: tokenSeq, volumeCreates }) };
}
```

`server.ts` 교체(기존 HTML mock 유지 + 팩토리 export + `MOCK_NO_SERVE` 가드):

```ts
import http from 'node:http';
import { createOpenStackMock } from './openstack.js';

const port = Number(process.env.PORT ?? 3400);

function page(product: string) { /* 기존 함수 그대로 유지 */ }

export function createMockConsoleServer(): http.Server {
  const openstack = createOpenStackMock(port);
  return http.createServer(async (req, res) => {
    if (await openstack.handle(req, res)) return;
    const url = req.url ?? '/';
    if (url === '/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, elements: ['Dashboard', 'Network', 'Policy', 'Export', 'Save', 'Apply'] }));
      return;
    }
    const product = url.includes('iag') ? 'IAG' : url.includes('endpoint') ? 'Endpoint Secure' : url.includes('cyber') ? 'Cyber Command' : 'HCI';
    res.setHeader('content-type', 'text/html');
    res.end(page(product));
  });
}

if (process.env.MOCK_NO_SERVE !== '1') {
  createMockConsoleServer().listen(port, () => console.log(`Mock Sangfor Console listening on http://localhost:${port}`));
}
```

주의: 테스트는 ephemeral 포트(`listen(0)`)를 쓰므로 serviceCatalog의 publicURL 포트가 다르다 — 테스트가 rebase하는 이유. 클라이언트(Task 7)는 catalog URL을 그대로 신뢰한다(실장비 동작과 동일). 테스트에서는 클라이언트 생성 시 `identityBaseUrl`에 ephemeral 포트를 주고, mock을 고정 포트로 띄우는 e2e(Task 13)에서는 rebase가 필요 없다.

- [ ] **Step 4:** `MOCK_NO_SERVE=1 pnpm exec vitest run tests/mock-openstack.test.ts` PASS. (vitest 실행 환경에 `MOCK_NO_SERVE` 불필요 — import 시점 가드가 팩토리 export만 쓰는 테스트에선 listen하지 않도록 위 가드가 처리. 단, import 부작용 방지를 위해 테스트 파일 첫 줄 전에 `process.env.MOCK_NO_SERVE = '1';`를 두는 setup도 허용.)
- [ ] **Step 5: 커밋** — `git commit -m "feat(mock-console): openstack fixture server with idempotency + documented 202-noop trap"`

---

### Task 7: `@sangfor/hci-client` 패키지 토대 (HTTP + Keystone TokenProvider + 클라이언트)

**Files:**
- Create: `packages/sangfor-hci-client/package.json` → `{"name":"@sangfor/hci-client","type":"module","main":"src/index.ts"}`
- Create: `packages/sangfor-hci-client/src/http.ts`
- Create: `packages/sangfor-hci-client/src/token-provider.ts`
- Create: `packages/sangfor-hci-client/src/client.ts`
- Create: `packages/sangfor-hci-client/src/index.ts` (재수출)
- Modify: `tsconfig.json` paths + `vitest.config.ts` alias에 `@sangfor/hci-client` 추가 → `pnpm install`
- Test: `tests/hci-client.test.ts`

**Interfaces:**
- Consumes: Task 6의 mock 서버(`createMockConsoleServer`), Task 5 catalog 계약
- Produces (이후 태스크 전부가 사용):
  - `httpJson(url: string, opts?: { method?: string; headers?: Record<string,string>; body?: unknown; tlsSkipVerify?: boolean; timeoutMs?: number }): Promise<{ status: number; json: unknown; text: string }>`
  - `interface HciConnectionConfig { identityBaseUrl: string; tenantName: string; username: string; password: string; tlsSkipVerify?: boolean }`
  - `interface TokenState { tokenId: string; tenantId: string; expiresAt: string; serviceCatalog: ServiceCatalogEntry[] }`
  - `interface TokenProvider { getToken(force?: boolean): Promise<TokenState> }`
  - `class KeystoneV2TokenProvider implements TokenProvider`
  - `const HCI_AUTH_CONTRACT_STATUS = 'doc_contract_unverified_on_real_device'`
  - `class HciClient { constructor(tokenProvider: TokenProvider, opts?: { tlsSkipVerify?: boolean }); request(serviceType: 'identity'|'volume'|'compute'|'image', path: string, init?: { method?: string; body?: unknown; headers?: Record<string,string> }): Promise<{ status: number; json: unknown; text: string }> }`

- [ ] **Step 1: 실패 테스트** — `tests/hci-client.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import { HciClient, KeystoneV2TokenProvider, HCI_AUTH_CONTRACT_STATUS } from '@sangfor/hci-client';

let server: ReturnType<typeof createMockConsoleServer>;
let base = '';

beforeAll(async () => {
  server = createMockConsoleServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const provider = () => new KeystoneV2TokenProvider({
  identityBaseUrl: `${base}/openstack/identity/v2.0`,
  tenantName: 'lab', username: 'admin', password: 'mock-password',
});

describe('KeystoneV2TokenProvider (doc contract)', () => {
  it('exposes the honesty label', () => {
    expect(HCI_AUTH_CONTRACT_STATUS).toBe('doc_contract_unverified_on_real_device');
  });
  it('authenticates and caches the token', async () => {
    const p = provider();
    const a = await p.getToken();
    const b = await p.getToken();
    expect(a.tokenId).toMatch(/^mock-token-/);
    expect(a.tenantId).toBe('mocktenant0001');
    expect(b.tokenId).toBe(a.tokenId); // cached, no re-auth
    expect(a.serviceCatalog.map((s) => s.type)).toContain('volume');
  });
  it('fails loudly on bad credentials (no guessing)', async () => {
    const bad = new KeystoneV2TokenProvider({
      identityBaseUrl: `${base}/openstack/identity/v2.0`,
      tenantName: 'lab', username: 'admin', password: 'wrong',
    });
    await expect(bad.getToken()).rejects.toThrow(/Keystone auth failed/);
  });
});

describe('HciClient', () => {
  it('injects X-Auth-Token and resolves the service endpoint from the catalog', async () => {
    const client = new HciClient(provider());
    const res = await client.request('volume', '/volumes');
    expect(res.status).toBe(200);
    expect((res.json as any).volumes).toBeInstanceOf(Array);
  });
  it('re-authenticates exactly once on 401 (expired token)', async () => {
    const client = new HciClient(provider());
    await client.request('volume', '/volumes');                    // warm token
    await fetch(`${base}/openstack/__mock/expire-tokens`, { method: 'POST' });
    const res = await client.request('volume', '/volumes');        // should refresh + retry
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: 실패 확인** — alias 미등록/모듈 미존재로 FAIL. (paths/alias/`pnpm install`을 이 시점에 수행.)
- [ ] **Step 3: 구현.**

`src/http.ts` (무의존성 — undici/axios 추가 금지):

```ts
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

export interface HttpJsonResult { status: number; json: unknown; text: string; }

export function httpJson(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; tlsSkipVerify?: boolean; timeoutMs?: number } = {}): Promise<HttpJsonResult> {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...opts.headers,
        },
        // Lab consoles use self-signed certs; opt-in only, never default-on for https.
        ...(isHttps && opts.tlsSkipVerify ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 15_000, () => req.destroy(new Error(`HTTP timeout: ${opts.method ?? 'GET'} ${url}`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
```

`src/token-provider.ts`:

```ts
import { httpJson } from './http.js';

// Keystone v2.0 password auth exactly as documented in the official HCI OpenAPI
// guide (auth.tenantName + passwordCredentials → access.token + serviceCatalog).
// This is a DOC CONTRACT: it has not been verified against a real device yet.
// M4 captures the real handshake and either confirms this or forces a fix.
export const HCI_AUTH_CONTRACT_STATUS = 'doc_contract_unverified_on_real_device';

export interface HciConnectionConfig {
  identityBaseUrl: string;   // e.g. https://{acmp_ip}/openstack/identity/v2.0
  tenantName: string;
  username: string;
  password: string;
  tlsSkipVerify?: boolean;
}

export interface ServiceCatalogEntry { type: string; name: string; publicURL: string; }
export interface TokenState { tokenId: string; tenantId: string; expiresAt: string; serviceCatalog: ServiceCatalogEntry[]; }
export interface TokenProvider { getToken(force?: boolean): Promise<TokenState>; }

const REFRESH_MARGIN_MS = 60_000;

export class KeystoneV2TokenProvider implements TokenProvider {
  private cached: TokenState | null = null;
  constructor(private readonly config: HciConnectionConfig) {}

  async getToken(force = false): Promise<TokenState> {
    if (!force && this.cached) {
      const remaining = new Date(this.cached.expiresAt).getTime() - Date.now();
      if (Number.isFinite(remaining) && remaining > REFRESH_MARGIN_MS) return this.cached;
    }
    const res = await httpJson(`${this.config.identityBaseUrl.replace(/\/$/, '')}/tokens`, {
      method: 'POST',
      tlsSkipVerify: this.config.tlsSkipVerify,
      body: { auth: { tenantName: this.config.tenantName, passwordCredentials: { username: this.config.username, password: this.config.password } } },
    });
    if (res.status !== 200) throw new Error(`Keystone auth failed: HTTP ${res.status}`);
    const access = (res.json as { access?: any })?.access;
    const tokenId = access?.token?.id;
    const tenantId = access?.token?.tenant?.id;
    if (typeof tokenId !== 'string' || typeof tenantId !== 'string') {
      throw new Error('Keystone auth response missing token/tenant id (refusing to guess).');
    }
    const serviceCatalog: ServiceCatalogEntry[] = Array.isArray(access?.serviceCatalog)
      ? access.serviceCatalog.flatMap((s: any) =>
          Array.isArray(s?.endpoints) && typeof s.endpoints[0]?.publicURL === 'string'
            ? [{ type: String(s.type), name: String(s.name), publicURL: String(s.endpoints[0].publicURL) }]
            : [])
      : [];
    this.cached = { tokenId, tenantId, expiresAt: String(access?.token?.expires ?? ''), serviceCatalog };
    return this.cached;
  }
}
```

`src/client.ts`:

```ts
import { httpJson, type HttpJsonResult } from './http.js';
import type { TokenProvider } from './token-provider.js';

export type HciServiceType = 'identity' | 'volume' | 'compute' | 'image';

export class HciClient {
  constructor(
    private readonly tokenProvider: TokenProvider,
    private readonly opts: { tlsSkipVerify?: boolean } = {},
  ) {}

  async endpointFor(serviceType: HciServiceType): Promise<string> {
    const token = await this.tokenProvider.getToken();
    const entry = token.serviceCatalog.find((s) => s.type === serviceType);
    if (!entry) throw new Error(`service '${serviceType}' not present in the Keystone serviceCatalog (fail-closed).`);
    return entry.publicURL.replace(/\/$/, '');
  }

  async request(serviceType: HciServiceType, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpJsonResult> {
    const doRequest = async (force: boolean): Promise<HttpJsonResult> => {
      const token = await this.tokenProvider.getToken(force);
      const entry = token.serviceCatalog.find((s) => s.type === serviceType);
      if (!entry) throw new Error(`service '${serviceType}' not present in the Keystone serviceCatalog (fail-closed).`);
      return httpJson(`${entry.publicURL.replace(/\/$/, '')}${path}`, {
        method: init.method ?? 'GET',
        body: init.body,
        tlsSkipVerify: this.opts.tlsSkipVerify,
        headers: { 'x-auth-token': token.tokenId, ...init.headers },
      });
    };
    const first = await doRequest(false);
    if (first.status !== 401) return first;
    return doRequest(true); // exactly one forced re-auth on 401
  }
}
```

`src/index.ts`: `export * from './http.js'; export * from './token-provider.js'; export * from './client.js';` (이후 태스크에서 파일 추가 시 재수출 확장.)

- [ ] **Step 4:** `pnpm exec vitest run tests/hci-client.test.ts` PASS → 전체 스위트 + lint.
- [ ] **Step 5: 커밋** — `git commit -m "feat(hci-client): keystone v2 doc-contract token provider + catalog-driven client"`

---

### Task 8: read-only 서비스 표면 (volumes/servers/images)

**Files:**
- Create: `packages/sangfor-hci-client/src/volumes.ts`
- Create: `packages/sangfor-hci-client/src/inventory.ts`
- Modify: `packages/sangfor-hci-client/src/index.ts` (재수출)
- Test: `tests/hci-volumes.test.ts`

**Interfaces:**
- Produces:
  - `interface HciVolume { id: string; name: string; status: string; size: number; description: string | null }`
  - `listVolumes(client: HciClient): Promise<HciVolume[]>` (GET /volumes/detail)
  - `getVolume(client: HciClient, volumeId: string): Promise<HciVolume | null>` (404 → null)
  - `interface CreateVolumeInput { name: string; sizeGb: number; description?: string }`
  - `createVolume(client: HciClient, input: CreateVolumeInput, clientToken: string): Promise<{ status: number; volume: HciVolume | null }>` (POST, X-Client-Token)
  - `deleteVolume(client: HciClient, volumeId: string): Promise<{ status: number }>`
  - `collectInventory(client: HciClient): Promise<{ volumes: HciVolume[]; servers: unknown[]; images: unknown[]; readOnly: true }>`

- [ ] **Step 1: 실패 테스트** — `tests/hci-volumes.test.ts` (Task 7 테스트와 동일한 서버 부트 패턴):

```ts
// boot/provider 헬퍼는 tests/hci-client.test.ts와 동일 패턴 (중복 허용 — 테스트 독립성 우선)
import { listVolumes, getVolume, createVolume, deleteVolume, collectInventory } from '@sangfor/hci-client';

describe('hci volumes (read-only + single reversible write primitive)', () => {
  it('lists volumes with parsed fields', async () => {
    const client = mkClient();
    await createVolume(client, { name: 'lv-1', sizeGb: 3 }, 'ct-list-1');
    const vols = await listVolumes(client);
    const found = vols.find((v) => v.name === 'lv-1');
    expect(found).toBeDefined();
    expect(found!.size).toBe(3);
  });
  it('getVolume returns null on 404 (never fabricates)', async () => {
    expect(await getVolume(mkClient(), 'does-not-exist')).toBeNull();
  });
  it('createVolume carries X-Client-Token and returns the parsed creating volume', async () => {
    const { status, volume } = await createVolume(mkClient(), { name: 'cv-1', sizeGb: 2, description: 'd' }, 'ct-cv-1');
    expect(status).toBe(202);
    expect(volume?.status).toBe('creating');
  });
  it('deleteVolume returns the raw status (202 on success, 404 on missing)', async () => {
    const client = mkClient();
    const { volume } = await createVolume(client, { name: 'dv-1', sizeGb: 1 }, 'ct-dv-1');
    expect((await deleteVolume(client, volume!.id)).status).toBe(202);
    expect((await deleteVolume(client, 'missing')).status).toBe(404);
  });
  it('collectInventory is explicitly read-only', async () => {
    const inv = await collectInventory(mkClient());
    expect(inv.readOnly).toBe(true);
    expect(inv.volumes).toBeInstanceOf(Array);
  });
});
```

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — `src/volumes.ts`:

```ts
import type { HciClient } from './client.js';

export interface HciVolume { id: string; name: string; status: string; size: number; description: string | null; }
export interface CreateVolumeInput { name: string; sizeGb: number; description?: string; }

function parseVolume(raw: any): HciVolume {
  if (typeof raw?.id !== 'string' || typeof raw?.status !== 'string') {
    throw new Error('volume payload missing id/status (refusing to guess).');
  }
  return { id: raw.id, name: String(raw.name ?? ''), status: raw.status, size: Number(raw.size ?? 0), description: raw.description != null ? String(raw.description) : null };
}

export async function listVolumes(client: HciClient): Promise<HciVolume[]> {
  const res = await client.request('volume', '/volumes/detail');
  if (res.status !== 200) throw new Error(`listVolumes failed: HTTP ${res.status}`);
  const raw = (res.json as { volumes?: unknown[] })?.volumes;
  if (!Array.isArray(raw)) throw new Error('listVolumes: response missing volumes[]');
  return raw.map(parseVolume);
}

export async function getVolume(client: HciClient, volumeId: string): Promise<HciVolume | null> {
  const res = await client.request('volume', `/volumes/${encodeURIComponent(volumeId)}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`getVolume failed: HTTP ${res.status}`);
  return parseVolume((res.json as { volume?: unknown })?.volume);
}

export async function createVolume(client: HciClient, input: CreateVolumeInput, clientToken: string): Promise<{ status: number; volume: HciVolume | null }> {
  const res = await client.request('volume', '/volumes', {
    method: 'POST',
    headers: { 'x-client-token': clientToken },
    body: { volume: { name: input.name, size: input.sizeGb, ...(input.description !== undefined ? { description: input.description } : {}) } },
  });
  const raw = (res.json as { volume?: unknown })?.volume;
  return { status: res.status, volume: raw ? parseVolume(raw) : null };
}

export async function deleteVolume(client: HciClient, volumeId: string): Promise<{ status: number }> {
  const res = await client.request('volume', `/volumes/${encodeURIComponent(volumeId)}`, { method: 'DELETE' });
  return { status: res.status };
}
```

`src/inventory.ts`:

```ts
import type { HciClient } from './client.js';
import { listVolumes, type HciVolume } from './volumes.js';

export async function collectInventory(client: HciClient): Promise<{ volumes: HciVolume[]; servers: unknown[]; images: unknown[]; readOnly: true }> {
  const volumes = await listVolumes(client);
  const servers = await client.request('compute', '/servers').then((r) => (r.status === 200 && Array.isArray((r.json as any)?.servers) ? (r.json as any).servers : []), () => []);
  const images = await client.request('image', '/v2/images').then((r) => (r.status === 200 && Array.isArray((r.json as any)?.images) ? (r.json as any).images : []), () => []);
  return { volumes, servers, images, readOnly: true };
}
```

주의: mock에 `/servers`, `/v2/images` 라우트가 없으면 404 → 빈 배열로 degrade(volumes만 필수). 필요 시 mock에 두 GET 라우트를 빈 배열 응답으로 추가해도 된다(선택).

- [ ] **Step 4:** 테스트 PASS + 전체 스위트.
- [ ] **Step 5: 커밋** — `git commit -m "feat(hci-client): read-only volume/inventory surface + create/delete primitives"`

---

### Task 9: read-back oracle primitive

**Files:**
- Create: `packages/sangfor-hci-client/src/read-back.ts`
- Modify: `packages/sangfor-hci-client/src/index.ts` (재수출)
- Test: `tests/hci-read-back.test.ts`

**Interfaces:**
- Consumes: `getVolume`, `listVolumes`(Task 8)
- Produces:
  - `type ReadBackVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE'`
  - `interface ReadBackCheck { key: string; expected: unknown; observed: unknown; verdict: ReadBackVerdict }`
  - `interface ReadBackResult { verdict: ReadBackVerdict; checks: ReadBackCheck[]; reason?: string; volumeId?: string }`
  - `readBackVolume(client: HciClient, expectation: { volumeId?: string; name: string; sizeGb: number }, opts?: { maxPolls?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<ReadBackResult>`

**판정 규칙(코드로 강제 — Global Constraint 1·4):**
- id로 GET → 404: **FAIL** (`volume not found — possible silent no-op`)
- id 없이 이름 검색 → 0건: **FAIL**(silent no-op 탐지) / 2건 이상: **INDETERMINATE**(귀속 불가 — 절대 PASS 아님)
- `creating`이면 최대 `maxPolls`(기본 10)회 폴링 → 여전히 creating: **INDETERMINATE**
- `error*` 상태: **FAIL**
- `available` 도달 시 name·size 정확 일치 → 전부 일치해야 **PASS**, 하나라도 다르면 **FAIL**
- 네트워크/HTTP 오류: **INDETERMINATE** (성공으로 새지 않음)

- [ ] **Step 1: 실패 테스트** — `tests/hci-read-back.test.ts` (mock 서버 부트 패턴 동일):

```ts
import { createVolume, readBackVolume } from '@sangfor/hci-client';
const fast = { pollIntervalMs: 1, maxPolls: 5 };

describe('readBackVolume — the only success oracle', () => {
  it('PASSes when the created volume reaches available with matching name/size', async () => {
    const client = mkClient();
    const { volume } = await createVolume(client, { name: 'rb-ok', sizeGb: 7 }, 'ct-rb-ok');
    const rb = await readBackVolume(client, { volumeId: volume!.id, name: 'rb-ok', sizeGb: 7 }, fast);
    expect(rb.verdict).toBe('PASS');
  });
  it('FAILs on the documented 202-silent-noop trap (202 alone is never success)', async () => {
    const client = mkClient();
    // ghost id from the noop scenario never exists on the server
    const rb = await readBackVolume(client, { volumeId: 'ghost-never-created', name: 'ghost', sizeGb: 999 }, fast);
    expect(rb.verdict).toBe('FAIL');
    expect(rb.reason).toMatch(/not found/);
  });
  it('FAILs on a size mismatch', async () => {
    const client = mkClient();
    const { volume } = await createVolume(client, { name: 'rb-size', sizeGb: 2 }, 'ct-rb-size');
    const rb = await readBackVolume(client, { volumeId: volume!.id, name: 'rb-size', sizeGb: 3 }, fast);
    expect(rb.verdict).toBe('FAIL');
  });
  it('is INDETERMINATE when the name matches more than one volume (never PASS)', async () => {
    const client = mkClient();
    await createVolume(client, { name: 'dup', sizeGb: 1 }, 'ct-dup-1');
    await createVolume(client, { name: 'dup', sizeGb: 1 }, 'ct-dup-2');
    const rb = await readBackVolume(client, { name: 'dup', sizeGb: 1 }, fast);
    expect(rb.verdict).toBe('INDETERMINATE');
  });
});
```

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — `src/read-back.ts`:

```ts
import type { HciClient } from './client.js';
import { getVolume, listVolumes, type HciVolume } from './volumes.js';

export type ReadBackVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
export interface ReadBackCheck { key: string; expected: unknown; observed: unknown; verdict: ReadBackVerdict; }
export interface ReadBackResult { verdict: ReadBackVerdict; checks: ReadBackCheck[]; reason?: string; volumeId?: string; }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function readBackVolume(
  client: HciClient,
  expectation: { volumeId?: string; name: string; sizeGb: number },
  opts: { maxPolls?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ReadBackResult> {
  const maxPolls = opts.maxPolls ?? 10;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;

  let observed: HciVolume | null = null;
  try {
    if (expectation.volumeId) {
      observed = await getVolume(client, expectation.volumeId);
      if (!observed) return { verdict: 'FAIL', checks: [], reason: `volume ${expectation.volumeId} not found — possible silent no-op (202 is not proof of effect)` };
    } else {
      const matches = (await listVolumes(client)).filter((v) => v.name === expectation.name);
      if (matches.length === 0) return { verdict: 'FAIL', checks: [], reason: `no volume named '${expectation.name}' — possible silent no-op` };
      if (matches.length > 1) return { verdict: 'INDETERMINATE', checks: [], reason: `ambiguous: ${matches.length} volumes named '${expectation.name}' (cannot attribute; never PASS)` };
      observed = matches[0];
    }

    for (let poll = 0; observed.status === 'creating' && poll < maxPolls; poll += 1) {
      await sleep(pollIntervalMs);
      observed = await getVolume(client, observed.id);
      if (!observed) return { verdict: 'FAIL', checks: [], reason: 'volume disappeared while creating' };
    }
  } catch (error) {
    return { verdict: 'INDETERMINATE', checks: [], reason: `read-back error (never counts as pass): ${error instanceof Error ? error.message : String(error)}` };
  }

  if (observed.status === 'creating') {
    return { verdict: 'INDETERMINATE', checks: [], reason: `still 'creating' after ${maxPolls} polls`, volumeId: observed.id };
  }
  if (observed.status.startsWith('error')) {
    return { verdict: 'FAIL', checks: [], reason: `volume status '${observed.status}'`, volumeId: observed.id };
  }

  const checks: ReadBackCheck[] = [
    { key: 'status', expected: 'available', observed: observed.status, verdict: observed.status === 'available' ? 'PASS' : 'FAIL' },
    { key: 'name', expected: expectation.name, observed: observed.name, verdict: observed.name === expectation.name ? 'PASS' : 'FAIL' },
    { key: 'sizeGb', expected: expectation.sizeGb, observed: observed.size, verdict: observed.size === expectation.sizeGb ? 'PASS' : 'FAIL' },
  ];
  const verdict: ReadBackVerdict = checks.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL';
  return { verdict, checks, volumeId: observed.id, ...(verdict === 'FAIL' ? { reason: 'read-back values differ from the intent' } : {}) };
}
```

- [ ] **Step 4:** 테스트 PASS + 전체 스위트.
- [ ] **Step 5: 커밋** — `git commit -m "feat(hci-client): read-back oracle — GET verification is the only success signal"`

---

### Task 10: 마스킹 감사 원장 (파일 JSONL + HMAC 체인)

**Files:**
- Create: `packages/sangfor-hci-client/src/audit-ledger.ts`
- Modify: `packages/sangfor-hci-client/src/index.ts` (재수출)
- Modify: `.env.example` (`SANGFOR_CHANGE_LEDGER_SECRET` 추가)
- Test: `tests/hci-audit-ledger.test.ts`

**Interfaces:**
- Consumes: `resolveRepoData`(@sangfor/shared)
- Produces:
  - `maskSecrets<T>(value: T): T` — 키 이름이 `/password|secret|token|authorization|cookie/i`에 걸리는 문자열 값을 `'***'`로 재귀 치환(구조 보존)
  - `class AuditLedger { constructor(opts?: { dir?: string; secret?: string }); append(runId: string, kind: 'request'|'response'|'state'|'verdict', payload: unknown): void; verify(runId: string): { ok: boolean; keyed: boolean; brokenAt?: number }; pathFor(runId: string): string }`
  - 파일: `data/evidence/change-runs/<runId>.jsonl`, 줄 스키마 `{ seq, at, runId, kind, payload(마스킹됨), prevHash, hash, keyed }`
  - 체인: `hash = HMAC-SHA256(secret, prevHash + '\n' + seq + '\n' + kind + '\n' + JSON.stringify(payload))`, secret 없으면 SHA-256(무키) + `keyed:false` — pm 패키지와 동일한 정직성 원칙(무키는 숨기지 않고 표기)

- [ ] **Step 1: 실패 테스트** — `tests/hci-audit-ledger.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLedger, maskSecrets } from '@sangfor/hci-client';

describe('maskSecrets', () => {
  it('masks secret-bearing keys recursively while preserving structure', () => {
    const masked = maskSecrets({
      auth: { passwordCredentials: { username: 'admin', password: 'Itac123!' } },
      headers: { 'x-auth-token': 'abc', accept: 'json' },
      nested: [{ apiSecret: 's' }],
    }) as any;
    expect(masked.auth.passwordCredentials.password).toBe('***');
    expect(masked.headers['x-auth-token']).toBe('***');
    expect(masked.nested[0].apiSecret).toBe('***');
    expect(masked.auth.passwordCredentials.username).toBe('admin');
  });
});

describe('AuditLedger', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('appends masked entries and verifies the keyed chain', () => {
    const ledger = new AuditLedger({ dir, secret: 'ledger-secret' });
    ledger.append('run1', 'request', { op: 'create-volume', password: 'leak-me' });
    ledger.append('run1', 'response', { status: 202 });
    const raw = readFileSync(ledger.pathFor('run1'), 'utf8');
    expect(raw).not.toContain('leak-me');
    const v = ledger.verify('run1');
    expect(v).toEqual({ ok: true, keyed: true });
  });

  it('detects tampering', () => {
    const ledger = new AuditLedger({ dir, secret: 's' });
    ledger.append('run2', 'request', { a: 1 });
    ledger.append('run2', 'response', { b: 2 });
    const path = ledger.pathFor('run2');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const doctored = JSON.parse(lines[0]); doctored.payload = { a: 999 };
    writeFileSync(path, [JSON.stringify(doctored), lines[1]].join('\n') + '\n');
    const v = ledger.verify('run2');
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(0);
  });

  it('is honest about an unkeyed chain', () => {
    const ledger = new AuditLedger({ dir });
    ledger.append('run3', 'state', { s: 'PENDING' });
    expect(ledger.verify('run3').keyed).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — `src/audit-ledger.ts`:

```ts
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData } from '@sangfor/shared';

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

export type LedgerKind = 'request' | 'response' | 'state' | 'verdict';

interface LedgerLine { seq: number; at: string; runId: string; kind: LedgerKind; payload: unknown; prevHash: string; hash: string; keyed: boolean; }

function digest(secret: string | undefined, prevHash: string, seq: number, kind: string, payload: unknown): string {
  const material = `${prevHash}\n${seq}\n${kind}\n${JSON.stringify(payload)}`;
  return secret ? createHmac('sha256', secret).update(material).digest('hex') : createHash('sha256').update(material).digest('hex');
}

export class AuditLedger {
  private readonly dir: string;
  private readonly secret: string | undefined;

  constructor(opts: { dir?: string; secret?: string } = {}) {
    this.dir = opts.dir ?? join(resolveRepoData('evidence'), 'change-runs');
    this.secret = opts.secret ?? process.env.SANGFOR_CHANGE_LEDGER_SECRET;
  }

  pathFor(runId: string): string { return join(this.dir, `${runId}.jsonl`); }

  private readLines(runId: string): LedgerLine[] {
    try {
      return readFileSync(this.pathFor(runId), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerLine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  append(runId: string, kind: LedgerKind, payload: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const prior = this.readLines(runId);
    const seq = prior.length;
    const prevHash = prior.length ? prior[prior.length - 1].hash : 'GENESIS';
    const masked = maskSecrets(payload);
    const line: LedgerLine = {
      seq, at: new Date().toISOString(), runId, kind, payload: masked,
      prevHash, hash: digest(this.secret, prevHash, seq, kind, masked), keyed: Boolean(this.secret),
    };
    appendFileSync(this.pathFor(runId), `${JSON.stringify(line)}\n`);
  }

  verify(runId: string): { ok: boolean; keyed: boolean; brokenAt?: number } {
    const lines = this.readLines(runId);
    const keyed = lines.every((l) => l.keyed) && Boolean(this.secret);
    let prevHash = 'GENESIS';
    for (const [i, line] of lines.entries()) {
      const expected = digest(this.secret, prevHash, line.seq, line.kind, line.payload);
      if (line.seq !== i || line.prevHash !== prevHash || line.hash !== expected) {
        return { ok: false, keyed, brokenAt: i };
      }
      prevHash = line.hash;
    }
    return { ok: true, keyed };
  }
}
```

`.env.example` 안전 게이트 섹션: `# SANGFOR_CHANGE_LEDGER_SECRET=  # HCI 변경 원장 HMAC 키. 미설정 시 무키 체인(keyed:false)으로 정직 표기.`

- [ ] **Step 4:** 테스트 PASS + 전체 스위트.
- [ ] **Step 5: 커밋** — `git commit -m "feat(hci-client): masked JSONL audit ledger with keyed hash chain"`

---

### Task 11: apply 상태기계 — create-volume 단일 가역 write

**Files:**
- Create: `packages/sangfor-hci-client/src/apply-machine.ts`
- Modify: `packages/sangfor-hci-client/src/index.ts` (재수출)
- Test: `tests/hci-apply-machine.test.ts`

**Interfaces:**
- Consumes: `createVolume`(Task 8), `readBackVolume`(Task 9), `AuditLedger`(Task 10), `nowId`(@sangfor/shared)
- Produces:
  - `type ApplyState = 'PENDING'|'VALIDATING'|'APPLYING'|'VERIFYING'|'SUCCEEDED'|'FAILED_HALT'`
  - `interface ApplyEvent { at: string; state: ApplyState; detail: string }`
  - `interface ApplyCreateVolumeInput { name: string; sizeGb: number; description?: string; clientToken: string }`
  - `interface ApplyResult { ok: boolean; finalState: ApplyState; runId: string; volumeId?: string; readBack?: ReadBackResult; events: ApplyEvent[] }`
  - `validateCreateVolumeInput(input: ApplyCreateVolumeInput): string[]`
  - `applyCreateVolume(client: HciClient, input: ApplyCreateVolumeInput, ledger: AuditLedger, opts?: { maxPolls?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<ApplyResult>`

**불변식:** ① 202/200은 성공이 아니다 — SUCCEEDED는 read-back PASS로만 ② FAILED_HALT에서 자동 롤백 금지(사람 호출) ③ 전 단계가 원장에 기록 ④ 검증 실패 입력은 APPLYING에 진입 불가.

- [ ] **Step 1: 실패 테스트** — `tests/hci-apply-machine.test.ts` (mock 부트 패턴 동일, `fast = { pollIntervalMs: 1, maxPolls: 5 }`):

```ts
import { AuditLedger, applyCreateVolume, listVolumes } from '@sangfor/hci-client';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'apply-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const ledger = () => new AuditLedger({ dir, secret: 'apply-secret' });

describe('applyCreateVolume state machine', () => {
  it('completes PENDING→…→SUCCEEDED with a PASS read-back, fully ledgered', async () => {
    const client = mkClient();
    const lg = ledger();
    const r = await applyCreateVolume(client, { name: 'am-ok', sizeGb: 4, clientToken: 'ct-am-ok' }, lg, fast);
    expect(r.ok).toBe(true);
    expect(r.finalState).toBe('SUCCEEDED');
    expect(r.readBack?.verdict).toBe('PASS');
    expect(r.events.map((e) => e.state)).toEqual(['PENDING', 'VALIDATING', 'APPLYING', 'VERIFYING', 'SUCCEEDED']);
    expect(lg.verify(r.runId)).toEqual({ ok: true, keyed: true });
  });

  it('halts (no rollback) when the server lies with a silent-noop 202', async () => {
    // mkClientWithScenario는 client.request 호출에 x-mock-scenario 헤더를 주입하는 테스트 헬퍼:
    // HciClient 생성 후 createVolume 직전 헤더만 추가하면 되므로, applyCreateVolume에
    // opts.extraCreateHeaders?: Record<string,string> 를 지원하도록 구현한다(테스트 전용 아님 — 문서화된 확장점).
    const client = mkClient();
    const r = await applyCreateVolume(client, { name: 'am-ghost', sizeGb: 9, clientToken: 'ct-am-ghost' }, ledger(), { ...fast, extraCreateHeaders: { 'x-mock-scenario': 'quota-silent-noop' } });
    expect(r.ok).toBe(false);
    expect(r.finalState).toBe('FAILED_HALT');
    expect(r.readBack?.verdict).toBe('FAIL');
  });

  it('is idempotent: same clientToken twice → exactly one volume', async () => {
    const client = mkClient();
    await applyCreateVolume(client, { name: 'am-idem', sizeGb: 2, clientToken: 'ct-am-idem' }, ledger(), fast);
    await applyCreateVolume(client, { name: 'am-idem', sizeGb: 2, clientToken: 'ct-am-idem' }, ledger(), fast);
    const dups = (await listVolumes(client)).filter((v) => v.name === 'am-idem');
    expect(dups).toHaveLength(1);
  });

  it('refuses invalid input before any HTTP call', async () => {
    const r = await applyCreateVolume(mkClient(), { name: '', sizeGb: 0, clientToken: 'x' }, ledger(), fast);
    expect(r.finalState).toBe('FAILED_HALT');
    expect(r.events.some((e) => e.state === 'APPLYING')).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — `src/apply-machine.ts`:

```ts
import { nowId } from '@sangfor/shared';
import type { HciClient } from './client.js';
import { createVolume, type CreateVolumeInput } from './volumes.js';
import { readBackVolume, type ReadBackResult } from './read-back.js';
import type { AuditLedger } from './audit-ledger.js';

export type ApplyState = 'PENDING' | 'VALIDATING' | 'APPLYING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED_HALT';
export interface ApplyEvent { at: string; state: ApplyState; detail: string; }
export interface ApplyCreateVolumeInput extends CreateVolumeInput { clientToken: string; }
export interface ApplyResult { ok: boolean; finalState: ApplyState; runId: string; volumeId?: string; readBack?: ReadBackResult; events: ApplyEvent[]; }
export interface ApplyOptions { maxPolls?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void>; extraCreateHeaders?: Record<string, string>; }

export function validateCreateVolumeInput(input: ApplyCreateVolumeInput): string[] {
  const problems: string[] = [];
  if (!input.name || input.name.length > 64 || /[ -]/.test(input.name)) problems.push('name must be 1..64 chars without control characters');
  if (!Number.isInteger(input.sizeGb) || input.sizeGb < 1 || input.sizeGb > 65536) problems.push('sizeGb must be an integer in 1..65536');
  if (!input.clientToken || input.clientToken.length < 8) problems.push('clientToken (idempotency key) must be at least 8 chars');
  return problems;
}

export async function applyCreateVolume(client: HciClient, input: ApplyCreateVolumeInput, ledger: AuditLedger, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const runId = nowId('hci_apply');
  const events: ApplyEvent[] = [];
  const step = (state: ApplyState, detail: string) => {
    const ev: ApplyEvent = { at: new Date().toISOString(), state, detail };
    events.push(ev);
    ledger.append(runId, 'state', ev);
  };
  const halt = (detail: string, extra: Partial<ApplyResult> = {}): ApplyResult => {
    step('FAILED_HALT', `${detail} — halting for human review (no auto-rollback)`);
    return { ok: false, finalState: 'FAILED_HALT', runId, events, ...extra };
  };

  step('PENDING', `create-volume '${input.name}' (${input.sizeGb}GB)`);

  step('VALIDATING', 'input validation');
  const problems = validateCreateVolumeInput(input);
  if (problems.length) return halt(`validation failed: ${problems.join('; ')}`);

  step('APPLYING', 'POST /volumes with X-Client-Token idempotency');
  ledger.append(runId, 'request', { op: 'create-volume', name: input.name, sizeGb: input.sizeGb, description: input.description ?? null, clientToken: input.clientToken });
  let created: Awaited<ReturnType<typeof createVolume>>;
  try {
    created = await createVolumeWithHeaders(client, input, opts.extraCreateHeaders);
  } catch (error) {
    return halt(`create request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  ledger.append(runId, 'response', { status: created.status, volume: created.volume });
  if (created.status !== 202 && created.status !== 200) return halt(`unexpected HTTP ${created.status} from create`);

  // A 2xx alone is NEVER success (official doc: quota-exceeded ops still return 202
  // with no effect). The read-back oracle is the only success signal.
  step('VERIFYING', 'independent GET read-back');
  const readBack = await readBackVolume(client, { volumeId: created.volume?.id, name: input.name, sizeGb: input.sizeGb }, opts);
  ledger.append(runId, 'verdict', readBack);

  if (readBack.verdict === 'PASS') {
    step('SUCCEEDED', `volume ${readBack.volumeId} verified by read-back`);
    return { ok: true, finalState: 'SUCCEEDED', runId, volumeId: readBack.volumeId, readBack, events };
  }
  return halt(`read-back ${readBack.verdict}: ${readBack.reason ?? 'values differ from intent'}`, { volumeId: created.volume?.id, readBack });
}

async function createVolumeWithHeaders(client: HciClient, input: ApplyCreateVolumeInput, extra?: Record<string, string>) {
  if (!extra) return createVolume(client, input, input.clientToken);
  const res = await client.request('volume', '/volumes', {
    method: 'POST',
    headers: { 'x-client-token': input.clientToken, ...extra },
    body: { volume: { name: input.name, size: input.sizeGb, ...(input.description !== undefined ? { description: input.description } : {}) } },
  });
  const raw = (res.json as { volume?: unknown })?.volume;
  return { status: res.status, volume: raw ? (await import('./volumes.js')).parseVolumeSafe(raw) : null };
}
```

구현 노트: `parseVolumeSafe`는 volumes.ts의 `parseVolume`을 export 이름만 바꿔 재사용하거나(`export { parseVolume as parseVolumeSafe }`), `createVolumeWithHeaders`를 volumes.ts의 `createVolume`에 `extraHeaders?: Record<string,string>` 4번째 인자를 추가하는 방식으로 단순화해도 된다(후자 권장 — dynamic import 제거). 어느 쪽이든 테스트 계약은 동일.

- [ ] **Step 4:** 테스트 PASS + 전체 스위트.
- [ ] **Step 5: 커밋** — `git commit -m "feat(hci-client): apply state machine — 202 is never success, read-back or halt"`

---

### Task 12: MCP 도구 5종 등록 + 승인 발급 스크립트

**Files:**
- Modify: `apps/mcp-server/src/index.ts` (tools 레코드 + `WRITE_TOOLS`/`DESTRUCTIVE_TOOLS` + `categoryOf`)
- Create: `scripts/mint-hci-approval.ts`
- Modify: `tests/mcp-tool-annotations.test.ts` (개수 66→71 및 집합 갱신)
- Modify: `.env.example` (HCI 접속 env 4종)
- Test: `tests/hci-mcp-tools.test.ts`

**Interfaces:**
- Consumes: Task 7~11 전부, `verifyExecutionApproval`·`consumeApprovalNonce`(@sangfor/operator), `getCapabilitySafety`(@sangfor/safety — 반환: `{ safetyClass, maturity, autoAllowed, fieldVerifiedAutoAllowed, reason, evidence }`), `isLoopbackHost`(@sangfor/shared, Task 2)
- Produces (MCP 표면):
  - `sangfor.hci_inventory` (read-only) — 인벤토리 수집
  - `sangfor.hci_plan_create_volume` (read-only) — 검증 + 요청 미리보기 + `clientToken` 발급 + 필요한 승인 형태 반환. **mutation 없음**
  - `sangfor.hci_apply_create_volume` (**WRITE_TOOLS**) — 게이트 통과 시 `applyCreateVolume` 실행
  - `sangfor.hci_verify_volume` (read-only) — read-back 단독 실행
  - `sangfor.hci_delete_volume` (**DESTRUCTIVE_TOOLS**) — 복원(역연산) 전용, 자체 SignedApproval(대상 volumeId 바인딩) 필요. http-bridge에서는 annotations에 의해 **항상** 거부됨(원격 삭제 불가 보장)

**접속 해석 규칙(모든 hci_* 도구 공통):** args 우선, 없으면 env, 기본은 로컬 mock.
`identityBaseUrl` ← `SANGFOR_HCI_IDENTITY_URL` (기본 `http://127.0.0.1:3400/openstack/identity/v2.0`), `tenantName` ← `SANGFOR_HCI_TENANT`(기본 `lab`), `username` ← `SANGFOR_HCI_USER`(기본 `admin`), `password` ← `SANGFOR_HCI_PASSWORD`(기본 `mock-password`).

**apply/delete 게이트 순서(코드로 강제):**
1. `verifyExecutionApproval({ action: { type: 'hci.create-volume' | 'hci.delete-volume', target: `${host}:${name|volumeId}` }, approval, secret: SANGFOR_OPERATOR_APPROVAL_SECRET })` — 실패 시 즉시 거부
2. `consumeApprovalNonce(approval)` — 재사용 거부 (Task 1)
3. 대상 host가 **비-loopback**이면 추가로: `SANGFOR_ALLOW_REAL_EXECUTION==='true'` && `getCapabilitySafety('HCI_SCP','volume_create').autoAllowed===true`(delete는 `volume_delete`) — 하나라도 아니면 거부. **loopback(mock)은 이 두 조건 면제**(승인·nonce는 여전히 필수 — 전체 경로 리허설 목적)
4. 통과 시 실행 + `AuditLedger` 기록

- [ ] **Step 1: 실패 테스트** — `tests/hci-mcp-tools.test.ts`:

```ts
import { listTools } from '../apps/mcp-server/src/index.js'; // MCP_NO_SERVE=1 필요 — 파일 최상단에서 process.env.MCP_NO_SERVE='1' 설정 후 import (기존 mcp-tool-annotations.test.ts 패턴을 그대로 따른다)

describe('hci mcp tools registration', () => {
  const tools = listTools();
  const byName = new Map(tools.map((t: any) => [t.name, t]));
  it('registers 5 hci tools with correct annotations', () => {
    expect(byName.get('sangfor.hci_inventory')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('sangfor.hci_plan_create_volume')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('sangfor.hci_verify_volume')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('sangfor.hci_apply_create_volume')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('sangfor.hci_delete_volume')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('hci apply tool gates (mock target, loopback)', () => {
  // mock 서버 고정 포트 대신 ephemeral 부트 + args.identityBaseUrl 주입 패턴 사용.
  it('refuses without a signed approval', async () => { /* handler 직접 호출: tools['sangfor.hci_apply_create_volume'].handler({...approval 없음}) → { error: /approval/ } */ });
  it('refuses a replayed nonce', async () => { /* 동일 승인 2회 → 두 번째 { error: /already used/ } */ });
  it('applies + verifies end-to-end with a valid approval', async () => { /* signApprovalToken으로 승인 생성 → ok:true, finalState SUCCEEDED */ });
});
```

(두 번째 describe의 각 케이스는 Task 1의 승인 생성 패턴과 Task 11의 mock 부트 패턴을 조합해 완전 구현한다 — handler는 `listTools()`가 아니라 내부 `tools` 레코드 접근이 필요하므로, mcp-server에 `export function getToolHandler(name: string)` 헬퍼를 추가한다.)

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — `apps/mcp-server/src/index.ts`에 (딥 상대경로 import — apps 규약):

```ts
import { HciClient, KeystoneV2TokenProvider, HCI_AUTH_CONTRACT_STATUS, collectInventory, readBackVolume, applyCreateVolume, deleteVolume, getVolume, AuditLedger, validateCreateVolumeInput } from '../../../packages/sangfor-hci-client/src/index.js';
import { verifyExecutionApproval } from '../../../packages/sangfor-operator/src/approval.js';
import { consumeApprovalNonce } from '../../../packages/sangfor-operator/src/nonce-store.js';
import { isLoopbackHost } from '../../../packages/shared/src/index.js';
import { randomBytes } from 'node:crypto';

function hciConnection(args: Record<string, unknown> = {}) {
  const identityBaseUrl = String(args.identityBaseUrl ?? process.env.SANGFOR_HCI_IDENTITY_URL ?? 'http://127.0.0.1:3400/openstack/identity/v2.0');
  return {
    identityBaseUrl,
    tenantName: String(args.tenantName ?? process.env.SANGFOR_HCI_TENANT ?? 'lab'),
    username: String(args.username ?? process.env.SANGFOR_HCI_USER ?? 'admin'),
    password: String(args.password ?? process.env.SANGFOR_HCI_PASSWORD ?? 'mock-password'),
    tlsSkipVerify: true,
    host: new URL(identityBaseUrl).hostname,
  };
}
const hciClientFor = (args: Record<string, unknown> = {}) => {
  const cfg = hciConnection(args);
  return { client: new HciClient(new KeystoneV2TokenProvider(cfg), { tlsSkipVerify: cfg.tlsSkipVerify }), cfg };
};

function hciWriteGate(kind: 'hci.create-volume' | 'hci.delete-volume', target: string, host: string, approval: unknown, capabilityId: 'volume_create' | 'volume_delete'): { ok: boolean; error?: string } {
  const verdict = verifyExecutionApproval({ action: { type: kind, target }, approval: approval as never, secret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET });
  if (!verdict.ok) return { ok: false, error: `approval rejected: ${verdict.reason}` };
  const a = approval as { nonce: string; expiresAt: string };
  const consumed = consumeApprovalNonce({ nonce: a.nonce, expiresAt: a.expiresAt });
  if (!consumed.ok) return { ok: false, error: `approval rejected: ${consumed.reason}` };
  if (!isLoopbackHost(host)) {
    if (process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') return { ok: false, error: 'SANGFOR_ALLOW_REAL_EXECUTION=true is required for a non-loopback HCI target.' };
    const safety = getCapabilitySafety('HCI_SCP', capabilityId);
    if (!safety.autoAllowed) return { ok: false, error: `capability ${capabilityId} is ${safety.safetyClass} (not auto_allowed) — real-device write refused until the M4 promotion. ${safety.reason}` };
  }
  return { ok: true };
}
```

tools 레코드에 5개 정의 추가(요지 — description은 정직성 라벨 포함):

```ts
  'sangfor.hci_inventory': {
    description: `Read-only HCI/SCP inventory over the OpenAPI surface (volumes/servers/images). Auth contract: ${HCI_AUTH_CONTRACT_STATUS}.`,
    inputSchema: { type: 'object', properties: { identityBaseUrl: { type: 'string' }, tenantName: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' } } },
    handler: async (args: Record<string, unknown>) => {
      const { client } = hciClientFor(args);
      return { ...(await collectInventory(client)), authContract: HCI_AUTH_CONTRACT_STATUS };
    },
  },
  'sangfor.hci_plan_create_volume': {
    description: 'Plan (no mutation): validate a create-volume intent, mint the idempotency clientToken, and describe the SignedApproval required to apply.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, sizeGb: { type: 'number' }, description: { type: 'string' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb'] },
    handler: (args: { name: string; sizeGb: number; description?: string; identityBaseUrl?: string }) => {
      const clientToken = `cv-${randomBytes(8).toString('hex')}`;
      const problems = validateCreateVolumeInput({ name: args.name, sizeGb: args.sizeGb, description: args.description, clientToken });
      const { cfg } = hciClientFor(args as never);
      return {
        ok: problems.length === 0, problems, mutationPerformed: false,
        plannedRequest: { method: 'POST', path: '/volumes', body: { volume: { name: args.name, size: args.sizeGb, description: args.description ?? null } }, idempotencyHeader: { 'X-Client-Token': clientToken } },
        clientToken,
        approvalRequired: { action: { type: 'hci.create-volume', target: `${cfg.host}:${args.name}` }, fields: ['approvedBy', 'approvalToken', 'changeTicketId', 'rollbackPlanId', 'nonce', 'expiresAt'], mint: 'scripts/mint-hci-approval.ts' },
        rollback: { op: 'hci.delete-volume', note: 'the single documented reverse op; requires its own approval' },
      };
    },
  },
  'sangfor.hci_apply_create_volume': {
    description: 'WRITE: apply a planned create-volume through the state machine (idempotent POST → read-back verify → succeed or HALT). Requires a SignedApproval; nonce is single-use.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, sizeGb: { type: 'number' }, description: { type: 'string' }, clientToken: { type: 'string' }, approval: { type: 'object' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb', 'clientToken', 'approval'] },
    handler: async (args: { name: string; sizeGb: number; description?: string; clientToken: string; approval: unknown; identityBaseUrl?: string }) => {
      const { client, cfg } = hciClientFor(args as never);
      const gate = hciWriteGate('hci.create-volume', `${cfg.host}:${args.name}`, cfg.host, args.approval, 'volume_create');
      if (!gate.ok) return { ok: false, mutationPerformed: false, error: gate.error };
      const result = await applyCreateVolume(client, { name: args.name, sizeGb: args.sizeGb, description: args.description, clientToken: args.clientToken }, new AuditLedger());
      return { ...result, mutationPerformed: result.finalState !== 'FAILED_HALT' || Boolean(result.volumeId), ledger: new AuditLedger().pathFor(result.runId) };
    },
  },
  'sangfor.hci_verify_volume': {
    description: 'Read-only read-back verification of a volume against an expectation (PASS/FAIL/INDETERMINATE; INDETERMINATE never passes).',
    inputSchema: { type: 'object', properties: { volumeId: { type: 'string' }, name: { type: 'string' }, sizeGb: { type: 'number' }, identityBaseUrl: { type: 'string' } }, required: ['name', 'sizeGb'] },
    handler: async (args: { volumeId?: string; name: string; sizeGb: number; identityBaseUrl?: string }) => {
      const { client } = hciClientFor(args as never);
      return readBackVolume(client, { volumeId: args.volumeId, name: args.name, sizeGb: args.sizeGb });
    },
  },
  'sangfor.hci_delete_volume': {
    description: 'DESTRUCTIVE: delete a volume (the reverse op of create). Requires a SignedApproval bound to the exact volumeId. Always refused over the HTTP bridge.',
    inputSchema: { type: 'object', properties: { volumeId: { type: 'string' }, approval: { type: 'object' }, identityBaseUrl: { type: 'string' } }, required: ['volumeId', 'approval'] },
    handler: async (args: { volumeId: string; approval: unknown; identityBaseUrl?: string }) => {
      const { client, cfg } = hciClientFor(args as never);
      const gate = hciWriteGate('hci.delete-volume', `${cfg.host}:${args.volumeId}`, cfg.host, args.approval, 'volume_delete');
      if (!gate.ok) return { ok: false, mutationPerformed: false, error: gate.error };
      const before = await getVolume(client, args.volumeId);
      if (!before) return { ok: false, mutationPerformed: false, error: `volume ${args.volumeId} not found` };
      const res = await deleteVolume(client, args.volumeId);
      const ledger = new AuditLedger();
      const runId = nowId('hci_delete');
      ledger.append(runId, 'request', { op: 'delete-volume', volumeId: args.volumeId, before });
      ledger.append(runId, 'response', { status: res.status });
      return { ok: res.status === 202, mutationPerformed: res.status === 202, status: res.status, runId };
    },
  },
```

집합/카테고리 갱신: `WRITE_TOOLS`에 `'sangfor.hci_apply_create_volume'`, `DESTRUCTIVE_TOOLS`에 `'sangfor.hci_delete_volume'` 추가. `categoryOf`에 `if (name.startsWith('sangfor.hci_')) return 'hci';` 추가. `getToolHandler(name)` export 추가(테스트용). `data/safety/capability-safety.json`에 `HCI_SCP/volume_create`·`HCI_SCP/volume_delete` 항목을 **human_only + reason "M4 real-device slice pending"**으로 명시 추가(기본값 의존 금지 — 명시가 곧 문서).

`scripts/mint-hci-approval.ts`:

```ts
/** Mint a SignedApproval for an HCI write. Usage:
 *  SANGFOR_OPERATOR_APPROVAL_SECRET=... pnpm exec tsx scripts/mint-hci-approval.ts \
 *    --type hci.create-volume --target 127.0.0.1:vol-a --approvedBy jmpark \
 *    --ticket CHG-123 --rollback RB-123 --ttlSec 300
 */
import { randomBytes } from 'node:crypto';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const secret = process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
if (!secret) { console.error('SANGFOR_OPERATOR_APPROVAL_SECRET is required (fail-closed).'); process.exit(1); }
const action = { type: arg('type', 'hci.create-volume')!, target: arg('target')! };
if (!action.target) { console.error('--target is required (host:name or host:volumeId).'); process.exit(1); }
const base = {
  approvedBy: arg('approvedBy', 'unknown')!,
  changeTicketId: arg('ticket', '')!,
  rollbackPlanId: arg('rollback', '')!,
  nonce: randomBytes(12).toString('hex'),
  expiresAt: new Date(Date.now() + Number(arg('ttlSec', '300')) * 1000).toISOString(),
};
console.log(JSON.stringify({ ...base, approvalToken: signApprovalToken(secret, action, base) }, null, 2));
```

`.env.example` 추가: `SANGFOR_HCI_IDENTITY_URL / SANGFOR_HCI_TENANT / SANGFOR_HCI_USER / SANGFOR_HCI_PASSWORD` (주석: 기본은 로컬 mock. 실장비 값은 M4 게이트 이후에만).

- [ ] **Step 4:** `tests/hci-mcp-tools.test.ts` + `tests/mcp-tool-annotations.test.ts`(71개/집합 갱신) PASS → 전체 스위트 + `pnpm run smoke:mcp`.
- [ ] **Step 5: 커밋** — `git commit -m "feat(mcp): 5 hci tools — plan/apply/verify/delete/inventory with signed-approval + safety gates"`

---

### Task 13: M1 Exit Criteria e2e (제안서 §5 대응)

**Files:**
- Test: `tests/hci-slice-e2e.test.ts`

- [ ] **Step 1: e2e 테스트 작성** — mock 서버 1대를 부트하고 **MCP handler 수준**에서 전체 사이클을 관통:

```ts
// 시나리오 (전부 사람 개입 0회, handler 직접 호출):
// 1) hci_plan_create_volume → clientToken/approval 요구사항 획득 (mutation 없음 검증)
// 2) mint approval (signApprovalToken 직접 사용 — 스크립트와 동일 로직)
// 3) hci_apply_create_volume → SUCCEEDED + read-back PASS
// 4) 같은 clientToken + 새 approval로 재-apply → 볼륨 수 그대로(멱등)  ← Exit①
// 5) quota-silent-noop 강제 경로: applyCreateVolume(extraCreateHeaders)로 FAILED_HALT ← Exit②·⑤
// 6) hci_verify_volume 단독 PASS
// 7) hci_delete_volume(대상 바인딩 approval) → 202 → getVolume 폴링 → 404 (복원 완료) ← Exit③(복원)
// 8) AuditLedger.verify(모든 runId) ok:true + 원장 원문에 'mock-password' 부재 ← Exit④
// 9) 승인 재사용 시도 → 거부 (nonce single-use)
```

각 단계는 위 태스크들의 검증된 패턴 조합이므로 코드 중복을 두려워하지 말고 명시적으로 작성한다(e2e는 가독성 우선).

- [ ] **Step 2~4:** FAIL 확인 → (선행 태스크가 전부 완료면 즉시 PASS여야 정상; FAIL이면 해당 태스크 회귀) → 전체 스위트.
- [ ] **Step 5: 커밋** — `git commit -m "test(hci): vertical-slice e2e pins the M1 exit criteria"`
- [ ] **Step 6: M1 마일스톤 기록** — `data/competency/capability-maturity.json`의 HCI_SCP volume_create 항목에 `maturity: 'mock_verified'` + evidence로 `tests/hci-slice-e2e.test.ts` 경로 기재(field_verified는 **M4 전 금지**).

---

# Part 6. 상세 태스크 — M2 자문 3서비스 심화 (M1과 병렬 가능)

### Task 14: `@sangfor/config-state` 패키지 + `sangfor.collect_device_config` 도구

**Files:**
- Create: `packages/sangfor-config-state/package.json` → `{"name":"@sangfor/config-state","type":"module","main":"src/index.ts"}`
- Create: `packages/sangfor-config-state/src/index.ts`
- Modify: `scripts/epp-diagnose.ts` (패키지 사용 thin wrapper로 재작성)
- Modify: `apps/mcp-server/src/index.ts` (도구 1종 추가 — read-only), `tests/mcp-tool-annotations.test.ts` (71→72)
- Modify: `tsconfig.json` paths + `vitest.config.ts` alias
- Test: `tests/config-state.test.ts`, fixture `tests/fixtures/epp-pool.sample.json`

**Interfaces:**
- Consumes: `loadSpec/evaluateSpec/renderAdvisoryReport/renderAdvisoryReportDocx`(@sangfor/spec)
- Produces:
  - `interface ObservedFactJson { value: unknown; source: { endpoint: string; collectedAt: string; collector: string } }`
  - `mapEppPoolToConfigState(pool: Record<string, any>, opts?: { collectedAt?: string; collector?: string }): { product: 'EPP'; observed: Record<string, ObservedFactJson>; endpointsCaptured: number; mappedKeys: string[]; unmappedNote: string }`
  - MCP 도구 `sangfor.collect_device_config` (read-only): `{ product, version, poolPath, docxPath? }` → 매핑+평가+한국어 리포트 원스톱. `live:true` 요청 시 정직한 에러(수집은 VPN+대화형 세션 필요 → 런북 안내)

**매핑 규칙(scripts/epp-diagnose.ts의 검증된 로직을 데이터 주도로 승격 — 날조 금지 원칙):** 엔드포인트가 pool에 없으면 해당 키를 **생략**(→ 하류에서 INDETERMINATE). 절대 기본값을 채우지 않는다.

- [ ] **Step 1: fixture + 실패 테스트** — `tests/fixtures/epp-pool.sample.json` (실측 pool의 최소 재현):

```json
{
  "POST /api/edrgoweb/v1/patch/statistics": { "isLatest": true },
  "POST /api/edrgoweb/v1/vulner/list/homepageVulner": { "vulnerCount": 0 },
  "POST /api/edrgoweb/v1/baseline/getRule": { "count": 1 },
  "POST /api/edrgoweb/v1/domain_detect/get_domain_info": { "count": 35 }
}
```

`tests/config-state.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { mapEppPoolToConfigState } from '@sangfor/config-state';

const pool = JSON.parse(readFileSync('tests/fixtures/epp-pool.sample.json', 'utf8'));

describe('mapEppPoolToConfigState', () => {
  it('maps captured endpoints to observed facts with XHR provenance', () => {
    const r = mapEppPoolToConfigState(pool, { collectedAt: '2026-07-02T00:00:00Z', collector: 'test' });
    expect(r.observed.patchIsLatest.value).toBe(true);
    expect(r.observed.patchIsLatest.source.endpoint).toBe('POST /api/edrgoweb/v1/patch/statistics');
    expect(r.observed.securityBaselineRuleCount.value).toBe(1);
  });
  it('omits keys whose endpoint was not captured (never fabricates)', () => {
    const r = mapEppPoolToConfigState(pool);
    expect(r.observed).not.toHaveProperty('darMonitoringActive');   // 해당 엔드포인트 미캡처
    expect(r.observed).not.toHaveProperty('vulnDefUpdateAvailable');
    expect(r.mappedKeys).not.toContain('darMonitoringActive');
  });
});
```

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — `packages/sangfor-config-state/src/index.ts`:

```ts
// ConfigState extraction: captured authenticated-XHR pools → provenance-carrying
// observed maps for the advisory evaluator. Keys whose endpoint was not captured
// are OMITTED (they must surface as INDETERMINATE downstream, never as defaults).

export interface ObservedFactJson { value: unknown; source: { endpoint: string; collectedAt: string; collector: string }; }

const EPP_PREFIX = 'POST /api/edrgoweb/v1/';

const EPP_KEYMAP: Array<{ key: string; endpoint: string; pick: (d: any) => unknown }> = [
  { key: 'patchIsLatest', endpoint: 'patch/statistics', pick: (d) => d?.isLatest },
  { key: 'vulnDefUpdateAvailable', endpoint: 'vulner/list/version', pick: (d) => d?.update },
  { key: 'vulnerabilityCount', endpoint: 'vulner/list/homepageVulner', pick: (d) => d?.vulnerCount },
  { key: 'securityBaselineRuleCount', endpoint: 'baseline/getRule', pick: (d) => d?.count },
  { key: 'maliciousDomainBlockCount', endpoint: 'domain_detect/get_domain_info', pick: (d) => d?.count },
  { key: 'darMonitoringActive', endpoint: 'cnapp/professional/dar/webapi/interval/status', pick: (d) => (d?.interval != null) },
];

export function mapEppPoolToConfigState(
  pool: Record<string, any>,
  opts: { collectedAt?: string; collector?: string } = {},
): { product: 'EPP'; observed: Record<string, ObservedFactJson>; endpointsCaptured: number; mappedKeys: string[]; unmappedNote: string } {
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const collector = opts.collector ?? 'live-xhr-pool';
  const observed: Record<string, ObservedFactJson> = {};
  for (const { key, endpoint, pick } of EPP_KEYMAP) {
    const full = `${EPP_PREFIX}${endpoint}`;
    if (!(full in pool)) continue; // uncaptured → omitted → INDETERMINATE downstream
    const value = pick(pool[full]);
    if (value === undefined) continue;
    observed[key] = { value, source: { endpoint: full, collectedAt, collector } };
  }
  return {
    product: 'EPP',
    observed,
    endpointsCaptured: Object.keys(pool).length,
    mappedKeys: Object.keys(observed),
    unmappedNote: 'keys without a captured endpoint are omitted on purpose; the evaluator must treat them as INDETERMINATE',
  };
}
```

MCP 도구(`apps/mcp-server/src/index.ts`, read-only — WRITE/DESTRUCTIVE 등록 불필요):

```ts
  'sangfor.collect_device_config': {
    description: 'Advisory: map a captured device XHR pool file (from scripts/device-collect.ts) into a provenance-carrying ConfigState, evaluate it against the IntendedSpec, and render the Korean advisory report. Read-only; live capture is not performed by this tool (VPN + interactive session required — see docs/DEVICE_DIAGNOSIS_RUNBOOK.md).',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, poolPath: { type: 'string' }, docxPath: { type: 'string' }, live: { type: 'boolean' } }, required: ['product', 'version', 'poolPath'] },
    handler: (args: { product: string; version: string; poolPath: string; docxPath?: string; live?: boolean }) => {
      if (args.live) return { error: 'live capture is not available from this tool: it needs VPN + an interactive browser session. Run scripts/device-collect.ts per docs/DEVICE_DIAGNOSIS_RUNBOOK.md, then pass the pool file here.' };
      if (normalizeProduct(args.product) !== 'ENDPOINT_SECURE') return { error: `no pool mapper for ${args.product} yet (EPP only). CC/IAG mappers land with the M3 campaign — fabricating one without captured data is forbidden.` };
      const pool = JSON.parse(readFileSync(args.poolPath, 'utf8'));
      const mapped = mapEppPoolToConfigState(pool);
      const spec = loadSpec('EPP', args.version);
      if (!spec) return { error: `no IntendedSpec for EPP ${args.version}. Coverage: ${JSON.stringify(listSpecCoverage())}` };
      const result = evaluateSpec(spec, mapped.observed);
      const report = renderAdvisoryReport(spec, result);
      const docx = args.docxPath ? renderAdvisoryReportDocx(spec, result, args.docxPath) : undefined;
      return { mapped: { endpointsCaptured: mapped.endpointsCaptured, mappedKeys: mapped.mappedKeys }, result, report, ...(docx ? { docx } : {}) };
    },
  },
```

`scripts/epp-diagnose.ts` 재작성: 파일 읽기/출력 경로만 남기고 매핑은 `mapEppPoolToConfigState` 호출로 교체(출력 동일성 유지 — 기존 산출물 `outputs/diagnosis/EPP_6.0.4_*`와 diff로 확인).

- [ ] **Step 4:** 테스트 + annotations(72) + 전체 스위트.
- [ ] **Step 5: 커밋** — `git commit -m "feat(config-state): pool→ConfigState mapping as a library + collect_device_config MCP tool"`

---

### Task 15: `context_dependent` 분류 추가 (부록A 서비스③ 5분류 완성)

**Files:**
- Modify: `packages/sangfor-spec/src/index.ts` (타입 + evaluateSpec + renderAdvisoryReport)
- Test: `tests/spec-context-dependent.test.ts`

**Interfaces:**
- Consumes/Produces (변경분):
  - `type Category = 'ok' | 'misconfiguration' | 'missing' | 'indeterminate' | 'context_dependent'`
  - `SpecItem`에 `contextDependent?: boolean` 추가
  - `EvaluationSummary`에 `contextDependent: number` 추가
  - 의미론: verdict가 FAIL인 항목 중 `contextDependent===true`인 것은 category `'context_dependent'`로 분류되어 misconfiguration/missing 카운트에서 제외. **result.ok 계산은 불변**(모든 항목 PASS일 때만 true — 조건부 항목도 사람 확인 전엔 ok가 될 수 없다).

- [ ] **Step 1: 실패 테스트** — `tests/spec-context-dependent.test.ts`:

```ts
import { evaluateSpec, renderAdvisoryReport, type IntendedSpec } from '@sangfor/spec';

const spec: IntendedSpec = {
  product: 'IAG', version: '13.0.120', title: 'ctx test',
  items: [
    { id: 'ssl-decrypt', capabilityId: 'ssl', label: 'SSL 복호화 예외', observedKey: 'sslDecryptExceptions', op: 'gte', expected: 1, severity: 'recommended', contextDependent: true, source: { manual: 'IAG User Manual v13.0.120', section: 'Proxy > SSL Decryption' } },
    { id: 'ha', capabilityId: 'ha', label: 'HA', observedKey: 'haEnabled', op: 'eq', expected: true, severity: 'recommended', source: { manual: 'IAG User Manual v13.0.120', section: 'System > HA' } },
  ],
} as IntendedSpec; // 실제 필드명은 packages/sangfor-spec/src/index.ts의 SpecItem 정의를 따른다

describe('context_dependent classification', () => {
  it('routes a deviating contextDependent item to its own category (not misconfiguration/missing)', () => {
    const r = evaluateSpec(spec, { sslDecryptExceptions: 0, haEnabled: false });
    const ctx = r.items.find((i) => i.itemId === 'ssl-decrypt');
    expect(ctx?.category).toBe('context_dependent');
    expect(r.summary.contextDependent).toBe(1);
    expect(r.summary.missing).toBe(1);          // ha는 기존 분류 유지
    expect(r.ok).toBe(false);                    // 조건부 항목도 ok를 막는다
  });
  it('renders a dedicated Korean section', () => {
    const r = evaluateSpec(spec, { sslDecryptExceptions: 0, haEnabled: true });
    expect(renderAdvisoryReport(spec, r)).toContain('환경 의존');
  });
});
```

(주의: `ItemResult`의 항목 id 필드명·`source` 구조는 실제 spec 패키지 정의에 맞춰 조정 — 계약은 "FAIL+contextDependent→context_dependent, 카운트 분리, ok 불변, 리포트 섹션".)

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — evaluateSpec의 category 결정 지점에서:

```ts
// 기존: FAIL이면 severity에 따라 misconfiguration(must) | missing(recommended)
// 변경: FAIL && item.contextDependent === true 이면 'context_dependent'
const category: Category =
  verdict === 'PASS' ? 'ok'
  : verdict === 'INDETERMINATE' ? 'indeterminate'
  : item.contextDependent === true ? 'context_dependent'
  : item.severity === 'must' ? 'misconfiguration'
  : 'missing';
```

summary 집계에 `contextDependent` 추가. `renderAdvisoryReport`에 섹션 추가(잘못됨/추가필요/판정불가 뒤):

```
### 환경 의존 (고객 환경 프로파일 확인 필요 — 조건부)
권장 기준과 다르지만, 고객 환경(규모·망분리·컴플라이언스·업무 앱)에 따라 의도된 구성일 수 있습니다.
아래 항목은 잘못된 설정으로 단정하지 않으며, 담당 엔지니어가 환경 프로파일과 대조해 확정해야 합니다.
```

DOCX 렌더러는 markdown 경유이므로 자동 반영(스모크로 확인).

- [ ] **Step 4:** 신규 + 기존 spec 스위트 6종 전부 PASS(기존 분류 회귀 없음).
- [ ] **Step 5: 커밋** — `git commit -m "feat(spec): context_dependent category — conditional findings never inflate misconfigurations"`

---

### Task 16: spec 시드 확대 (24 → 40+ 항목, 전부 출처 인용)

**Files:**
- Modify: `data/specs/{EPP/6.0.4,IAG/13.0.120,CC/3.0.98,HCI/6.11.3,NGFW/8.0.107,XDR/3.0.98}/*.spec.json`
- Modify: `packages/sangfor-spec/src/index.ts` (SpecItem에 `observation?: { method: 'xhr'|'dom'|'human'; hint: string }` 선택 필드 — 엔진 동작 불변, 수집 런북 연결용)
- Test: 기존 `tests/spec-loader.test.ts` 통과 유지 + 항목 수 하한 테스트 추가

**절차(항목당 — 날조 금지 프로토콜):**
1. `sangfor.rag_search`(또는 `ragSearchSync`)로 후보 근거 검색. 예: `{ query: 'IAG audit log retention 802.1X web authentication', product: 'IAG' }`
2. 반환 청크의 `title/section/text`에서 **기대값이 실제로 명시된 문장**을 확인. 값이 명시되지 않으면 `op:'exists'` 수준으로만 작성하거나 항목을 포기한다.
3. SpecItem 작성 — `source`에 청크의 매뉴얼 제목·섹션 경로를 그대로 인용, `observation.hint`에 콘솔 경로(예: `IAG: System > Audit > Retention — aside snapshot 필요`) 기재.
4. 환경 의존 성격(SSL 예외·HA·망분리 등)이면 `contextDependent: true`.
5. `pnpm exec vitest run tests/spec-loader.test.ts` — 로더가 새 파일을 소화하는지 즉시 확인.

**우선 추가 목록(런북 "다음 개선"과 M3 수집 계획에 정렬):**
- EPP 6.0.4: 멀웨어 스캔 스케줄(observation: Defense 정책 페이지), 에이전트 자동업데이트, 격리 정책 존재
- IAG 13.0.120: 감사로그 보존기간(≥1년 — 국내 규정 근거는 knowledge의 기존 1년 보존 규정 재인용), 웹 인증 활성, 802.1X(contextDependent), SSL 복호화 예외(contextDependent)
- CC 3.0.98: NTP 동기화(상관분석 근간), 이벤트소스 수, 알람 노이즈 임계(contextDependent)
- HCI 6.11.3: 클러스터 노드 수 ≥2(contextDependent), 스토리지 리플리카, 관리망 분리
- 하한 테스트: `listSpecCoverage()` 합계 ≥ 40 assert.

- [ ] **커밋** — `git commit -m "data(specs): expand seeded spec items to 40+ with manual citations + observation hints"`

---

# Part 7. 게이트드 마일스톤 M3~M6 (런북 — 코드 태스크 아님)

> 이 마일스톤들은 사람/장비 조건(VPN 연결, HCI 장비 존재, tenant 계정)이 충족되어야 진행된다. 각 단계는 "코드 작성"이 아니라 **캡처·대조·승격 이벤트**다. 조건 미충족 시 M0~M2 완료 상태로 정지하는 것이 정상이며, 미완을 숨기지 않는다.

## M3 — 실장비 read-only 진단 캠페인 (게이트 G-VPN)

**진입 조건:** 사람이 FortiClient로 10.80.1.x 연결(VPN 비밀번호는 사람이 입력, 코드/계획에 미기재). 연결 확인 = `utun` 인터페이스 + 10.80.1.106/107/108 도달성 재프로브(내가 네트워크측 검증만).

1. **CC 최초 ConfigState 수집** (현재 0회) — `scripts/device-collect.ts`로 CC(10.80.1.107, Vue SPA 추정) 로그인(CAPTCHA=vision)+메뉴 순회→XHR pool. CC용 keymap을 `@sangfor/config-state`에 추가(EPP 패턴 복제, **캡처된 엔드포인트로만**). 목표 ≥5키.
2. **IAG deep config** — aside repl snapshot으로 Audit/Auth/802.1X 페이지 개별 네비 → 판정불가 3건 해소 시도. 해소 못하면 정직하게 INDETERMINATE 유지.
3. **실장비 버전 진실표** — EPP/CC/IAG 실제 빌드 확정 → `data/version/requirements.json`·spec 디렉터리와 대조, 불일치 문서화(부록A 디스커버리 게이트 2 종결).
4. **산출** — `sangfor.collect_device_config`로 3장비 진단 리포트 갱신, `outputs/diagnosis/` 커밋.

**Exit:** 3장비 리포트 최신화, CC ≥5키, 버전 진실표 `docs/DEVICE_DIAGNOSIS_RUNBOOK.md`에 반영.

## M4 — HCI 실행 슬라이스 실장비 관통 (게이트 G-HCI)

**진입 조건:** ① 랩에 HCI(aCMP) 장비 존재·접근 확인(Part 8 결정 1) ② OpenAPI/tenant 계정 활성(결정 2) ③ 유지보수 윈도우.

1. **인증 계약 대조 (spike)** — 실장비에서 Keystone `POST /openstack/identity/v2.0/tokens` 1회 호출(read-only). 응답이 Task 5 catalog·Task 7 provider 계약과 일치하는지 대조. 불일치 시 provider를 실측에 맞춰 수정하고 `HCI_AUTH_CONTRACT_STATUS`를 `verified_on_<host>_<date>`로 승격. **일치할 때까지 write 금지.**
2. **read-only smoke** — `sangfor.hci_inventory` 실장비 실행. serviceCatalog·volumes GET이 토큰 갱신 포함 안정 동작 확인.
3. **create-volume 실장비 1회 관통** — `SANGFOR_ALLOW_REAL_EXECUTION=true` + `data/safety/capability-safety.json`의 `HCI_SCP/volume_create`를 `auto_allowed`로 승격(evidence=M4 캡처 로그) + `mint-hci-approval.ts`로 대상 바인딩 승인 발급 → `hci_apply_create_volume` → SUCCEEDED(read-back PASS) → `hci_delete_volume`로 복원. 전 과정 원장 기록.
4. **fail-closed 실증** — 모호/쿼터초과 조건에서 halt 확인(false-pass 0).

**Exit(제안서 §5 Exit Criteria 실장비판):** ①멱등 ②실장비 read-only smoke 안정 ③fail-closed 증명 ④사람 개입 0회 apply→verify→복원 ⑤false-pass 0. 통과 후에만 `capability-maturity.json`을 `field_verified`로 승격(evidence 링크 필수).

## M5 — EPP/CC spec 심화 (게이트 M3)

M3에서 확정한 실장비 버전으로 spec 디렉터리 정렬(버전 정확 일치만 GREEN). EPP/CC 항목을 실측 ConfigState가 커버하는 범위까지 확대. 커버 못하는 항목은 추가하지 않는다(수집기 미도달=미작성).

## M6 — HCI 운영점검 리포트 + 주기화 (게이트 M4)

1. `@sangfor/hci-client`에 `ops-monitor.ts`(read-only 헬스: 볼륨 상태 분포·에러 볼륨·서버 전원 상태) + `renderHciHealthReport`(한국어 DOCX, `sangfor-spec` DOCX 렌더러 재사용).
2. MCP `sangfor.hci_health_report`(read-only) 추가.
3. `automation/`에 주기 진단 launchd(기존 learn 자동화 패턴 복제, VPN 연결 시에만).
4. `sangfor.field_engineer_coverage` 재실행 → 대체율 정직 갱신(evidence 링크 필수).

---

# Part 8. 결정·리스크·검증

## M7 — 위임 확대 반복 규칙 (빌드 아님)

north-star("설정 일부를 맡김")는 다음 루프의 **반복**으로만 열린다. 각 신규 가역 write capability는 동일 사다리를 밟는다:
`read-only 표면 확보 → mock 계약+상태기계 TDD → 실장비 계약 대조 → fail-closed 실증 → safety_class 승격(evidence 링크) → maturity field_verified 승격`.
후보 순서(가역성·self-lockout 없음 우선): volume 확장(PUT) → server metadata update → flavor 조회기반 자문. **비가역·self-lockout·보안제품 write는 이 루프에 넣지 않는다(영구 사람).** 대체율은 `sangfor-competency`가 evidence 있는 atom만 세므로 자동으로 정직하게 오른다.

## 사용자 결정 필요 (착수 전/게이트 전)

1. **[M4 게이트] HCI 실장비 존재·접근** — 랩에 HCI(aCMP) 장비가 있는가? 현재 메모리엔 EPP/CC/IAG 3종만 확인됨. 없으면 M4는 무기한 보류(M0~M2·M3는 영향 없음).
2. **[M4 게이트] OpenAPI/tenant 계정** — aCMP OpenAPI가 활성이고 tenant 자격증명이 발급되는가? (문서 예제는 `tenantName`+`passwordCredentials`).
3. **[M4] create-volume vs metadata-update** — 첫 실장비 가역 write 대상. 권장=create-volume(read-back 신호 또렷, 쿼터 영향만 주의). 계획은 create-volume 기준.
4. **[정책] 원격 write 배포** — http-bridge를 실제로 원격 노출할 계획이 있는가? 없으면 `SANGFOR_ALLOW_REMOTE_WRITE`는 영원히 미설정(권장).
5. **[운영] 실장비 성격** — HCI 장비가 공유 POC인지 전용 lab인지(device lock 강도·유지보수 윈도우 정책).

*이 결정들은 M0~M2 착수를 막지 않는다. M0~M2는 지금 바로 시작할 수 있고, 결정 1·2는 M4 진입 직전에만 필요하다.*

## 교차 리스크 Top 8

| # | 리스크 | 완화 |
|---|--------|------|
| 1 | 문서 계약이 실장비와 다름(2019~2020 문서, 2026 장비) | `HCI_AUTH_CONTRACT_STATUS` 라벨을 mock 단계 전면 노출; M4 대조 전 write 금지; 계약 불일치는 provider 수정으로 흡수 |
| 2 | 202를 성공으로 오인 | read-back oracle 전용(Task 9), mock에 202-무noop 함정 심음(Task 6), FAILED_HALT(Task 11), e2e 게이트(Task 13) |
| 3 | 승인 재사용/위조 | action-bound HMAC(기존) + 단일사용 nonce store(Task 1) + 만료 |
| 4 | 원격 write 노출 | destructive 항상 거부 + write는 비-loopback 기본 거부(Task 2), delete는 annotations로 원격 영구 차단 |
| 5 | mock과 실장비 동작 드리프트(멱등·상태전이) | mock을 문서 예제 구조에 충실히; M4 read-only smoke로 조기 대조; 드리프트는 fixture/mock 갱신으로 반영 |
| 6 | 자동 롤백이 2차 사고 | 자동 역연산 금지(Task 11 halt-only). 복원 delete는 별도 승인·수동 트리거·destructive 격리 |
| 7 | 진단 날조(미캡처 키를 기본값으로) | 매핑기가 미캡처 키 생략(Task 14), INDETERMINATE≠PASS(기존), spec 확대는 인용 검증 프로토콜(Task 16) |
| 8 | 신규 패키지 워크스페이스 미링크로 CI 실패 | Global Constraint 10(3종 세트 등록 + `pnpm install`), 각 신규 패키지 Task Step에 alias 등록 명시 |

## 검증 명령 (모든 태스크 공통)

```bash
pnpm test                 # 전체 Vitest (기존 214 + 신규). 태스크별로는 pnpm exec vitest run tests/<file>.test.ts
pnpm run lint             # tsc --noEmit
pnpm run build            # 빌드 영향 태스크(신규 패키지 추가 시)
pnpm run smoke:mcp        # MCP 도구 등록 스모크 (Task 12/14 이후 필수)
pnpm run check:mcp-scorecard
MOCK_NO_SERVE=1 pnpm exec vitest run tests/mock-openstack.test.ts   # mock 서버 단독
```

## 실행 순서 요약

```
M0(Task 1→2→3→4) ──▶ main 머지
M1(Task 5→6→7→8→9→10→11→12→13) 순차(각 태스크가 이전 Produces에 의존) ──▶ main 머지
M2(Task 14→15→16) M1과 병렬 가능(공유 파일 apps/mcp-server/index.ts·mcp-tool-annotations.test.ts만 머지 순서 주의)
M3~M6 게이트 충족 시 (Part 7 런북)
```

---

# Part 9. 실행 방법 — opencode

> 코딩은 **opencode**(터미널 AI 코딩 에이전트)에 위임한다. 이 파트는 opencode가 이 계획을 태스크 단위로 안전하게 구현하도록 하는 운영 절차다. **사람(감독자)은 마일스톤 경계에서만 개입**하고, opencode가 태스크 내부 TDD 루프를 자율 수행한다.

## 9.1 왜 opencode가 이 계획과 잘 맞나

- opencode는 저장소 루트의 **`AGENTS.md`를 자동으로 읽는다.** 이 저장소엔 이미 `AGENTS.md`가 있어 pnpm 사용·검증 명령·live 실행 게이트 규약이 컨텍스트로 들어간다. (Global Constraints와 중복되지만 상호 보강.)
- 각 태스크가 **자체 완결형**(Files/Interfaces/Step 1~5 + 커밋)이라 opencode에 "Task N을 구현하라" 한 문장으로 위임 가능하다.
- 모든 검증이 **명령 한 줄로 관측 가능**(`pnpm test`, `pnpm run lint`)해 opencode가 스스로 RED→GREEN을 판정한다.

## 9.2 세션 부트스트랩 (전체 착수 전 1회)

사람이 수행하거나 opencode 첫 프롬프트로 지시:

```bash
corepack enable && pnpm install
pnpm test            # 기존 214 통과 = 시작 baseline 초록불 확인 (여기서 실패하면 계획 착수 금지)
pnpm run lint        # tsc --noEmit clean 확인
git switch -c feat/m0-trust-residuals   # 첫 마일스톤 브랜치 (Global Constraint 12)
```

opencode 설정 권장값:
- **모델:** 코딩 정확도 높은 모델 지정(opencode `Models` 설정). 이 계획은 TypeScript 시그니처 정합이 중요하므로 상위 모델 권장.
- **권한(permission):** `edit`·`bash`는 허용하되, 파괴적 명령(`rm -rf`, force push)은 확인 프롬프트 유지. opencode의 permission 설정으로 `git push`는 사람 승인.
- **컨텍스트 절약:** 계획서(2,312줄)를 통째로 물리지 말고 **태스크 섹션만 참조**시킨다 — 아래 프롬프트 템플릿이 그 방식이다.

## 9.3 태스크 실행 루프 (opencode에 반복 위임)

**한 태스크 = 한 opencode 세션(또는 한 프롬프트).** 대화형 TUI에서 아래를 붙여넣거나, 비대화형으로 `opencode run "<프롬프트>"`.

**프롬프트 템플릿:**

```
docs/superpowers/plans/2026-07-02-final-goal-master-plan.md 의 "Task N" 섹션과
"Global Constraints" 섹션을 읽어라. 그 태스크를 Step 1~5 순서대로 정확히 구현한다:

규칙:
- TDD 엄수: 먼저 실패하는 테스트를 쓰고(Step 1), 실제로 RED를 확인한 뒤(Step 2)
  최소 구현으로 GREEN을 만든다(Step 3~4). RED가 안 뜨면 멈추고 테스트를 의심하라.
- 계획의 코드 블록은 "의도의 정본"이다. 그러나 실제 파일의 타입/시그니처가 계획과
  다르면 실제 코드를 진실로 삼아 맞춘다(계획서 "알려진 조정 지점" 참조). 추측 금지 —
  불확실하면 해당 심볼을 먼저 grep/read로 확인하라.
- 태스크 완료 조건: `pnpm test && pnpm run lint` 전체 통과. 신규 패키지 추가 태스크면
  `pnpm run build`도. Task 12/14 이후엔 `pnpm run smoke:mcp`도.
- 통과하면 Step 5의 커밋 메시지로 커밋한다(Conventional Commits). main에 머지하지 마라.
- 절대 하지 말 것: 실패한 테스트를 삭제/스킵해서 GREEN 위장, 계획에 없는 범위 확대,
  실제 자격증명/시크릿 커밋, 게이트 우회.

끝나면 (a) 무엇을 만들었는지 (b) 테스트 결과 원문 (c) 계획과 달라 조정한 부분을
간단히 보고하라.
```

`Task N` 자리에 1~16을 넣어 순차 진행한다.

**opencode가 태스크 중 멈춰야 하는 신호(멈추고 사람에게 보고):**
- RED가 안 뜬다(테스트가 기존 코드로 이미 통과) → 테스트가 행동을 검증하지 않는다.
- 계획의 시그니처와 실제 코드가 화해 불가능하게 충돌.
- `pnpm test`가 **다른 기존 스위트**를 깨뜨린다(회귀) → 원인 규명 전 커밋 금지.

## 9.4 태스크 의존성과 순서 (opencode에 강제)

```
M0: Task 1 → 2 → 3 → 4        (T1은 T12가 재사용하므로 먼저)
M1: Task 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13   (엄격 순차 — 각 태스크가 이전 Produces에 의존)
M2: Task 14 → 15 → 16         (M1과 병렬 가능하나, apps/mcp-server/src/index.ts 와
                               tests/mcp-tool-annotations.test.ts 를 T12·T14가 함께 건드리므로
                               두 태스크를 같은 브랜치에서 순차로 두거나 머지 순서를 고정)
```

opencode에 **한 번에 한 태스크만** 맡긴다. 여러 태스크를 한 프롬프트로 묶지 말 것(중간 검증 게이트가 사라진다).

## 9.5 마일스톤 게이트 — 사람 체크포인트

opencode가 마일스톤의 마지막 태스크까지 커밋을 마치면 **사람이 리뷰 후 머지**한다. opencode는 자동 머지·push하지 않는다.

- **M0 완료 후:** `pnpm test && pnpm run lint` 재확인 → 사람이 T1~T4 diff 리뷰 → `git switch main && git merge --no-ff feat/m0-trust-residuals`. 이어 `feat/m1-hci-slice` 생성.
- **M1 완료 후:** 위 + `pnpm run smoke:mcp` + **`tests/hci-slice-e2e.test.ts`(Task 13)가 M1 Exit Criteria 5항목을 실제로 검증하는지** 사람이 눈으로 확인(이게 M1의 핵심 증적). 머지.
- **M2 완료 후:** 위 + spec 커버리지 하한(≥40) 확인. 머지.
- **M3~M6:** Part 7 런북(코드 태스크 아님 — 캡처·대조·승격 이벤트). VPN/장비 게이트 충족 시에만.

리뷰 관점(사람): ① 테스트가 행동을 검증하는가(구현을 그대로 베낀 assert 아닌가) ② INDETERMINATE≠PASS·날조금지·fail-closed 원칙 위반 없나 ③ 시크릿/자격증명 잔류 없나 ④ 계획에 없는 범위 확대 없나.

## 9.6 opencode에 넘기기 전 사람이 확정할 것

- **M0~M2는 지금 바로 위임 가능** — 실장비/VPN 무관, mock-first.
- **M4는 Part 8 결정 1·2**(HCI 실장비 존재·계정)가 확정돼야 진입. 그 전까지 opencode는 M0~M3 범위만.
- opencode 세션에 실 자격증명을 절대 주지 않는다. HCI 접속값은 M4에서 사람이 `.env`로만 주입(계획의 `SANGFOR_HCI_*` env, 기본은 로컬 mock).

## 9.7 진행 추적

각 태스크의 `- [ ]` 체크박스를 opencode(또는 사람)가 완료 시 `- [x]`로 갱신하면 계획서 자체가 진행 대시보드가 된다. 커밋 로그(`git log --oneline`)의 Conventional Commit 스코프(`feat(operator)`, `feat(hci-client)`, `feat(mcp)` …)로 어느 태스크까지 왔는지 교차 확인 가능.

---

## Self-Review (작성자 체크)

- **스펙 커버리지:** G1(실행기)→Task 5~13, G2(HCI 클라)→Task 7~11, G3(R1 nonce)→Task 1, G4(R3 원격)→Task 2, G5(navigate)→Task 3, G6(문서드리프트)→Task 4, G7(수집 산개)→Task 14, G8(CC/IAG deep)→M3. 부록A 서비스③ 5분류→Task 15. spec 확대→Task 16. north-star→M7 규칙. **미대응 갭 없음.**
- **플레이스홀더:** 코드 스텝은 전부 실제 코드 블록. "적절한 에러처리" 류 금지어 없음. 실장비 값(비밀번호 등)만 의도적으로 런타임 대체 표기.
- **타입 일관성:** `HciClient.request` 시그니처가 Task 7 정의와 Task 8/9/11 사용처에서 동일. `ReadBackResult`/`ApplyResult`가 정의처(Task 9/11)와 소비처(Task 12/13) 일치. `SignedApproval`/`LiveExecutionApproval` 필드(nonce/expiresAt)는 실제 코드(`operator/src/index.ts:47-56`, `approval.ts:22-29`)와 일치 확인. `getCapabilitySafety` 반환 필드(autoAllowed/safetyClass)는 실제 코드(`safety/src/index.ts:84-92`) 일치.
- **알려진 조정 지점(구현자 유의):** ① `startOperatorSession` 입력 필드명 → 기존 `tests/operator-execution-gate.test.ts` 확인 후 맞춤 ② `SpecItem`/`ItemResult` 실제 필드명 → `packages/sangfor-spec/src/index.ts` 정의 우선 ③ mock ephemeral 포트 vs catalog 고정 포트 → 테스트에서 rebase 또는 `identityBaseUrl` 주입(Task 6/12 노트) ④ `createVolumeWithHeaders` → volumes.ts `createVolume`에 `extraHeaders` 인자 추가로 단순화 권장.









