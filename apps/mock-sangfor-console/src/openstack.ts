import type { IncomingMessage, ServerResponse } from 'node:http';

// In-memory OpenStack fixture faithful to the official HCI OpenAPI guide
// (keystone v2.0 passwordCredentials, cinder volumes, X-Client-Token idempotency,
// and the documented "202 but nothing changed" quota trap).

const MOCK_USER = 'admin';
const MOCK_PASSWORD = 'mock-password';
const MOCK_TENANT = 'lab';
const MOCK_TENANT_ID = 'mocktenant0001';

interface MockVolume {
  id: string; name: string; status: string; size: number;
  description: string | null; reads: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function createOpenStackMock(port = 3400) {
  const tokens = new Map<string, { expiresAt: number }>();
  const volumes = new Map<string, MockVolume>();
  const clientTokenLedger = new Map<string, { status: number; body: unknown }>();
  let tokenSeq = 0; let volSeq = 0;
  let volumeCreates = 0;

  const volumeView = (v: MockVolume) => ({
    id: v.id, name: v.name, status: v.status, size: v.size, description: v.description,
    attachments: [], bootable: 'false', encrypted: false, multiattach: false,
    availability_zone: 'mock-az', volume_type: null, snapshot_id: null, source_volid: null,
  });

  function authed(req: IncomingMessage): boolean {
    const t = String(req.headers['x-auth-token'] ?? '');
    const rec = tokens.get(t);
    return Boolean(rec && rec.expiresAt > Date.now());
  }

  function stepVolume(v: MockVolume): MockVolume {
    v.reads += 1;
    if (v.status === 'creating' && v.reads >= 2) v.status = 'available';
    if (v.status === 'deleting' && v.reads >= 2) volumes.delete(v.id);
    return v;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = (req.url ?? '/').split('?')[0];
    if (!url.startsWith('/openstack/')) return false;

    if (req.method === 'POST' && url === '/openstack/__mock/expire-tokens') {
      tokens.clear(); json(res, 200, { ok: true }); return true;
    }

    if (req.method === 'POST' && url === '/openstack/identity/v2.0/tokens') {
      const body = await readBody(req);
      const cred = body?.auth?.passwordCredentials;
      if (body?.auth?.tenantName !== MOCK_TENANT || cred?.username !== MOCK_USER || cred?.password !== MOCK_PASSWORD) {
        json(res, 401, { error: { code: 401, title: 'Unauthorized', message: 'invalid credentials' } });
        return true;
      }
      const id = `mock-token-${String(++tokenSeq).padStart(4, '0')}`;
      tokens.set(id, { expiresAt: Date.now() + 60 * 60_000 });
      // Build the serviceCatalog from the address the client actually reached us on
      // (like a real OpenStack), so clients can trust the catalog URLs verbatim.
      const base = `http://${req.headers.host ?? `127.0.0.1:${port}`}`;
      json(res, 200, {
        access: {
          token: {
            issued_at: new Date().toISOString(), expires: new Date(Date.now() + 3_600_000).toISOString(),
            id, tenant: { enabled: true, description: '', name: MOCK_TENANT, id: MOCK_TENANT_ID },
          },
          serviceCatalog: [
            { endpoints: [{ publicURL: `${base}/openstack/identity/v2.0` }], type: 'identity', name: 'keystone' },
            { endpoints: [{ publicURL: `${base}/openstack/volume/v2/${MOCK_TENANT_ID}` }], type: 'volume', name: 'cinder' },
            { endpoints: [{ publicURL: `${base}/openstack/compute/v2` }], type: 'compute', name: 'nova' },
            { endpoints: [{ publicURL: `${base}/openstack/image` }], type: 'image', name: 'glance' },
          ],
          user: { username: MOCK_USER, roles: [{ name: 'tenant' }], name: MOCK_USER },
        },
      });
      return true;
    }

    if (!authed(req)) { json(res, 401, { error: { code: 401, title: 'Unauthorized', message: 'token missing/expired' } }); return true; }

    const volRoot = `/openstack/volume/v2/${MOCK_TENANT_ID}/volumes`;

    if (req.method === 'GET' && (url === volRoot || url === `${volRoot}/detail`)) {
      json(res, 200, { volumes: [...volumes.values()].map(volumeView) });
      return true;
    }

    if (req.method === 'GET' && url.startsWith(`${volRoot}/`)) {
      const id = url.slice(volRoot.length + 1);
      const v = volumes.get(id);
      if (!v) { json(res, 404, { itemNotFound: { code: 404, message: `Volume ${id} could not be found.` } }); return true; }
      json(res, 200, { volume: volumeView(stepVolume(v)) });
      return true;
    }

    if (req.method === 'POST' && url === volRoot) {
      const clientToken = String(req.headers['x-client-token'] ?? '');
      if (clientToken && clientTokenLedger.has(clientToken)) {
        const prior = clientTokenLedger.get(clientToken)!;
        json(res, prior.status, prior.body);
        return true;
      }
      const body = await readBody(req);
      const input = body?.volume ?? {};
      if (req.headers['x-mock-scenario'] === 'quota-silent-noop') {
        // Faithful to the documented trap: 202 returned, nothing actually created.
        json(res, 202, { volume: { ...input, id: 'ghost-never-created', status: 'creating' } });
        return true;
      }
      volumeCreates += 1;
      const v: MockVolume = {
        id: `vol-${String(++volSeq).padStart(4, '0')}`,
        name: String(input.name ?? ''), size: Number(input.size ?? 0),
        description: input.description != null ? String(input.description) : null,
        status: 'creating', reads: 0,
      };
      volumes.set(v.id, v);
      const responseBody = { volume: volumeView(v) };
      if (clientToken) clientTokenLedger.set(clientToken, { status: 202, body: responseBody });
      json(res, 202, responseBody);
      return true;
    }

    if (req.method === 'DELETE' && url.startsWith(`${volRoot}/`)) {
      const id = url.slice(volRoot.length + 1);
      const v = volumes.get(id);
      if (!v) { json(res, 404, { itemNotFound: { code: 404, message: `Volume ${id} could not be found.` } }); return true; }
      v.status = 'deleting'; v.reads = 0;
      res.writeHead(202); res.end();
      return true;
    }

    json(res, 404, { error: { code: 404, message: `no mock route: ${req.method} ${url}` } });
    return true;
  }

  return { handle, stats: () => ({ tokensIssued: tokenSeq, volumeCreates }) };
}
