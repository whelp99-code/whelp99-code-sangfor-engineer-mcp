import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorizeToolCall } from '../apps/http-bridge/src/tool-guard.js';
import { mintApproval } from '../apps/control-tower/src/approval-mint.js';

// docs/SECURITY.md가 "destructive는 HTTP에서 항상 거부된다"고 단정해 코드·테스트와
// 어긋난 적이 있다. 그 문장이 사용자 가이드로 전파돼 잘못된 안전 주장이 됐다.
// 문서가 다시 그 상태로 돌아가지 않도록, 실제 동작과 문서 서술을 함께 고정한다.
const SECURITY_MD = readFileSync(join(process.cwd(), 'docs/SECURITY.md'), 'utf8');

const SECRET = 'doc-accuracy-secret';
const TOOL_LIST = { tools: [
  { name: 'destructive', annotations: { readOnlyHint: false, destructiveHint: true } },
] };

describe('docs/SECURITY.md — 브리지 게이트 서술이 실제 동작과 일치한다', () => {
  it('승인 없는 destructive는 모든 토글과 무관하게 거부된다', async () => {
    const d = (await authorizeToolCall({
      name: 'destructive', toolListResult: TOOL_LIST, enforceWhitelist: false,
    }));
    expect(d.allow).toBe(false);
    expect(d.status).toBe(403);
  });

  it('유효한 bridge.tool-call 승인이 붙은 destructive는 그 1회에 한해 허용된다', async () => {
    const approval = mintApproval({
      secret: SECRET, actionType: 'bridge.tool-call', actionTarget: 'destructive',
      approvedBy: 'jmpark', changeTicketId: 'tkt-1', rollbackPlanId: 'rb-1',
    });
    const d = (await authorizeToolCall({
      name: 'destructive', toolListResult: TOOL_LIST, enforceWhitelist: true,
      approval, approvalSecret: SECRET,
    }));
    expect(d.allow).toBe(true);
  });

  it('문서가 "always refused"로 단정하지 않고 승인 경로를 함께 서술한다', async () => {
    const gateSection = SECURITY_MD.split('## The second, independent gate')[1] ?? '';
    expect(gateSection, 'bridge gate 섹션을 찾지 못했다').toBeTruthy();
    expect(gateSection).not.toMatch(/destructiveHint` tools → \*\*always refused\*\*/);
    expect(gateSection).toMatch(/without an approval/i);
    expect(gateSection).toMatch(/bridge\.tool-call/);
  });
});
