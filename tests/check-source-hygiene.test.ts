import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 원래 게이트는 존재하지 않는 `src/` 때문에 grep이 exit 2를 반환해 위반이 있어도
// 통과했다. "게이트가 위반을 실제로 잡는다"를 고정하지 않으면 같은 무력화가 재발한다.
const SCRIPT = join(process.cwd(), 'scripts/check-source-hygiene.mjs');

let dir: string;

// spawnSync: 성공/실패 모두에서 stderr와 종료코드를 함께 얻는다
// (execFileSync는 성공 시 stdout만 돌려줘 진단 메시지를 놓친다).
function run(cwd: string): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

function seed(files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hygiene-'));
  // 두 스캔 루트가 모두 존재해야 정상 경로다.
  mkdirSync(join(dir, 'packages/x/src'), { recursive: true });
  mkdirSync(join(dir, 'apps/mcp-server/src'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('check-source-hygiene — 게이트가 실제로 잡는다', () => {
  it('위반이 없으면 exit 0', () => {
    seed({
      'packages/x/src/index.ts': 'export const a = 1;\nconsole.error("diag");\n',
      'apps/mcp-server/src/index.ts': 'process.stdout.write("{}\\n");\n',
    });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('ok');
  });

  it('packages/의 console.log를 잡는다 (stdout은 JSON-RPC 채널)', () => {
    seed({ 'packages/x/src/index.ts': 'console.log("oops");\n' });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('packages/x/src/index.ts:1');
    expect(r.stderr).toContain('stdout-reserved');
  });

  it('apps/mcp-server의 console.log를 잡는다', () => {
    seed({ 'apps/mcp-server/src/index.ts': 'const x=1;\nconsole.log(x);\n' });
    expect(run(dir).code).toBe(1);
  });

  it('독립 HTTP 서버 진입점의 console.log는 허용한다', () => {
    seed({ 'apps/control-tower/src/server.ts': 'console.log("listening on :3700");\n' });
    expect(run(dir).code).toBe(0);
  });

  it('TODO/FIXME 마커를 잡는다', () => {
    seed({ 'packages/x/src/index.ts': 'export const a = 1; // TODO: later\n' });
    const todo = run(dir);
    expect(todo.code).toBe(1);
    expect(todo.stderr).toContain('TODO');

    rmSync(join(dir, 'packages/x/src/index.ts'));
    seed({ 'packages/x/src/b.ts': '// FIXME broken\n' });
    expect(run(dir).stderr).toContain('FIXME');
  });

  it('추적된 Office 잠금 파일을 잡는다', () => {
    seed({ 'outputs/~$draft.docx': 'lock' });
    git(dir, 'add', '.');
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('tracked Office lock/temp artifact');
  });

  it('스캔 루트가 사라지면 조용히 통과하지 않고 exit 2로 실패한다', () => {
    rmSync(join(dir, 'packages'), { recursive: true, force: true });
    const r = run(dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('scan root missing');
  });
});
