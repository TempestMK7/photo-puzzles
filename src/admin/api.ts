/** The admin routes of the API (server/src/adminweb.ts): a Cognito ID token in the header, JSON back. */

export type AdminFailure = { ok: false; error: string; status: number };
export type AdminOk<T> = { ok: true } & T;

export class AdminApi {
  constructor(
    private readonly base: string,
    /** The ID token of the signed-in account (made new when it is about to run out), or nothing. */
    private readonly token: () => Promise<string | null>,
  ) {}

  async get<T>(path: string, query: Record<string, string> = {}): Promise<AdminOk<T> | AdminFailure> {
    const q = new URLSearchParams(query).toString();
    return this.send<T>('GET', `${path}${q ? `?${q}` : ''}`);
  }

  async post<T = Record<string, never>>(path: string, body: Record<string, unknown> = {}): Promise<AdminOk<T> | AdminFailure> {
    return this.send<T>('POST', path, body);
  }

  private async send<T>(method: string, path: string, body?: Record<string, unknown>): Promise<AdminOk<T> | AdminFailure> {
    const token = await this.token();
    if (!token) return { ok: false, error: 'sign-in', status: 401 };
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && json.ok) return json as AdminOk<T>;
      // the gateway's own answer to a token it does not take has no JSON in it
      return { ok: false, error: json.error ?? (res.status === 401 ? 'sign-in' : res.status === 403 ? 'unauthorized' : 'failed'), status: res.status };
    } catch {
      return { ok: false, error: 'offline', status: 0 };
    }
  }
}

/** What to tell the administrator when a call did not work. */
export function sayAdminError(f: AdminFailure): string {
  switch (f.error) {
    case 'offline':
      return 'Could not reach the server.';
    case 'sign-in':
      return 'Please sign in again.';
    case 'unauthorized':
      return 'This account is not an administrator.';
    case 'not-found':
      return 'That is gone already (a puzzle ends by itself).';
    case 'group':
    case 'minutes':
    case 'filter':
    case 'days':
      return 'The server did not take that choice.';
    default:
      return 'That did not work. Please try again.';
  }
}
