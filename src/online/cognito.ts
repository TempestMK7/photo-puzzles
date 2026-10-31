import { ADMIN_GROUP } from './adminProtocol';
import type { Account, AuthError, AuthResult, PasswordAccount } from './identity';

/** Where the sign-in pages of the user pool are (`https://<prefix>.auth.<region>.amazoncognito.com`) and which app client the game is. */
export interface CognitoConfig {
  host: string;
  clientId: string;
  /** The user pool has Google as a way to sign in (the app client lists it): the pages may offer it. */
  google?: boolean;
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
  /** Signed in through the sign-in service's own page (so that page has a session of its own to end when signing out). */
  hosted?: true;
}

/** What the user pool's own errors (`__type`) come to, for the sign-in and sign-up pages. */
const AUTH_ERRORS: Record<string, AuthError> = {
  NotAuthorizedException: 'wrong',
  UserNotFoundException: 'wrong',
  UserNotConfirmedException: 'unconfirmed',
  PasswordResetRequiredException: 'reset',
  UsernameExistsException: 'exists',
  InvalidPasswordException: 'password',
  InvalidParameterException: 'invalid',
  CodeMismatchException: 'code',
  ExpiredCodeException: 'expired',
  TooManyRequestsException: 'limit',
  LimitExceededException: 'limit',
  TooManyFailedAttemptsException: 'limit',
};

/** The user pool's region, from the address of its sign-in pages (`https://<prefix>.auth.<region>.amazoncognito.com`). */
const regionOf = (host: string): string => /\.auth\.([a-z0-9-]+)\.amazoncognito\.com/.exec(host)?.[1] ?? 'us-east-1';

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function claimsOf(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Whether the token's `cognito:groups` has the administrators' group (a list, or a string like "[admins]"). Only for what the page shows: the server looks at the token itself. */
export function inAdminGroup(groups: unknown): boolean {
  const list = Array.isArray(groups) ? groups : typeof groups === 'string' ? groups.split(/[\s,[\]]+/) : [];
  return list.includes(ADMIN_GROUP);
}

/** The address of the profile picture that the sign-in service knows (Google's, for a Google sign-in): a secure address, or nothing. */
export function pictureOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
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
  /** The e-mail and password pages: the user pool is asked directly (a public app client has no secret to keep). */
  readonly passwords: PasswordAccount = {
    signInWithPassword: (email, password) => this.signInWithPassword(email, password),
    signUp: (email, password, name) => this.signUp(email, password, name),
    confirmSignUp: (email, code) => this.simple('ConfirmSignUp', { Username: email.trim(), ConfirmationCode: code.trim() }),
    resendCode: (email) => this.simple('ResendConfirmationCode', { Username: email.trim() }),
    forgotPassword: (email) => this.simple('ForgotPassword', { Username: email.trim() }),
    resetPassword: (email, code, password) => this.simple('ConfirmForgotPassword', { Username: email.trim(), ConfirmationCode: code.trim(), Password: password }),
  };

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

  who(): { id: string; name: string; email?: string; picture?: string; admin?: true } | null {
    const tokens = this.read();
    const claims = tokens && claimsOf(tokens.id);
    if (!claims || typeof claims.sub !== 'string') return null;
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    return { id: claims.sub, name: (text(claims.name) || text(claims.email).split('@')[0] || 'Player').slice(0, 24), email: text(claims.email) || undefined, picture: pictureOf(claims.picture), ...(inAdminGroup(claims['cognito:groups']) ? { admin: true as const } : {}) };
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
      this.write({ ...tokens, id: body.id_token });
      return body.id_token;
    } catch {
      // no network: the old token goes on, and whoever uses it finds out that it has run out; the player is not signed out for a bad moment
      return tokens.id;
    }
  }

  /** Whether this account can sign in with Google (`signInWithGoogle`). */
  get hasGoogle(): boolean {
    return !!this.config.google;
  }

  /** Goes straight to Google's own page (the sign-in service's page that lists the ways to sign in is skipped), and comes back like `signIn`. */
  signInWithGoogle(returnHash = ''): Promise<void> {
    return this.signIn(returnHash, 'Google');
  }

  /** Goes to the sign-in page. `returnHash` (an invite link, say) comes back with the player. */
  async signIn(returnHash = '', provider = ''): Promise<void> {
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
      ...(provider ? { identity_provider: provider } : {}),
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
      this.write({ id: body.id_token, refresh: body.refresh_token, hosted: true });
      return { handled: true, ok: true, hash };
    } catch {
      return { handled: true, ok: false, hash };
    }
  }

  /** True if this takes the page away (a player who came through the sign-in service's page has a session there, which is ended; the page comes back). */
  signOut(): boolean {
    const tokens = this.read();
    this.write(null);
    if (tokens) void this.call('RevokeToken', { Token: tokens.refresh, ClientId: this.config.clientId });        // so that the refresh token cannot be used again; nothing depends on it working
    if (!tokens?.hosted) return false;
    this.env.go(`${this.config.host}/logout?${new URLSearchParams({ client_id: this.config.clientId, logout_uri: this.env.redirect() })}`);
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------- the e-mail and password pages

  /** One request to the user pool's own interface (not the sign-in pages). `code` is the pool's name for what went wrong; nothing when it could not be reached. */
  private async call(target: string, body: Record<string, unknown>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; code: string }> {
    try {
      const res = await this.env.fetch(`https://cognito-idp.${regionOf(this.config.host)}.amazonaws.com/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return { ok: true, body: json };
      return { ok: false, code: String(json.__type ?? '').split('#').pop() ?? '' };
    } catch {
      return { ok: false, code: 'offline' };
    }
  }

  private fail(code: string): AuthResult {
    return { ok: false, error: code === 'offline' ? 'offline' : (AUTH_ERRORS[code] ?? 'failed') };
  }

  /** A step with nothing to keep from the answer: confirming an address, sending a code, choosing a new password. */
  private async simple(target: string, body: Record<string, unknown>): Promise<AuthResult> {
    const res = await this.call(target, { ClientId: this.config.clientId, ...body });
    return res.ok ? { ok: true } : this.fail(res.code);
  }

  private async signInWithPassword(email: string, password: string): Promise<AuthResult> {
    const res = await this.call('InitiateAuth', { ClientId: this.config.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email.trim(), PASSWORD: password } });
    if (!res.ok) return this.fail(res.code);
    const out = res.body.AuthenticationResult as { IdToken?: string; RefreshToken?: string } | undefined;
    // anything else is a challenge (a second step) that this pool is not set up to ask for
    if (!out?.IdToken || !out.RefreshToken) return { ok: false, error: 'failed' };
    this.write({ id: out.IdToken, refresh: out.RefreshToken });
    return { ok: true };
  }

  private async signUp(email: string, password: string, name: string): Promise<AuthResult> {
    const attributes = [{ Name: 'email', Value: email.trim() }, ...(name.trim() ? [{ Name: 'name', Value: name.trim() }] : [])];
    const res = await this.call('SignUp', { ClientId: this.config.clientId, Username: email.trim(), Password: password, UserAttributes: attributes });
    if (!res.ok) return this.fail(res.code);
    return { ok: true, needsCode: res.body.UserConfirmed !== true };
  }
}
