#!/usr/bin/env node
// Source hygiene gate for CI.
//
// Replaces two inline `grep` gates in .github/workflows/pr-validation.yml that never
// actually failed: they were invoked as `grep -r ... src/ packages/ apps/` from the repo
// root, where `src/` does not exist. GNU grep exits 2 when a path errors — even if
// matches were found — and `if grep ...; then` treats 2 as false, so every violation
// passed silently.
//
// Rules enforced here:
//  1. No `console.log` in `packages/` or `apps/mcp-server/`. stdout is the MCP stdio
//     JSON-RPC channel; anything written there corrupts the protocol. Diagnostics belong
//     on stderr. Standalone HTTP servers (`apps/*/src/server.ts`) may log to stdout.
//  2. No `TODO`/`FIXME` markers in shipped source under `packages/` or `apps/`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_ROOTS = ['packages', 'apps'];

// stdout is reserved for the JSON-RPC stream in anything the stdio server can load.
const STDOUT_RESERVED = (rel) => rel.startsWith(`packages${sep}`) || rel.startsWith(`apps${sep}mcp-server${sep}`);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 없는 루트는 조용히 건너뛰지 않는다 — 호출부에서 존재를 검증한다
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

const violations = [];

for (const root of SCAN_ROOTS) {
  const abs = join(ROOT, root);
  // 스캔 대상이 사라지면 게이트가 조용히 무력화된다 — 그것이 원래의 버그였다.
  try {
    if (!statSync(abs).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`check-source-hygiene: scan root missing: ${root} (게이트가 무력화됨)`);
    process.exit(2);
  }

  for (const file of walk(abs)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      if (STDOUT_RESERVED(rel) && /console\.log\s*\(/.test(line)) {
        violations.push(`${at}  console.log in a stdout-reserved module — use console.error / process.stderr.write`);
      }
      if (/\b(TODO|FIXME)\b/.test(line)) {
        violations.push(`${at}  ${/\bTODO\b/.test(line) ? 'TODO' : 'FIXME'} marker in shipped source`);
      }
    });
  }
}

if (violations.length) {
  console.error(`check-source-hygiene: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.error('check-source-hygiene: ok');
