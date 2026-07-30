// Control Tower(:3700) REST 표면을 MCP 도구에서 쓰기 위한 얇은 클라이언트.
// 플레이북 상태의 단일 기록자는 타워다 — MCP는 playbooks.json을 직접 쓰지 않는다
// (두 프로세스가 같은 JSON을 atomic-rename으로 덮으면 last-write-wins로 유실된다).

export interface TowerErrorResult {
  error: string;
  towerUrl: string;
  hint?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class TowerClient {
  constructor(
    private readonly baseUrl: string = process.env.SANGFOR_TOWER_URL ?? 'http://127.0.0.1:3700',
    private readonly token: string | undefined = process.env.SANGFOR_API_TOKEN,
  ) {}

  get url(): string { return this.baseUrl; }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  // 실패를 예외가 아니라 값으로 반환한다 (MCP 도구 핸들러의 기존 관례: { error } 반환).
  async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        error: `control tower unreachable: ${error instanceof Error ? error.message : String(error)}`,
        towerUrl: this.baseUrl,
        hint: 'pnpm dev:control-tower 로 타워를 띄우거나 SANGFOR_TOWER_URL을 확인하세요.',
      } satisfies TowerErrorResult;
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text.trim()) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!res.ok) {
      const detail = (parsed as { error?: string } | null)?.error ?? (typeof parsed === 'string' ? parsed : `HTTP ${res.status}`);
      return {
        error: `control tower ${method} ${path} → HTTP ${res.status}: ${String(detail).slice(0, 300)}`,
        towerUrl: this.baseUrl,
        ...(res.status === 401 || res.status === 403
          ? { hint: 'SANGFOR_API_TOKEN이 타워와 동일한지 확인하세요.' }
          : {}),
      } satisfies TowerErrorResult;
    }
    return parsed;
  }
}
