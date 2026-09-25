import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SANITIZED_PATHS = [
  'docs/M4_HCI_API_SPIKE_RUNBOOK.md',
  'outputs/diagnosis/HCI_SCP_real_device_smoke_2026-07-02.md',
  'docs/SECURITY.md',
  'docs/references/engineer-workflow/e02-secret-cleanup-receipt.md',
] as const;

const SECRET_FINDING_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'password-assignment', re: /password\s*[:=]\s*\S+/i },
  { id: 'secret-assignment', re: /secret\s*[:=]\s*\S+/i },
  { id: 'token-assignment', re: /(?:api[_-]?key|authorization)\s*[:=]\s*\S+/i },
  { id: 'private-key', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { id: 'lab-credential-class', re: /Itac\d{2,}/ },
  { id: 'historical-host-copy', re: /10\.80\.1\.\d+/ },
  { id: 'credential-pair', re: /\badmin\s*\/\s*\S+/ },
];

function findingClasses(text: string): string[] {
  return SECRET_FINDING_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.id);
}

function reportFindings(relPath: string, text: string): string[] {
  return findingClasses(text).map((id) => `${relPath}:${id}`);
}

describe('E02 document secret cleanup', () => {
  it('reports finding classes only and never echoes matched text', () => {
    const planted = 'fixture-only-mock-value';
    const probe = ['password', planted].join(': ');
    const report = reportFindings('probe.md', probe);
    expect(report).toEqual(['probe.md:password-assignment']);
    expect(report.join('\n')).not.toContain(planted);
  });

  it('keeps sanitized documents free of secret classes without printing matches', () => {
    const report = SANITIZED_PATHS.flatMap((relPath) => {
      const text = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      return reportFindings(relPath, text);
    });
    expect(report).toEqual([]);
  });

  it('refuses to treat current-tree cleanup as a completed leak response', () => {
    const receipt = readFileSync(
      resolve(REPO_ROOT, 'docs/references/engineer-workflow/e02-secret-cleanup-receipt.md'),
      'utf8',
    );
    expect(receipt).toMatch(/^[-*]\s*credential_rotation: not_run$/m);
    expect(receipt).toMatch(/^[-*]\s*history_rewrite: not_run$/m);
    expect(receipt).toMatch(/^[-*]\s*leak_response_complete: no$/m);
    expect(receipt).toMatch(/Current-tree sanitization is not a complete leak response/);
    expect(receipt).not.toMatch(/유출 대응 완료/);
  });
});
