/**
 * MCP 서버에 피드백 제출 → 교훈 추출 → wiki 업데이트 제안
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MCP_CMD = 'npx';
const MCP_ARGS = ['tsx', 'apps/mcp-server/src/index.ts'];

let id = 0;
function nextId() { return ++id; }

function sendRequest(proc: any, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const reqId = nextId();
    const msg = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params });
    proc.stdin.write(msg + '\n');
    
    const rl = createInterface({ input: proc.stdout });
    const handler = (line: string) => {
      try {
        const resp = JSON.parse(line);
        if (resp.id === reqId) {
          rl.removeListener('line', handler);
          if (resp.error) reject(new Error(resp.error.message));
          else resolve(resp.result);
        }
      } catch {}
    };
    rl.on('line', handler);
    setTimeout(() => { rl.removeListener('line', handler); reject(new Error('timeout')); }, 30000);
  });
}

async function main() {
  console.log('MCP 서버 시작...');
  const proc = spawn(MCP_CMD, MCP_ARGS, { 
    cwd: '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }
  });

  // Initialize
  await sendRequest(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'feedback-client', version: '1.0' }
  });
  console.log('MCP 초기화 완료');

  // 1단계: 피드백 제출
  console.log('\n=== 1단계: 피드백 제출 ===');
  const feedback = await sendRequest(proc, 'tools/call', {
    name: 'sangfor.submit_feedback',
    arguments: {
      product: 'ENDPOINT_SECURE',
      feedbackType: 'menu_mapping_correction',
      severity: 'high',
      feedbackText: `실장비(EPP 6.0.4ENR4) 검증 결과, 감사 항목별 메뉴 매핑이 잘못되었습니다.

수정 내용:
1. 감사 #4,5,6 (Anti-Virus): 기존 "Policy > Malware/Ransomware Protection" → "Defense > Malware Scan" (Anti-Malware 정책)
2. 감사 #8,9 (Software Control): 기존 "Policy > Malware/Ransomware Protection" → "Policies > App Control" (어플리케이션 제어)
3. 감사 #10,11 (Device Control): 기존 "Policy > Malware/Ransomware Protection" → "Policies > General Policies > Endpoint Control > USB Device Control" (USB/저장매체 제어)
4. 감사 #7,9,11 (로그): "Detection and Response > Security Events"에서 확인

⚠️ Behavior Control ≠ Device Control. Behavior Control은 Watermark 기능입니다.

EPP 실제 사이드바 구조:
- Dashboard (Home)
- Detection and Response > Security Events, Targeted Endpoints, Threat Hunting, Response
- Risk Assessment > Windows Update, Vulnerabilities, Compliance Check
- Defense > Malware Scan
- Endpoints > Endpoint Groups, Endpoint Inventory, Endpoint Discovery, Integrity Monitoring
- Policies > General Policies, Detection Policies, Exclusions, Behavior Control, App Control
- System > Agent Deployment, System Updates, Integrated Devices, Branches, Administrators, Licensing, Logs, Data Sync, System, Troubleshooting`,
      sourceRole: 'engineer'
    }
  });
  console.log('피드백 제출:', JSON.stringify(feedback, null, 2));

  // 2단계: 교훈 추출
  console.log('\n=== 2단계: 교훈 추출 ===');
  const feedbackId = feedback?.id || feedback?.feedbackId || feedback?.persistedId;
  if (feedbackId) {
    const lesson = await sendRequest(proc, 'tools/call', {
      name: 'sangfor.extract_lesson',
      arguments: { feedbackId: String(feedbackId) }
    });
    console.log('교훈 추출:', JSON.stringify(lesson, null, 2));

    // 3단계: wiki 업데이트 제안
    console.log('\n=== 3단계: wiki 업데이트 제안 ===');
    const proposal = await sendRequest(proc, 'tools/call', {
      name: 'sangfor.propose_wiki_update',
      arguments: {
        lessonTitle: 'EPP 실장비 메뉴 매핑 검증 결과 (2026-06-09)',
        lessonBody: `## EPP (Athena EPP 6.0.4ENR4) 실장비 검증 메뉴 구조

### 감사 항목별 올바른 메뉴 경로

| 감사 # | 감사 항목 | 올바른 EPP 메뉴 |
|--------|----------|----------------|
| #3 | Anti-Virus (에이전트 설치) | Dashboard (Home) |
| #4 | Anti-Virus (엔진 업데이트) | Defense > Malware Scan |
| #5 | Anti-Virus (주기적 검사) | Defense > Malware Scan |
| #6 | Anti-Virus (비활성화 방지) | Defense > Malware Scan |
| #7 | Anti-Virus (탐지 로그) | Detection and Response > Security Events |
| #8 | Software Control (SW 통제) | Policies > App Control |
| #9 | Software Control (로그) | Detection and Response > Security Events |
| #10 | Device Control (저장매체) | Policies > General Policies > Endpoint Control > USB Device Control |
| #11 | Device Control (로그) | Detection and Response > Security Events |
| #29 | System Management | System > Agent Deployment |

### ⚠️ 주의사항
- Behavior Control ≠ Device Control. Behavior Control은 Watermark 기능.
- Device Control 위치: Policies > General Policies > Endpoint Control > USB Device Control (3단계)
- goto()로 메뉴 이동 시 세션 끊김 → 반드시 메뉴 클릭 방식 사용

### EPP 전체 사이드바 구조
\`\`\`
Dashboard (Home)
Detection and Response > Security Events, Targeted Endpoints, Threat Hunting, Response
Risk Assessment > Windows Update, Vulnerabilities, Compliance Check
Defense > Malware Scan
Endpoints > Endpoint Groups, Endpoint Inventory, Endpoint Discovery, Integrity Monitoring
Policies > General Policies, Detection Policies, Exclusions, Behavior Control, App Control
System > Agent Deployment, System Updates, Integrated Devices, Branches, Administrators, Licensing, Logs, Data Sync, System, Troubleshooting
\`\`\``,
        targetPage: 'sangfor-product-adapters/epp-menu-mapping'
      }
    });
    console.log('제안:', JSON.stringify(proposal, null, 2));

    // 4단계: 제안 승인
    const proposalId = proposal?.id || proposal?.proposalId;
    if (proposalId) {
      console.log('\n=== 4단계: 제안 승인 ===');
      const approve = await sendRequest(proc, 'tools/call', {
        name: 'sangfor.approve_wiki_update',
        arguments: { proposalId: String(proposalId), decision: 'approve' }
      });
      console.log('승인:', JSON.stringify(approve, null, 2));

      // 5단계: wiki 업데이트 적용
      console.log('\n=== 5단계: wiki 업데이트 적용 ===');
      const apply = await sendRequest(proc, 'tools/call', {
        name: 'sangfor.apply_wiki_update',
        arguments: { proposalId: String(proposalId) }
      });
      console.log('적용:', JSON.stringify(apply, null, 2));
    }
  }

  proc.kill();
  console.log('\n=== 완료 ===');
}

main().catch(e => { console.error(e.message); process.exit(1); });
