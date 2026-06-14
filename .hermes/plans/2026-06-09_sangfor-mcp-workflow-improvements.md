# Sangfor Engineer MCP — 3대 핵심 워크플로우 개발 계획서

**작성일**: 2026-06-09  
**프로젝트**: sangfor-engineer-mcp  
**목적**: MCP tools 활용도 극대화를 위한 3대 자동화 워크플로우 구축

---

## 📋 전체 개요

현재 38개 MCP tools가 개별적으로 존재하지만, 실제 업무 흐름으로 연결되어 있지 않습니다. 이 계획서는 세 가지 핵심 워크플로우를 구축하여 MCP tools의 실질 활용도를 극대화하는 것을 목표로 합니다.

| 워크플로우 | 목적 | 핵심 tools | 우선순위 |
|-----------|------|-----------|---------|
| ① 프로젝트 올인원 | Excel → 가이드 → 검증 → 보고서 자동화 | 8개 tools 연동 | 🔴 높음 |
| ② 실장비 일상 점검 | 정기 정책 상태 확인 + 이상 감지 | 4개 tools + 크론 | 🟡 중간 |
| ③ Obsidian 연동 | 피드백 → 교훈 → 위키 자동 반영 | 4개 tools + 크론 | 🟡 중간 |

---

## ① 프로젝트 시작 올인원 워크플로우

### Goal
고객 프로젝트 수주 시, Excel 체크리스트 하나로 설정 가이드 생성부터 실장비 검증, 보고서 제출까지 **원클릭 자동화**.

### Current Context
- `sangfor.import_excel_requirement_list` — Excel 체크리스트 파싱 ✅
- `sangfor.analyze_customer_requirements` — 요구사항 분석 ✅
- `sangfor.generate_product_change_plan` — 변경 계획 생성 ✅
- `sangfor.generate_all_guides` — 가이드 일괄 생성 ✅
- `sangfor.capture_screenshots` — 실장비 캡처 ✅
- `sangfor.generate_evidence_report` — 보고서 생성 ✅

**문제**: 각 tool을 개별적으로 호출해야 하므로, 사용자가 순서를 알아야 하고 중간 결과를 수동으로 전달해야 합니다.

### Proposed Approach
**새로운 orchestrator tool** `sangfor.run_project_pipeline`을 추가하여, 기존 tools를 순차적으로 호출하고 중간 결과를 자동 전달하는 파이프라인을 구축합니다.

### Step-by-Step Plan

#### Phase 1: 파이프라인 Orchestrator 구현 (1-2일)
```
파일: packages/sangfor-product-adapters/src/project-pipeline.ts
```

1. **`ProjectPipelineInput` 인터페이스 정의**
   ```typescript
   interface ProjectPipelineInput {
     customerName: string;
     excelFilePath: string;           // ITAC Excel 체크리스트
     products?: string[];             // 대상 제품 (자동 감지 가능)
     outputDir?: string;              // 출력 디렉토리
     captureScreenshots?: boolean;    // 실장비 캡처 여부
     screenshotProducts?: string[];   // 캡처 대상 제품
     targetUrls?: Record<string, string>;  // 제품별 URL
     credentials?: Record<string, { username: string; password: string }>;
     dryRun?: boolean;                // 실장비 변경 없이 미리보기만
   }
   ```

2. **`ProjectPipelineResult` 인터페이스 정의**
   ```typescript
   interface ProjectPipelineResult {
     pipelineId: string;
     customerName: string;
     startedAt: string;
     completedAt: string;
     steps: {
       excelParsing: { status: 'success' | 'error'; rows: number; error?: string };
       requirementAnalysis: { status: 'success' | 'error'; tasks: number; error?: string };
       changePlan: { status: 'success' | 'error'; planId: string; error?: string };
       guideGeneration: { status: 'success' | 'error'; files: string[]; error?: string };
       screenshotCapture?: { status: 'success' | 'error'; captured: number; error?: string };
       evidenceReport: { status: 'success' | 'error'; reportPath: string; error?: string };
     };
     outputs: {
       settingGuideDocx?: string;
       settingGuidePptx?: string;
       operationsGuideDocx?: string;
       operationsGuidePptx?: string;
       comprehensiveSettingDocx?: string;
       comprehensiveOperationsDocx?: string;
       screenshots?: Record<string, string[]>;
       evidenceReport?: string;
     };
     errors: string[];
   }
   ```

3. **`runProjectPipeline` 함수 구현**
   ```typescript
   export async function runProjectPipeline(input: ProjectPipelineInput): Promise<ProjectPipelineResult> {
     const pipelineId = nowId('pipeline');
     const startedAt = new Date().toISOString();
     const steps: ProjectPipelineResult['steps'] = {} as any;
     const outputs: ProjectPipelineResult['outputs'] = {};
     const errors: string[] = [];
     
     // Step 1: Excel 파싱
     // Step 2: 요구사항 분석
     // Step 3: 변경 계획 생성
     // Step 4: 가이드 일괄 생성
     // Step 5: 실장비 캡처 (선택)
     // Step 6: 보고서 생성
     
     return { pipelineId, customerName: input.customerName, startedAt, completedAt: new Date().toISOString(), steps, outputs, errors };
   }
   ```

#### Phase 2: MCP Tool 등록 (즉시)
```
파일: apps/mcp-server/src/index.ts
```

4. **`sangfor.run_project_pipeline` tool 추가**
   - inputSchema: `ProjectPipelineInput`
   - handler: `runProjectPipeline`
   - description: "Run complete project pipeline: Excel → requirements → change plan → guides → screenshots → evidence report"

5. **`sangfor.get_pipeline_status` tool 추가**
   - 진행 중인 파이프라인 상태 조회
   - 각 단계별 진행률 표시

#### Phase 3: 웹 UI 연동 (선택, 2-3일)
```
파일: apps/operator-console/src/api.ts
```

6. **REST API 엔드포인트 추가**
   - `POST /api/pipeline/run` — 파이프라인 시작
   - `GET /api/pipeline/:id/status` — 상태 조회
   - `GET /api/pipeline/:id/outputs` — 결과 다운로드

7. **웹 UI에서 Excel 업로드 + 파이프라인 실행 화면**

### Files Likely to Change
- `packages/sangfor-product-adapters/src/project-pipeline.ts` (신규)
- `packages/sangfor-product-adapters/src/index.ts` (export 추가)
- `apps/mcp-server/src/index.ts` (tool 등록)
- `apps/operator-console/src/api.ts` (REST API, 선택)
- `tests/project-pipeline.test.ts` (신규)

### Tests / Validation
1. **단위 테스트**: `tests/project-pipeline.test.ts`
   - Excel 파싱 → 요구사항 분석 → 변경 계획 생성 파이프라인 테스트
   - 각 단계별 에러 핸들링 테스트
   - dryRun 모드 테스트

2. **통합 테스트**: 기존 Excel 파일로 전체 파이프라인 실행
   - `pnpm run dev:mcp` → `sangfor.run_project_pipeline` 호출
   - 출력 파일 생성 확인 (DOCX, PPTX, 보고서)

3. **실장비 테스트**: lab 환경에서 실장비 캡처 포함 파이프라인 실행

### Risks & Tradeoffs
| 위험 | 완화 방안 |
|------|----------|
| 실장비 캡처 실패 (네트워크, 로그인) | 각 단계별 독립적 에러 핸들링, 캡처 실패 시에도 나머지 진행 |
| Excel 형식 다양성 | `import_excel_requirement_list`에서 이미 처리, 추가 형식 지원 가능 |
| 파이프라인 실행 시간 길음 | 비동기 실행 + 상태 폴링 지원 |

### Open Questions
- [ ] 파이프라인 실행 취소 기능 필요 여부
- [ ] 중간 결과 이메일/Slack 알림 필요 여부
- [ ] 멀티 고객 동시 파이프라인 실행 지원 여부

---

## ② 실장비 일상 점검 자동화

### Goal
EPP/IAG/CC 실장비의 정기 정책 상태를 자동 확인하고, 이상 감지 시 알림을 보내는 **일상 점검 자동화**.

### Current Context
- `sangfor.collect_product_config` — 현재 설정 수집 ✅
- `sangfor.capture_screenshots` — 메뉴별 캡처 ✅
- `sangfor.verify_product_change` — 변경 검증 ✅
- `@sangfor/chrome` — CDP 기반 브라우저 제어 ✅
- `@sangfor/operator` — 실장비 세션 관리 ✅

**문제**: 현재는 수동으로 호출해야 하며, 정기 점검이나 이상 감지 자동화가 없습니다.

### Proposed Approach
**정기 점검 크론** + **스냅샷 비교** + **이상 감지 알림** 파이프라인을 구축합니다.

### Step-by-Step Plan

#### Phase 1: 점검 스냅샷 수집기 구현 (1-2일)
```
파일: packages/sangfor-operator/src/health-checker.ts
```

1. **`HealthCheckConfig` 인터페이스 정의**
   ```typescript
   interface HealthCheckConfig {
     product: 'EPP' | 'IAG' | 'CC';
     targetUrl: string;
     credentials: { username: string; password: string };
     checkItems: HealthCheckItem[];
     outputDir: string;
     cdpPort?: number;
   }
   
   interface HealthCheckItem {
     id: string;
     name: string;                    // "정책 목록", "에이전트 상태" 등
     menuPath: string[];              // 메뉴 경로
     collectType: 'screenshot' | 'table' | 'form' | 'api';
     expectedFields?: string[];       // 기대되는 필드
     alertConditions?: AlertCondition[];
   }
   
   interface AlertCondition {
     field: string;
     operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than';
     value: string | number;
     severity: 'info' | 'warning' | 'critical';
   }
   ```

2. **`HealthCheckResult` 인터페이스 정의**
   ```typescript
   interface HealthCheckResult {
     checkId: string;
     product: string;
     targetUrl: string;
     checkedAt: string;
     items: HealthCheckItemResult[];
     alerts: HealthAlert[];
     summary: {
       total: number;
       passed: number;
       warnings: number;
       critical: number;
     };
   }
   
   interface HealthCheckItemResult {
     itemId: string;
     name: string;
     status: 'pass' | 'warning' | 'critical' | 'error';
     collectedData?: any;
     screenshotPath?: string;
     error?: string;
   }
   
   interface HealthAlert {
     itemId: string;
     itemName: string;
     condition: AlertCondition;
     actualValue: any;
     severity: 'info' | 'warning' | 'critical';
     message: string;
   }
   ```

3. **`runHealthCheck` 함수 구현**
   ```typescript
   export async function runHealthCheck(config: HealthCheckConfig): Promise<HealthCheckResult> {
     // 1. Chrome 세션 시작
     // 2. 로그인
     // 3. 각 checkItem에 대해:
     //    - 메뉴 탐색
     //    - 데이터 수집 (스크린샷/테이블/폼)
     //    - alertConditions 검사
     // 4. 결과 반환
   }
   ```

#### Phase 2: 스냅샷 비교기 구현 (1일)
```
파일: packages/sangfor-operator/src/snapshot-comparator.ts
```

4. **`SnapshotComparator` 클래스 구현**
   ```typescript
   class SnapshotComparator {
     // 이전 스냅샷과 현재 스napshot 비교
     compareSnapshots(previous: HealthCheckResult, current: HealthCheckResult): SnapshotDiff;
     
     // 변경 사항 감지
     detectChanges(previous: any, current: any, path?: string): Change[];
     
     // 이상 패턴 감지 (급격한 변화, 비정상 값 등)
     detectAnomalies(history: HealthCheckResult[]): Anomaly[];
   }
   ```

5. **`SnapshotDiff` 인터페이스 정의**
   ```typescript
   interface SnapshotDiff {
     comparedAt: string;
     previousCheckId: string;
     currentCheckId: string;
     changes: Change[];
     anomalies: Anomaly[];
     summary: {
       totalChanges: number;
       criticalChanges: number;
       newAlerts: number;
     };
   }
   
   interface Change {
     path: string;           // "policy.malware_protection.enabled"
     previousValue: any;
     currentValue: any;
     changeType: 'added' | 'removed' | 'modified';
     severity: 'info' | 'warning' | 'critical';
   }
   ```

#### Phase 3: 정기 점검 크론 구현 (즉시)
```
파일: packages/sangfor-operator/src/health-check-cron.ts
```

6. **`HealthCheckScheduler` 클래스 구현**
   ```typescript
   class HealthCheckScheduler {
     private configs: HealthCheckConfig[];
     private history: Map<string, HealthCheckResult[]>;
     
     // 정기 점검 실행
     async runScheduledChecks(): Promise<HealthCheckResult[]>;
     
     // 히스토리 관리 (최근 30일 보관)
     getHistory(product: string, days?: number): HealthCheckResult[];
     
     // 알림 전송
     sendAlerts(alerts: HealthAlert[]): Promise<void>;
   }
   ```

7. **알림 채널 연동**
   - Hermes `send_message` tool 활용 (Telegram, Discord 등)
   - 이메일 알림 (선택)
   - Slack/Discord 웹훅 (선택)

#### Phase 4: MCP Tool 등록 (즉시)
```
파일: apps/mcp-server/src/index.ts
```

8. **`sangfor.run_health_check` tool 추가**
   ```typescript
   'sangfor.run_health_check': {
     description: 'Run health check on Sangfor product console. Collects current state and checks for anomalies.',
     inputSchema: {
       type: 'object',
       properties: {
         product: { type: 'string', enum: ['EPP', 'IAG', 'CC'] },
         targetUrl: { type: 'string' },
         credentials: { type: 'object' },
         checkItems: { type: 'array' },
         outputDir: { type: 'string' }
       },
       required: ['product']
     },
     handler: runHealthCheck
   }
   ```

9. **`sangfor.get_health_history` tool 추가**
   - 최근 점검 이력 조회
   - 제품별/기간별 필터링

10. **`sangfor.compare_health_snapshots` tool 추가**
    - 두 점검 결과 비교
    - 변경 사항 및 이상 감지

#### Phase 5: 크론 등록 (즉시)
```
파일: .hermes/cron/health-check.yaml (또는 cronjob tool 활용)
```

11. **정기 점검 크론 등록**
    ```yaml
    name: sangfor-health-check
    schedule: "0 9 * * 1-5"  # 평일 매일 오전 9시
    prompt: |
      Run health checks on all configured Sangfor products:
      1. EPP (10.80.1.106) - 정책 상태, 에이전트 상태
      2. IAG (10.80.1.108) - URL 필터링, DLP 정책
      3. CC (10.80.1.107) - 센서 상태, 이벤트 수집
      
      Compare with previous check and alert on critical changes.
    skills: [sangfor-health-check]
    ```

12. **이상 감지 알림 크론**
    ```yaml
    name: sangfor-health-alerts
    schedule: "*/30 * * * *"  # 30분마다
    prompt: |
      Check for critical health alerts in the last 30 minutes.
      Send notification if any critical changes detected.
    ```

### Files Likely to Change
- `packages/sangfor-operator/src/health-checker.ts` (신규)
- `packages/sangfor-operator/src/snapshot-comparator.ts` (신규)
- `packages/sangfor-operator/src/health-check-cron.ts` (신규)
- `packages/sangfor-operator/src/index.ts` (export 추가)
- `apps/mcp-server/src/index.ts` (tool 등록)
- `tests/health-checker.test.ts` (신규)
- `tests/snapshot-comparator.test.ts` (신규)

### Tests / Validation
1. **단위 테스트**: `tests/health-checker.test.ts`
   - 각 checkItem 수집 테스트
   - alertConditions 검사 테스트
   - 에러 핸들링 테스트

2. **비교 테스트**: `tests/snapshot-comparator.test.ts`
   - 스냅샷 비교 정확성 테스트
   - 변경 감지 테스트
   - 이상 패턴 감지 테스트

3. **통합 테스트**: lab 환경에서 실제 점검 실행
   - `sangfor.run_health_check` 호출
   - 결과 확인 및 알림 테스트

### Risks & Tradeoffs
| 위험 | 완화 방안 |
|------|----------|
| 실장비 접근 불가 (네트워크, 다운타임) | 재시도 로직 + 알림 |
| 로그인 실패 (CAPTCHA, 비밀번호 변경) | CAPTCHA 자동 처리 + 관리자 알림 |
| 점검 실행 시간 김 (메뉴 많음) | 병렬 수집 + 타임아웃 설정 |
| 알림 남용 | severity 필터링 + 알림 억제 로직 |

### Open Questions
- [ ] 점검 항목 커스터마이징 UI 필요 여부
- [ ] 점검 결과 대시보드 필요 여부
- [ ] 외부 모니터링 시스템 (Zabbix, Grafana) 연동 여부

---

## ③ Obsidian ↔ MCP 연동 강화

### Goal
피드백 → 교훈 → Obsidian 위키 자동 반영 파이프라인을 구축하여, **지식이 자동으로 축적되는 시스템**을 만듭니다.

### Current Context
- `sangfor.submit_feedback` — 피드백 제출 ✅
- `sangfor.extract_lesson` — 교훈 추출 ✅
- `sangfor.propose_wiki_update` — 위키 업데이트 제안 ✅
- `sangfor.apply_obsidian_wiki_update` — Obsidian 반영 ✅
- `sangfor.apply_github_wiki_update` — GitHub Wiki 반영 ✅

**문제**: 각 단계를 수동으로 호출해야 하며, 피드백이 들어와도 자동으로 교훈이 추출되어 Obsidian에 반영되지 않습니다.

### Proposed Approach
**피드백 → 교훈 → 위키 제안 → Obsidian 반영** 파이프라인을 자동화하고, 크론으로 주기적 실행합니다.

### Step-by-Step Plan

#### Phase 1: 자동 파이프라인 구현 (1-2일)
```
파일: packages/sangfor-feedback/src/auto-pipeline.ts
```

1. **`AutoWikiPipelineConfig` 인터페이스 정의**
   ```typescript
   interface AutoWikiPipelineConfig {
     obsidianVaultPath: string;        // Obsidian vault 경로
     githubWikiRepo?: string;          // GitHub Wiki repo (선택)
     autoApprove: boolean;             // 자동 승인 여부
     notifyOnProposal: boolean;        // 제안 시 알림
     batchSize: number;                // 한 번에 처리할 피드백 수
     feedbackFilter?: {
       severity?: string[];
       product?: string[];
       dateRange?: { from: string; to: string };
     };
   }
   ```

2. **`AutoWikiPipelineResult` 인터페이스 정의**
   ```typescript
   interface AutoWikiPipelineResult {
     pipelineId: string;
     executedAt: string;
     feedbackProcessed: number;
     lessonsExtracted: number;
     proposalsCreated: number;
     proposalsApproved: number;
     wikiUpdatesApplied: number;
     errors: Array<{ feedbackId: string; error: string }>;
   }
   ```

3. **`runAutoWikiPipeline` 함수 구현**
   ```typescript
   export async function runAutoWikiPipeline(config: AutoWikiPipelineConfig): Promise<AutoWikiPipelineResult> {
     // 1. 미처리 피드백 조회 (DB 또는 in-memory)
     // 2. 각 피드백에 대해:
     //    - extract_lesson 호출
     //    - propose_wiki_update 호출
     //    - autoApprove가 true면 자동 승인
     //    - apply_obsidian_wiki_update 호출
     //    - githubWikiRepo가 있으면 apply_github_wiki_update 호출
     // 3. 결과 반환
   }
   ```

#### Phase 2: 피드백 수집기 강화 (선택, 1일)
```
파일: packages/sangfor-feedback/src/feedback-collector.ts
```

4. **`FeedbackCollector` 클래스 구현**
   ```typescript
   class FeedbackCollector {
     // 다양한 소스에서 피드백 수집
     collectFromMcpTools(): Feedback[];      // MCP tool 실행 결과에서
     collectFromConsole(): Feedback[];       // 콘솔 로그에서
     collectFromUserInput(): Feedback[];     // 사용자 직접 입력
     
     // 피드백 정규화
     normalizeFeedback(raw: any): Feedback;
     
     // 중복 제거
     deduplicateFeedbacks(feedbacks: Feedback[]): Feedback[];
   }
   ```

5. **피드백 소스 연동**
   - MCP tool 실행 결과에서 자동 피드백 추출
   - 실장비 점검 결과에서 이상 감지 시 피드백 생성
   - 사용자 직접 입력 (CLI, 웹 UI)

#### Phase 3: Obsidian 연동 강화 (1일)
```
파일: packages/sangfor-wiki/src/obsidian-sync.ts
```

6. **`ObsidianSync` 클래스 구현**
   ```typescript
   class ObsidianSync {
     private vaultPath: string;
     
     // 위키 업데이트 적용
     async applyUpdate(proposal: WikiUpdateProposal): Promise<ApplyResult>;
     
     // Obsidian 노트 파싱
     parseNote(filePath: string): ObsidianNote;
     
     // 노트 업데이트 (frontmatter, body)
     updateNote(filePath: string, updates: Partial<ObsidianNote>): Promise<void>;
     
     // 새 노트 생성
     createNote(title: string, content: string, tags?: string[]): Promise<string>;
     
     // 태그/링크 관리
     addTag(filePath: string, tag: string): Promise<void>;
     addLink(fromPath: string, toPath: string): Promise<void>;
   }
   
   interface ObsidianNote {
     title: string;
     frontmatter: Record<string, any>;
     body: string;
     tags: string[];
     links: string[];
     filePath: string;
   }
   ```

7. **Obsidian 템플릿 시스템**
   ```typescript
   // 교훈 노트 템플릿
   const LESSON_TEMPLATE = `---
   title: {{title}}
   product: {{product}}
   severity: {{severity}}
   created: {{date}}
   tags: [lesson, {{product}}]
   ---
   
   # {{title}}
   
   ## 배경
   {{background}}
   
   ## 교훈
   {{lesson}}
   
   ## 적용 방안
   {{application}}
   
   ## 관련 피드백
   {{feedbackLink}}
   `;
   ```

#### Phase 4: MCP Tool 등록 (즉시)
```
파일: apps/mcp-server/src/index.ts
```

8. **`sangfor.run_auto_wiki_pipeline` tool 추가**
   ```typescript
   'sangfor.run_auto_wiki_pipeline': {
     description: 'Run automatic wiki update pipeline: feedback → lesson → proposal → Obsidian/GitHub Wiki update.',
     inputSchema: {
       type: 'object',
       properties: {
         obsidianVaultPath: { type: 'string' },
         githubWikiRepo: { type: 'string' },
         autoApprove: { type: 'boolean', default: false },
         batchSize: { type: 'number', default: 10 }
       },
       required: ['obsidianVaultPath']
     },
     handler: runAutoWikiPipeline
   }
   ```

9. **`sangfor.sync_obsidian_notes` tool 추가**
   - Obsidian vault 전체 동기화
   - 태그/링크 정리

10. **`sangfor.get_wiki_proposals` tool 추가**
    - 미처리 위키 제안 조회
    - 승인/거절 처리

#### Phase 5: 크론 등록 (즉시)
```
파일: .hermes/cron/obsidian-sync.yaml (또는 cronjob tool 활용)
```

11. **일일 위키 동기화 크론**
    ```yaml
    name: sangfor-obsidian-sync
    schedule: "0 22 * * *"  # 매일 밤 10시
    prompt: |
      Run automatic wiki update pipeline:
      1. Collect unprocessed feedbacks
      2. Extract lessons
      3. Create wiki proposals
      4. Apply approved proposals to Obsidian vault
      
      Obsidian vault: ~/Documents/Obsidian Vault/
    skills: [sangfor-obsidian-sync]
    ```

12. **주간 위키 정리 크론**
    ```yaml
    name: sangfor-wiki-cleanup
    schedule: "0 10 * * 0"  # 매주 일요일 오전 10시
    prompt: |
      Weekly wiki maintenance:
      1. Clean up duplicate lessons
      2. Update broken links
      3. Regenerate tags index
      4. Sync to GitHub Wiki if configured
    ```

### Files Likely to Change
- `packages/sangfor-feedback/src/auto-pipeline.ts` (신규)
- `packages/sangfor-feedback/src/feedback-collector.ts` (신규)
- `packages/sangfor-wiki/src/obsidian-sync.ts` (신규)
- `packages/sangfor-feedback/src/index.ts` (export 추가)
- `packages/sangfor-wiki/src/index.ts` (export 추가)
- `apps/mcp-server/src/index.ts` (tool 등록)
- `tests/auto-pipeline.test.ts` (신규)
- `tests/obsidian-sync.test.ts` (신규)

### Tests / Validation
1. **단위 테스트**: `tests/auto-pipeline.test.ts`
   - 피드백 → 교훈 추출 정확성 테스트
   - 위키 제안 생성 테스트
   - Obsidian 반영 테스트

2. **동기화 테스트**: `tests/obsidian-sync.test.ts`
   - Obsidian 노트 파싱 테스트
   - 노트 업데이트 테스트
   - 태그/링크 관리 테스트

3. **통합 테스트**: 실제 Obsidian vault에서 파이프라인 실행
   - `sangfor.run_auto_wiki_pipeline` 호출
   - Obsidian에서 결과 확인

### Risks & Tradeoffs
| 위험 | 완화 방안 |
|------|----------|
| Obsidian vault 충돌 (동시 편집) | 파일 잠금 + 충돌 감지 |
| 잘못된 교훈 추출 | 수동 승인 옵션 + 검토 알림 |
| GitHub Wiki 동기화 실패 | 재시도 로직 + 에러 알림 |
| 피드백 품질 낮음 | 피드백 필터링 + 품질 검증 |

### Open Questions
- [ ] Obsidian 플러그인 연동 필요 여부
- [ ] 교훈 추출 AI 모델 선택 (로컬 vs 클라우드)
- [ ] 다중 사용자 위키 편집 충돌 해결 방안

---

## 📅 전체 일정 및 우선순위

### Phase 1: 기반 구축 (1-2주)
| 주차 | 작업 | 산출물 |
|------|------|--------|
| 1주차 | ① 파이프라인 Orchestrator 구현 | `project-pipeline.ts` |
| 1주차 | ② Health Checker 구현 | `health-checker.ts` |
| 2주차 | ③ Auto Wiki Pipeline 구현 | `auto-pipeline.ts` |
| 2주차 | 테스트 및 검증 | 테스트 코드 |

### Phase 2: MCP 등록 및 크론 (즉시)
| 작업 | 산출물 |
|------|--------|
| MCP tool 등록 | `apps/mcp-server/src/index.ts` |
| 크론 등록 | `.hermes/cron/*.yaml` |
| 알림 연동 | Telegram/Discord 알림 |

### Phase 3: UI 및 고도화 (선택, 2-3주)
| 작업 | 산출물 |
|------|--------|
| 웹 UI 파이프라인 화면 | `apps/operator-console/` |
| 대시보드 | 점검 결과 시각화 |
| 고급 필터링 | 제품별/기간별 분석 |

---

## 🔧 기술 스택 및 의존성

### 기존 의존성 활용
- `@sangfor/chrome` — CDP 기반 브라우저 제어
- `@sangfor/operator` — 실장비 세션 관리
- `@sangfor/shared` — 공통 타입 및 유틸리티
- `@sangfor/approval` — 승인 로직

### 새로운 의존성 (최소화)
- **없음** — 기존 패키지 내에서 구현

### 외부 서비스 연동
- **Obsidian** — 로컬 파일 시스템 (이미 연동됨)
- **GitHub Wiki** — git CLI (이미 연동됨)
- **Telegram/Discord** — Hermes `send_message` tool

---

## 📊 성공 지표

| 지표 | 현재 | 목표 |
|------|------|------|
| 프로젝트 파이프라인 실행 시간 | 수동 (2-3시간) | 자동 (10-15분) |
| 실장비 점검 주기 | 수동 (주 1회) | 자동 (매일) |
| 피드백 → 위키 반영 시간 | 수동 (1-2일) | 자동 (당일) |
| MCP tool 활용 빈도 | 낮음 | 높음 (일일 10+ 호출) |

---

## 🚀 다음 단계

1. **즉시 실행 가능**: Phase 1 구현 시작
2. **우선순위**: ① 프로젝트 올인원 → ② 실장비 점검 → ③ Obsidian 연동
3. **검증**: 각 Phase 완료 후 실장비에서 테스트

**이 계획서에 대한 피드백이나 수정 사항이 있으시면 말씀해 주세요!**
