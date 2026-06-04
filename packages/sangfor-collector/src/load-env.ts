import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load KEY=VALUE pairs from a .env file into process.env (does not override existing vars). */
export function loadEnvFile(path = '.env', cwd = process.cwd()): boolean {
  const full = resolve(cwd, path);
  if (!existsSync(full)) return false;

  const text = readFileSync(full, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const existing = process.env[key];
    if (existing === undefined || existing === '') process.env[key] = value;
  }
  return true;
}

/** Parse SANGFOR_* collection limits. `all` or <=0 means no cap. */
export function parseCollectionLimit(raw: string | undefined, defaultLimit: number): number | undefined {
  if (raw === undefined || raw === '') return defaultLimit;
  const lower = raw.trim().toLowerCase();
  if (lower === 'all' || lower === 'unlimited' || lower === 'none') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultLimit;
  if (n <= 0) return undefined;
  return Math.floor(n);
}
