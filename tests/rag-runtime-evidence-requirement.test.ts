import { afterEach, describe, expect, it, vi } from 'vitest';
import { requiresLiveRuntimeEvidence } from '../packages/sangfor-rag/src/query-evidence-requirement.js';
import { ragSearch, ragSearchSync, getRagSearchDiagnostics } from '../packages/sangfor-rag/src/rag-search.js';
afterEach(() => vi.unstubAllEnvs());
describe('public documentation versus customer-instance evidence', () => {
  it.each([
    'What are the current private keys configured on our customer NGFW device?',
    'Identify the real-world identities of attackers detected by our device today.',
    '우리 고객 클러스터에 지금 로그인 중인 관리자의 실명과 접속 IP를 알려줘.',
    'Which firmware is installed on my appliance?',
    'Show our active sessions; how can I configure session limits?',
    'How many administrators are logged into our cluster now?',
    'Show our active sessions and how can I configure session limits?',
  ])('requires live evidence for a direct instance fact: %s', query => {
    expect(requiresLiveRuntimeEvidence(query)).toBe(true);
  });
  it.each([
    'How can I check the currently logged-in users on our HCI cluster?',
    'Where can I find the currently configured IP address on my appliance?',
    '우리 장비에서 현재 접속자를 확인하는 방법을 알려줘.',
    'How do I rotate private keys on our NGFW device?',
    'What does the active sessions table display?',
    'Which current versions support this documented feature?',
    'How does HA restart a virtual machine after a host failure?',
    'What happens if our currently active host fails?',
    '우리 장비에서 현재 접속자가 로그아웃하면 세션은 어떻게 되나요?',
  ])('preserves procedural and general documentation requests: %s', query => {
    expect(requiresLiveRuntimeEvidence(query)).toBe(false);
  });
  it('returns explicit evidence requirements before reading an unrelated public index', async () => {
    vi.stubEnv('SANGFOR_LOCAL_RERANK_ENABLED', '0');
    const input = { query: 'What are the actual current IP addresses of our customer cluster?', indexPath: '/missing-public-manual-index.json' };
    for (const result of [ragSearchSync(input), await ragSearch(input)]) {
      expect(result).toEqual([]);
      expect(getRagSearchDiagnostics(result)).toMatchObject({ degraded: false, evidenceRequirement: 'live-runtime' });
    }
  });
  it('does not conceal an invalid score configuration behind valid abstention', async () => {
    vi.stubEnv('SANGFOR_LOCAL_RERANK_MIN_SCORE', 'not-a-number');
    await expect(ragSearch({ query: 'What are our currently configured private keys?' })).rejects.toThrow('RAG_LOCAL_RERANK_MIN_SCORE_INVALID');
  });
});
