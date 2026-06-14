/**
 * MCP 학습 파이프라인 — 실장비 검증 결과를 MCP DB에 반영
 * submit_feedback → extract_lesson → propose_wiki_update → approve → apply
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn('npx', ['tsx', 'apps/mcp-server/src/index.ts'], {
  cwd: '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }
});

// 하나의 readline 인스턴스로 모든 응답 처리
const rl = createInterface({ input: proc.stdout });
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

rl.on('line', (line: string) => {
  try {
    const resp = JSON.parse(line);
    if (resp.id && pending.has(resp.id)) {
      const { resolve, reject } = pending.get(resp.id)!;
      pending.delete(resp.id);
      if (resp.error) reject(new Error(resp.error.message));
      else resolve(resp.result);
    }
  } catch {}
});

proc.stderr.on('data', (d: Buffer) => {
  const msg = d.toString().trim();
  if (msg) console.log(`  [stderr] ${msg}`);
});

let id = 0;
function call(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const reqId = ++id;
    pending.set(reqId, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30000);
  });
}

function extractId(result: any): string | null {
  return result?.structuredContent?.id || result?.id || result?.feedbackId || result?.proposalId || null;
}

async function main() {
  const start = Date.now();
  console.log('MCP 서버 시작...');

  // Initialize
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pipeline-client', version: '1.0' }
  });
  console.log(`✅ 초기화 (${Date.now() - start}ms)\n`);

  // ── 1단계: 피드백 제출 ──
  console.log('━━━ 1단계: 피드백 제출 ━━━');
  const fb = await call('tools/call', {
    name: 'sangfor.submit_feedback',
    arguments: {
      product: 'ENDPOINT_SECURE',
      feedbackType: 'menu_mapping_correction',
      severity: 'high',
      feedbackText: `실장비(EPP 6.0.4ENR4) 검증 결과, 감사 항목별 메뉴 매핑이 잘못되었습니다.

수정 내용:
1. 감사 #4,5,6 (Anti-Virus): "Policy > Malware/Ransomware Protection" → "Defense > Malware Scan"
2. 감사 #8,9 (Software Control): "Policy > Malware/Ransomware Protection" → "Policies > App Control"
3. 감사 #10,11 (Device Control): "Policy > Malware/Ransomware Protection" → "Policies > General Policies > Endpoint Control > USB Device Control"
4. 감사 #7,9,11 (로그): "Detection and Response > Security Events"

⚠️ Behavior Control ≠ Device Control. Behavior Control은 Watermark 기능.

EPP 실제 사이드바 구조:
- Dashboard (Home)
- Detection and Response > Security Events, Targeted Endpoints, Threat Hunting, Response
- Risk Assessment > Windows Update, Vulnerabilities, Compliance Check
- Defense > Malware Scan
- Endpoints > Endpoint Groups, Endpoint Inventory, Endpoint Discovery, Integrity Monitoring
- Policies > General Policies, Detection Policies, Exclusions, Behavior Control, App Control
- System > Agent Deployment, System Updates, Integrated Devices, Branches, Administrators, Licensing, Logs, Data Sync`,
      sourceRole: 'engineer'
    }
  });
  const fbId = extractId(fb);
  console.log(`✅ 피드백 제출: ${fbId}`);
  console.log(`   상태: ${fb?.structuredContent?.status || fb?.status}\n`);

  // ── 2단계: 교훈 추출 ──
  console.log('━━━ 2단계: 교훈 추출 ━━━');
  const lesson = await call('tools/call', {
    name: 'sangfor.extract_lesson',
    arguments: { feedbackId: fbId! }
  });
  const lessonId = extractId(lesson);
  console.log(`✅ 교훈 추출: ${lessonId || '(none)'}`);
  if (lesson?.structuredContent) {
    console.log(`   제목: ${lesson.structuredContent.title || lesson.structuredContent.lessonTitle || '-'}`);
  }
  console.log();

  // ── 3단계: wiki 업데이트 제안 ──
  console.log('━━━ 3단계: wiki 업데이트 제안 ━━━');
  const proposal = await call('tools/call', {
    name: 'sangfor.propose_wiki_update',
    arguments: {
      lessonTitle: 'EPP 실장비 메뉴 매핑 검증 결과 (2026-06-09)',
      lessonBody: `## EPP (Athena EPP 6.0.4ENR4) 실장비 검증

### 감사 항목별 올바른 메뉴 경로

| 감사 # | 감사 항목 | 올바른 EPP 메뉴 |
|--------|----------|----------------|
| 3 | Anti-Virus (에이전트 설치) | Dashboard (Home) |
| 4 | Anti-Virus (엔진 업데이트) | Defense > Malware Scan |
| 5 | Anti-Virus (주기적 검사) | Defense > Malware Scan |
| 6 | Anti-Virus (비활성화 방지) | Defense > Malware Scan |
| 7 | Anti-Virus (탐지 로그) | Detection and Response > Security Events |
| 8 | Software Control (SW 통제) | Policies > App Control |
| 9 | Software Control (로그) | Detection and Response > Security Events |
| 10 | Device Control (저장매체) | Policies > General Policies > Endpoint Control > USB Device Control |
| 11 | Device Control (로그) | Detection and Response > Security Events |
| 29 | System Management | System > Agent Deployment |

### ⚠️ 주의사항
- Behavior Control ≠ Device Control (Behavior Control은 Watermark)
- Device Control은 3단계 메뉴: Policies > General Policies > Endpoint Control > USB Device Control

### EPP 사이드바 구조
- Dashboard (Home)
- Detection and Response > Security Events, Targeted Endpoints, Threat Hunting, Response
- Risk Assessment > Windows Update, Vulnerabilities, Compliance Check
- Defense > Malware Scan
- Endpoints > Endpoint Groups, Endpoint Inventory, Endpoint Discovery, Integrity Monitoring
- Policies > General Policies, Detection Policies, Exclusions, Behavior Control, App Control
- System > Agent Deployment, System Updates, Integrated Devices, Branches, Administrators, Licensing, Logs, Data Sync`,
      targetPage: 'sangfor-product-adapters/epp-menu-mapping'
    }
  });
  const proposalId = extractId(proposal);
  console.log(`✅ 제안 생성: ${proposalId}`);
  console.log();

  // ── 4단계: 제안 승인 ──
  console.log('━━━ 4단계: 제안 승인 ━━━');
  const approve = await call('tools/call', {
    name: 'sangfor.approve_wiki_update',
    arguments: { proposalId: proposalId!, decision: 'approve' }
  });
  console.log(`✅ 승인: ${approve?.structuredContent?.status || approve?.status || 'approved'}`);
  console.log();

  // ── 5단계: wiki 업데이트 적용 ──
  console.log('━━━ 5단계: wiki 업데이트 적용 ━━━');
  const apply = await call('tools/call', {
    name: 'sangfor.apply_wiki_update',
    arguments: { proposalId: proposalId! }
  });
  console.log(`✅ 적용: ${apply?.structuredContent?.status || apply?.status || 'applied'}`);
  if (apply?.structuredContent?.targetPage) {
    console.log(`   대상 페이지: ${apply.structuredContent.targetPage}`);
  }
  console.log();

  const elapsed = Date.now() - start;
  console.log(`━━━ 완료 (총 ${elapsed}ms) ━━━`);
  proc.kill();
  process.exit(0);
}

main().catch(e => { console.error('에러:', e.message); proc.kill(); process.exit(1); });
