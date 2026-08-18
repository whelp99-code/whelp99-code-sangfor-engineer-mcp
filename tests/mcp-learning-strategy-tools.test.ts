import { beforeAll, describe, expect, it } from 'vitest';

process.env.MCP_NO_SERVE = '1';

const EXPECTED = [
  'sangfor_list_learning_strategies',
  'sangfor_resolve_learning_strategy',
  'sangfor_attach_observation_session',
  'sangfor_manage_learning_capture',
  'sangfor_collect_facts',
  'sangfor_research_learning_strategy',
  'sangfor_validate_learning_strategy',
  'sangfor_promote_learning_strategy',
] as const;

let listTools: () => Array<{ name: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;

beforeAll(async () => {
  const module = await import('../apps/mcp-server/src/index.js');
  listTools = module.listTools as typeof listTools;
  getToolHandler = module.getToolHandler as typeof getToolHandler;
});

describe('PR-011 learning MCP surface', () => {
  // 총합은 "도구가 조용히 늘지 않는다"는 카나리다. 표면을 늘리는 변경은 이 수를
  // 함께 갱신해야 한다 (77 baseline + PR-011 학습 8 + 플레이북 프록시 9 + 디스커버리 2 = 96
  // + W4 차별화 3 [sangfor_session_report, sangfor_search_gaps, sangfor_safety_selftest] = 99
  // + W5 engagement 스코프 1 [sangfor_engagement_scope] = 100
  // + 콘솔 증적 캡처 2 [sangfor_console_capture_evidence, sangfor_verify_capture_ledger] = 102
  // + 감사 체크리스트 1급 데이터화 3 [sangfor_audit_frameworks, sangfor_audit_checklist, sangfor_audit_gap_report] = 105
  // + officecli 통합 2 [sangfor_validate_office_document, sangfor_build_evidence_package] = 107
  // + 루프-그래프 런타임 1 [sangfor_loop_status] = 108
  // + 지식 카드 계층 2 [sangfor_list_knowledge_cards, sangfor_upsert_knowledge_card] = 110
  // + Config Chronicle 읽기 2 [sangfor_chronicle_diff, sangfor_drift_findings] (issue #23) = 112
  // + 관측 플랫폼 읽기 3 [sangfor_snapshot_query, sangfor_report_chain_verify, sangfor_scorecard_tier] (issues #24-#27) = 115).
  it('adds exactly eight names on top of the 77-tool baseline', () => {
    const tools = listTools();
    expect(tools).toHaveLength(115);
    expect(tools.filter((tool) => EXPECTED.includes(tool.name as typeof EXPECTED[number])).map((tool) => tool.name).sort())
      .toEqual([...EXPECTED].sort());
  });

  it('marks list/resolve read-only and the other six as non-destructive local writes', () => {
    const byName = new Map(listTools().map((tool) => [tool.name, tool]));
    for (const [index, name] of EXPECTED.entries()) {
      const tool = byName.get(name)!;
      expect(tool.annotations.destructiveHint, name).toBe(false);
      expect(tool.annotations.readOnlyHint, name).toBe(index < 2);
      expect(tool.inputSchema.additionalProperties, name).toBe(false);
    }
  });

  it('rejects unknown and credential fields in handlers as well as schemas', async () => {
    expect(() => getToolHandler('sangfor_list_learning_strategies')!({ unexpected: true })).toThrow('UNKNOWN_FIELD');
    expect(() => getToolHandler('sangfor_resolve_learning_strategy')!({
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', password: 'forbidden' },
      context: { registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth' },
    })).toThrow('SECRET_FIELD_FORBIDDEN');
    expect(() => getToolHandler('sangfor_collect_facts')!({
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      context: { registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth', cookie: 'forbidden' },
      factIds: ['version'],
    })).toThrow('SECRET_FIELD_FORBIDDEN');
  });
});
