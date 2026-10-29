import type { Account } from './identity';

/** Where the sign-in pages of the user pool are (`https://<prefix>.auth.<region>.amazoncognito.com`) and which app client the game is. */
export interface CognitoConfig {
  host: string;
  clientId: string;
}

/** What the world gives the account, so that a test can put fakes in its place. */
export interface CognitoEnv {
  fetch: typeof fetch;
  now(): number;
  /** Goes to another page (the sign-in page, and back). */
  go(url: string): void;
  /** Where the sign-in page sends the player back to: it has to be one of the addresses the app client lists. */
  redirect(): string;
}

const browserEnv = (): CognitoEnv => ({
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  go: (url) => window.location.assign(url),
  redirect: () => `${window.location.origin}/`,
});

const KEY = 'photo-puzzles/online/auth';
const FLOW_KEY = 'photo-puzzles/online/auth-flow';
/** A token that has less than this left is made new before it is used. */
const SPARE_MS = 60_000;

interface Tokens {
  /** The ID token: it says who the player is, and is what the API and the broker want. */
  id: string;
  refresh: string;
}

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function claimsOf(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const expiresAt = (token: string): number => (Number(claimsOf(token)?.exp) || 0) * 1000;

/**
 * The player's account: Cognito's sign-in page (the OAuth code flow with PKCE: the game has no secret to keep), and the tokens it gives. The ID token is kept on this device with the
 * refresh token, and made new when it is about to run out, so that a player stays signed in for a month without being asked again.
 */
export class CognitoAccount implements Account {
  private memory: Tokens | null = null;
  private refreshing: Promise<string | null> | null = null;

  constructor(
    private readonly config: CognitoConfig,
    private readonly local: Storage | null,
    private readonly session: Storage | null,
    private readonly env: CognitoEnv = browserEnv(),
  ) {}

  private read(): Tokens | null {
    try {
      const raw = this.local?.getItem(KEY);
      if (raw) return JSON.parse(raw) as Tokens;
    } catch {
      /* unreadable: as if nothing were kept */
    }
    return this.memory;
  }

  private write(tokens: Tokens | null): void {
    this.memory = tokens;
    try {
      if (tokens) this.local?.setItem(KEY, JSON.stringify(tokens));
      else this.local?.removeItem(KEY);
    } catch {
      /* the memory copy lasts until the page is closed */
    }
  }

  who(): { id: string; name: string } | null {
    const tokens = this.read();
    const claims = tokens && claimsOf(tokens.id);
    if (!claims || typeof claims.sub !== 'string') return null;
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    return { id: claims.sub, name: (text(claims.name) || text(claims.email).split('@')[0] || 'Player').slice(0, 24) };
  }

  token(): Promise<string | null> {
    const tokens = this.read();
    if (!tokens) return Promise.resolve(null);
    if (expiresAt(tokens.id) - this.env.now() > SPARE_MS) return Promise.resolve(tokens.id);
    // a few things ask at once (the API, the broker): one trip to the sign-in service is enough for all
    this.refreshing ??= this.refresh(tokens).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(tokens: Tokens): Promise<string | null> {
    try {
      const res = await this.env.fetch(`${this.config.host}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.config.clientId, refresh_token: tokens.refresh }),
      });
      if (res.status === 400 || res.status === 401) {
        this.write(null);                                                        // the refresh token was ended or has run out: this player has to sign in again
        return null;
      }
      const body = (await res.json()) as { id_token?: string };
      if (!res.ok || !body.id_token) return tokens.id;
      this.write({ id: body.id_token, refresh: tokens.refresh });
      return body.id_token;
    } catch {
      // no network: the old token goes on, and whoever uses it finds out that it has run out; the player is not signed out for a bad moment
      return tokens.id;
    }
  }

  /** Goes to the sign-in page. `returnHash` (an invite link, say) comes back with the player. */
  async signIn(returnHash = ''): Promise<void> {
    const rand = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
    const verifier = rand(48);
    const state = rand(16);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    try {
      this.session?.setItem(FLOW_KEY, JSON.stringify({ verifier, state, hash: returnHash }));
    } catch {
      /* then signing in cannot be completed: the player is told when they come back */
    }
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.env.redirect(),
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    this.env.go(`${this.config.host}/oauth2/authorize?${query}`);
  }

  /**
   * Called with the address the page was opened at. If it is the sign-in page sending the player back (`?code=...&state=...`), swaps the code for the tokens. `handled` says
   * whether it was; `ok` whether the player is signed in now; `hash` is what `signIn` was given.
   */
  async completeSignIn(href: string): Promise<{ handled: boolean; ok: boolean; hash: string }> {
    const url = new URL(href);
    const code = url.searchParams.get('code');
    if (!code && !url.searchParams.get('error')) return { handled: false, ok: false, hash: '' };
    let flow: { verifier?: string; state?: string; hash?: string } | null = null;
    try {
      flow = JSON.parse(this.session?.getItem(FLOW_KEY) ?? 'null');
      this.session?.removeItem(FLOW_KEY);
    } catch {
      /* no flow to go with it */
    }
    const hash = flow?.hash ?? '';
    // an address with a code that this tab did not ask for is not trusted (it may be somebody else's code)
    if (!code || !flow?.verifier || !flow.state || flow.state !== url.searchParams.get('state')) return { handled: true, ok: false, hash };
    try {
      const res = await this.env.fetch(`${this.config.host}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.config.clientId, code, redirect_uri: this.env.redirect(), code_verifier: flow.verifier }),
      });
      const body = (await res.json()) as { id_token?: string; refresh_token?: string };
      if (!res.ok || !body.id_token || !body.refresh_token) return { handled: true, ok: false, hash };
      this.write({ id: body.id_token, refresh: body.refresh_token });
      return { handled: true, ok: true, hash };
    } catch {
      return { handled: true, ok: false, hash };
    }
  }

  signOut(): void {
    this.write(null);
    // the sign-in service has its own session in the browser: ending it as well means the next "Sign in" asks again
    this.env.go(`${this.config.host}/logout?${new URLSearchParams({ client_id: this.config.clientId, logout_uri: this.env.redirect() })}`);
  }
}
