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
    // 비공허성: 실제 벤더 데이터가 매핑되어야 관측 항목이 생긴다 (수정 전엔 0 — HTML fallback)
    expect(result.evaluations[0].coverage.observedTotal).toBeGreaterThan(0);
    expect(result.evaluations[1].coverage.observedTotal).toBeGreaterThan(0);
  });

  it('advisor_cisco_iosxe: RESTCONF interfaces 경로 서빙 → evaluation 산출', async () => {
    const result: any = await getToolHandler('sangfor.advisor_cisco_iosxe')!({ host: base, username: 'mock', password: 'mock' });
    expect(result.error).toBeUndefined();
    expect(result.evaluation).toBeDefined();
    expect(result.evaluation.coverage.observedTotal).toBeGreaterThan(0);
  });

  it('advisor_cisco_iosxe_advanced: 7개 RESTCONF 경로 전부 서빙 → evaluations 2개', async () => {
    const result: any = await getToolHandler('sangfor.advisor_cisco_iosxe_advanced')!({ host: base, username: 'mock', password: 'mock' });
    expect(result.error).toBeUndefined();
    expect(result.evaluations).toHaveLength(2);
    // 비공허성: 실제 벤더 데이터가 매핑되어야 관측 항목이 생긴다 (수정 전엔 0 — HTML fallback)
    expect(result.evaluations[0].coverage.observedTotal).toBeGreaterThan(0);
    expect(result.evaluations[1].coverage.observedTotal).toBeGreaterThan(0);
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
