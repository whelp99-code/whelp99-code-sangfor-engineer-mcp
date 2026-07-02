import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

// Zero-dependency JSON HTTP helper (no undici/axios). TLS verification is only
// skipped when explicitly opted in (lab consoles use self-signed certs).

export interface HttpJsonResult { status: number; json: unknown; text: string; }

export function httpJson(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; tlsSkipVerify?: boolean; timeoutMs?: number } = {},
): Promise<HttpJsonResult> {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...opts.headers,
        },
        ...(isHttps && opts.tlsSkipVerify ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 15_000, () => req.destroy(new Error(`HTTP timeout: ${opts.method ?? 'GET'} ${url}`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
