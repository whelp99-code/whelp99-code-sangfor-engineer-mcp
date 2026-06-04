/**
 * Sangfor ONE (Partner Portal) session helpers.
 * https://one.sangfor.com — unified entry for KB, community SSO, and portal APIs.
 */

export interface OneSessionConfig {
  oneBaseUrl?: string;
  kbBaseUrl?: string;
  accessToken?: string;
  kbToken?: string;
  oauthCode?: string;
}

export interface ResolvedTokens {
  oneAccessToken?: string;
  kbToken?: string;
  sources: string[];
}

const DEFAULT_ONE_BASE = 'https://one.sangfor.com';
const DEFAULT_KB_BASE = 'https://knowledgebase.sangfor.com';

export async function fetchOneJson<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; oneBaseUrl?: string }
): Promise<T> {
  const base = (options.oneBaseUrl ?? DEFAULT_ONE_BASE).replace(/\/$/, '');
  const url = path.startsWith('http') ? path : `${base}/api${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json'
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ONE API ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchKbJson<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; token: string; kbBaseUrl?: string }
): Promise<T> {
  const base = (options.kbBaseUrl ?? DEFAULT_KB_BASE).replace(/\/$/, '');
  const apiPath = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
  const url = path.startsWith('http') ? path : `${base}${apiPath}`;
  const res = await fetch(url, {
    method: options.method ?? 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=UTF-8',
      authorization: `Bearer ${options.token}`
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : '{}'
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KB API ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** Exchange OAuth `code` from one.sangfor.com redirect for partner access token. */
export async function exchangeOneOAuthCode(
  code: string,
  oneBaseUrl = DEFAULT_ONE_BASE
): Promise<{ accessToken: string; refreshToken?: string }> {
  const data = await fetchOneJson<{ data?: { token?: string; refreshToken?: string }; token?: string }>(
    '/api-auth/oauth/getUserAndTokenByCode',
    { method: 'POST', body: { code }, oneBaseUrl }
  );
  const payload = (data as { data?: { token?: string; refreshToken?: string } }).data ?? data;
  const accessToken = (payload as { token?: string }).token;
  if (!accessToken) throw new Error('ONE OAuth exchange did not return token');
  return {
    accessToken,
    refreshToken: (payload as { refreshToken?: string }).refreshToken
  };
}

/** Try to obtain knowledgebase library_token using ONE partner session. */
export async function resolveKbTokenFromOne(
  oneAccessToken: string,
  kbBaseUrl = DEFAULT_KB_BASE
): Promise<string | undefined> {
  const attempts: Array<{ path: string; body: Record<string, unknown> }> = [
    { path: '/api-auth/kbOauth/partnerUser/kbTokenJump', body: {} },
    { path: '/api-auth/kbOauth/getTokenByPartnerIDT', body: {} }
  ];
  for (const attempt of attempts) {
    try {
      const data = await fetchKbJson<{ data?: { token?: string; kbToken?: string; library_token?: string } }>(
        attempt.path,
        { body: attempt.body, token: oneAccessToken, kbBaseUrl }
      );
      const row = data.data ?? data;
      const token = (row as { token?: string }).token
        ?? (row as { kbToken?: string }).kbToken
        ?? (row as { library_token?: string }).library_token;
      if (token) return token;
    } catch {
      // try next endpoint shape
    }
  }
  return undefined;
}

export function loadOneSessionFromEnv(): OneSessionConfig {
  return {
    oneBaseUrl: process.env.SANGFOR_ONE_BASE_URL ?? DEFAULT_ONE_BASE,
    kbBaseUrl: process.env.SANGFOR_KB_BASE_URL ?? DEFAULT_KB_BASE,
    accessToken: process.env.SANGFOR_ONE_ACCESS_TOKEN?.trim()
      || process.env.SANGFOR_ACCESS_TOKEN_MH?.trim(),
    kbToken: process.env.SANGFOR_KB_TOKEN?.trim()
      || process.env.SANGFOR_LIBRARY_TOKEN?.trim(),
    oauthCode: process.env.SANGFOR_OAUTH_CODE?.trim()
  };
}

export async function resolveAuthTokens(config: OneSessionConfig = loadOneSessionFromEnv()): Promise<ResolvedTokens> {
  const sources: string[] = [];
  let oneAccessToken = config.accessToken;
  let kbToken = config.kbToken;

  if (!oneAccessToken && config.oauthCode) {
    const exchanged = await exchangeOneOAuthCode(config.oauthCode, config.oneBaseUrl);
    oneAccessToken = exchanged.accessToken;
    sources.push('one_oauth_code');
  } else if (oneAccessToken) {
    sources.push('one_access_token_env');
  }

  if (!kbToken && oneAccessToken) {
    const jumped = await resolveKbTokenFromOne(oneAccessToken, config.kbBaseUrl);
    if (jumped) {
      kbToken = jumped;
      sources.push('kb_token_from_one');
    }
  } else if (kbToken) {
    sources.push('kb_token_env');
  }

  return { oneAccessToken, kbToken, sources };
}

export async function verifyOneSession(accessToken: string, oneBaseUrl?: string): Promise<{ ok: boolean; user?: unknown }> {
  try {
    const data = await fetchOneJson<{ data?: { user?: unknown } }>(
      '/api-user/sys/ppuser/info',
      { token: accessToken, oneBaseUrl }
    );
    return { ok: true, user: data.data?.user ?? data };
  } catch {
    return { ok: false };
  }
}
