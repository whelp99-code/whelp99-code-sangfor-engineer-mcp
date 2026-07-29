import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const strategy = readFileSync(join(root, 'scripts/strategy-cli.ts'), 'utf8');
const observe = readFileSync(join(root, 'scripts/observe-cli.ts'), 'utf8');

describe('PR-011 CLI registration', () => {
  it('registers the two root scripts against real TypeScript entrypoints', () => {
    expect(packageJson.scripts.strategy).toBe('tsx scripts/strategy-cli.ts');
    expect(packageJson.scripts.observe).toBe('tsx scripts/observe-cli.ts');
    expect(strategy).toContain('export async function runStrategyCli');
    expect(observe).toContain('export async function runObserveCli');
  });

  it('keeps the required strategy and observer command surfaces registered', () => {
    for (const command of ['list', 'resolve', 'research', 'validate', 'approval-payload', 'approval-sign', 'promote', 'audit', 'mirror-sync']) {
      expect(strategy).toContain(`command === '${command}'`);
    }
    for (const command of ['capture', 'collect', 'purge']) expect(observe).toContain(`command === '${command}'`);
  });

  it('locks the security-critical approval and purge contracts', () => {
    expect(strategy).toContain("only(args, ['payload', 'out'])");
    expect(strategy).not.toContain("'secret'");
    expect(strategy).toContain("flag: 'wx'");
    expect(strategy).toContain('chmodSync(output, 0o600)');
    expect(observe).toContain("only(args, ['execute', 'before'])");
    expect(observe).toContain('dryRun: !execute');
    expect(observe).toContain('CAPTURE_PURGE_REFUSED');
    expect(strategy).toContain("argv[0] === '--' ? argv.slice(1)");
    expect(observe).toContain("argv[0] === '--' ? argv.slice(1)");
  });
});
