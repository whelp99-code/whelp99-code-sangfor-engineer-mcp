import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function resolveBindHost(): string {
  const raw = process.env.BIND_HOST?.trim();
  return raw ? raw : '127.0.0.1';
}

export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const mapped = h.startsWith('::ffff:') ? h.slice(7) : h;
  if (isIP(mapped) === 4) return mapped.split('.')[0] === '127';
  return false;
}

/** Constant-time Bearer-token check. Open when no token is configured. */
export function checkAuth(
  authHeader: string | undefined,
  token: string | undefined,
): { ok: boolean; status?: number } {
  if (!token) return { ok: true };
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const ok = timingSafeEqual(hash(authHeader ?? ''), hash(`Bearer ${token}`));
  return ok ? { ok: true } : { ok: false, status: 401 };
}

export function assertBindSafety(bindHost: string, token: string | undefined): void {
  if (!isLoopback(bindHost) && !token) {
    throw new Error(
      `Refusing to bind ${bindHost} (non-loopback) without SANGFOR_API_TOKEN — set a token or bind to 127.0.0.1`,
    );
  }
}
