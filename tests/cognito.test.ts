import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CognitoAccount, type CognitoEnv } from '../src/online/cognito';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token as the game sees it: the signature is not looked at here (the API and the broker do that). */
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', kid: 'k' })}.${b64(claims)}.sig`;

const HOST = 'https://pool.auth.example.com';
const REDIRECT = 'https://dev.example/';

function setup(opts: { local?: Storage | null; reply?: (url: string, body: URLSearchParams) => Response | Promise<Response> } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const calls: { url: string; body: URLSearchParams }[] = [];
  const went: string[] = [];
  const env: CognitoEnv = {
    fetch: (async (url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      calls.push({ url, body });
      return opts.reply ? opts.reply(url, body) : new Response('{}', { status: 400 });
    }) as never,
    now: () => clock.t,
    go: (url) => void went.push(url),
    redirect: () => REDIRECT,
  };
  const local = opts.local === undefined ? new MemoryStorage() : opts.local;
  const session = new MemoryStorage();
  const account = new CognitoAccount({ host: HOST, clientId: 'client1' }, local, session, env);
  return { account, clock, calls, went, local, session };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const exp = (clock: { t: number }, secondsLeft: number) => clock.t / 1000 + secondsLeft;

describe('signing in', () => {
  it('goes to the sign-in page with the code flow and a PKCE challenge, and keeps the secret half for coming back', async () => {
    const t = setup();
    await t.account.signIn('#/join/12345~abc');
    const url = new URL(t.went[0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${HOST}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'client1', redirect_uri: REDIRECT, scope: 'openid email profile', code_challenge_method: 'S256' });
    const flow = JSON.parse(t.session.getItem('photo-puzzles/online/auth-flow')!);
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(flow.verifier).digest('base64url'));
    expect(url.searchParams.get('state')).toBe(flow.state);
    expect(flow.hash).toBe('#/join/12345~abc');
    expect(flow.verifier.length).toBeGreaterThanOrEqual(43);                       // what PKCE asks for
    expect(JSON.stringify(url)).not.toContain(flow.verifier);
  });

  it('swaps the code for the tokens when the sign-in page sends the player back, and says what the player was doing', async () => {
    const id = jwt({ sub: 'user-1', name: 'Ann', exp: 1_700_003_600 });
    const t = setup({ reply: () => json({ id_token: id, refresh_token: 'refresh-1', access_token: 'a' }) });
    await t.account.signIn('#/join/12345~abc');
    const flow = JSON.parse(t.session.getItem('photo-puzzles/online/auth-flow')!);
    const out = await t.account.completeSignIn(`${REDIRECT}?code=the-code&state=${flow.state}`);
    expect(out).toEqual({ handled: true, ok: true, hash: '#/join/12345~abc' });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe(`${HOST}/oauth2/token`);
    expect(Object.fromEntries(t.calls[0].body)).toEqual({ grant_type: 'authorization_code', client_id: 'client1', code: 'the-code', redirect_uri: REDIRECT, code_verifier: flow.verifier });
    expect(t.account.who()).toEqual({ id: 'user-1', name: 'Ann' });
    expect(t.session.getItem('photo-puzzles/online/auth-flow')).toBeNull();      // used once
  });

  it('does not take a code that this tab did not ask for, or the same code twice', async () => {
    const t = setup({ reply: () => json({ id_token: jwt({ sub: 'x' }), refresh_token: 'r' }) });
    expect(await t.account.completeSignIn(`${REDIRECT}?code=c&state=s`)).toEqual({ handled: true, ok: false, hash: '' });     // no sign-in was started here
    await t.account.signIn();
    expect(await t.account.completeSignIn(`${REDIRECT}?code=c&state=another`)).toMatchObject({ handled: true, ok: false });   // not the state that was sent
    expect(t.calls).toHaveLength(0);
    expect(t.account.who()).toBeNull();
  });

  it('leaves an ordinary address alone, and says "not signed in" when the player turned back from the sign-in page', async () => {
    const t = setup();
    expect(await t.account.completeSignIn(`${REDIRECT}#/join/12345~abc`)).toEqual({ handled: false, ok: false, hash: '' });
    await t.account.signIn('#/x');
    expect(await t.account.completeSignIn(`${REDIRECT}?error=access_denied`)).toEqual({ handled: true, ok: false, hash: '#/x' });
  });

  it('is not signed in when the sign-in service refuses the code', async () => {
    const t = setup({ reply: () => json({ error: 'invalid_grant' }, 400) });
    await t.account.signIn();
    const state = new URL(t.went[0]).searchParams.get('state');
    expect((await t.account.completeSignIn(`${REDIRECT}?code=c&state=${state}`)).ok).toBe(false);
    expect(t.account.who()).toBeNull();
  });
});

describe('who the player is', () => {
  const withClaims = async (claims: Record<string, unknown>) => {
    const t = setup({ reply: (_u, b) => json({ id_token: jwt({ exp: 1_700_003_600, ...claims }), refresh_token: 'r' }, b ? 200 : 200) });
    await t.account.signIn();
    await t.account.completeSignIn(`${REDIRECT}?code=c&state=${new URL(t.went[0]).searchParams.get('state')}`);
    return t.account.who();
  };
  it('is the name the account has, or else the start of the e-mail address, or else "Player"', async () => {
    expect(await withClaims({ sub: 'u1', name: 'Ann Lee', email: 'x@example.com' })).toEqual({ id: 'u1', name: 'Ann Lee' });
    expect(await withClaims({ sub: 'u1', email: 'ann.lee@example.com' })).toEqual({ id: 'u1', name: 'ann.lee' });
    expect(await withClaims({ sub: 'u1' })).toEqual({ id: 'u1', name: 'Player' });
    expect((await withClaims({ sub: 'u1', name: 'A'.repeat(40) }))!.name).toHaveLength(24);
  });
  it('is nobody before signing in', () => {
    expect(setup().account.who()).toBeNull();
  });
});

describe('the token', () => {
  /** An account that has signed in with a token that has `secondsLeft` seconds left, and what the sign-in service says to a refresh. */
  async function account(secondsLeft: number, refresh: () => Response | Promise<Response>) {
    let first = true;
    const clockHolder: { t: { t: number } | null } = { t: null };
    const t = setup({
      reply: (_u, body) => {
        if (body.get('grant_type') === 'authorization_code' && first) {
          first = false;
          return json({ id_token: jwt({ sub: 'user-1', exp: exp(clockHolder.t!, secondsLeft) }), refresh_token: 'refresh-1' });
        }
        return refresh();
      },
    });
    clockHolder.t = t.clock;
    await t.account.signIn();
    await t.account.completeSignIn(`${REDIRECT}?code=c&state=${new URL(t.went[0]).searchParams.get('state')}`);
    t.calls.length = 0;
    return t;
  }

  it('is given as it is while it has more than a minute left', async () => {
    const t = await account(3600, () => json({}, 500));
    expect(await t.account.token()).toContain('.');
    expect(t.calls).toHaveLength(0);
  });

  it('is made new when it is about to run out, once for all who ask together', async () => {
    const fresh = jwt({ sub: 'user-1', exp: 1_700_100_000 });
    const t = await account(30, () => json({ id_token: fresh, access_token: 'a' }));
    const got = await Promise.all([t.account.token(), t.account.token(), t.account.token()]);
    expect(got).toEqual([fresh, fresh, fresh]);
    expect(t.calls).toHaveLength(1);
    expect(Object.fromEntries(t.calls[0].body)).toEqual({ grant_type: 'refresh_token', client_id: 'client1', refresh_token: 'refresh-1' });
    expect(await t.account.token()).toBe(fresh);                                    // and kept
    expect(t.calls).toHaveLength(1);
  });

  it('signs the player out when the sign-in service says the refresh token is no good', async () => {
    const t = await account(30, () => json({ error: 'invalid_grant' }, 400));
    expect(await t.account.token()).toBeNull();
    expect(t.account.who()).toBeNull();
    expect(await t.account.token()).toBeNull();
  });

  it('keeps the player signed in through a bad moment: the old token goes on, and nothing is thrown away', async () => {
    const t = await account(30, () => json({}, 500));
    expect(await t.account.token()).toContain('.');
    expect(t.account.who()).not.toBeNull();
    const down = await account(30, () => Promise.reject(new TypeError('network')));
    expect(await down.account.token()).toContain('.');
    expect(down.account.who()).not.toBeNull();
  });

  it('is nothing before signing in', async () => {
    expect(await setup().account.token()).toBeNull();
  });
});

describe('signing out', () => {
  it('forgets the tokens and ends the sign-in service\'s own session too', async () => {
    const t = await (async () => {
      const s = setup({ reply: () => json({ id_token: jwt({ sub: 'u', exp: 1_700_003_600 }), refresh_token: 'r' }) });
      await s.account.signIn();
      await s.account.completeSignIn(`${REDIRECT}?code=c&state=${new URL(s.went[0]).searchParams.get('state')}`);
      return s;
    })();
    expect(t.account.who()).not.toBeNull();
    t.account.signOut();
    expect(t.account.who()).toBeNull();
    expect(t.local!.getItem('photo-puzzles/online/auth')).toBeNull();
    const url = new URL(t.went[t.went.length - 1]);
    expect(`${url.origin}${url.pathname}`).toBe(`${HOST}/logout`);
    expect(url.searchParams.get('logout_uri')).toBe(REDIRECT);
  });
});

describe('where the tokens are kept', () => {
  it('keeps them in memory when the browser will not store anything', async () => {
    const t = setup({ local: null, reply: () => json({ id_token: jwt({ sub: 'u', exp: 1_700_003_600 }), refresh_token: 'r' }) });
    await t.account.signIn();
    await t.account.completeSignIn(`${REDIRECT}?code=c&state=${new URL(t.went[0]).searchParams.get('state')}`);
    expect(t.account.who()).toEqual({ id: 'u', name: 'Player' });
  });
  it('is signed in again on a new page load', async () => {
    const t = setup({ reply: () => json({ id_token: jwt({ sub: 'u', exp: 1_700_003_600 }), refresh_token: 'r' }) });
    await t.account.signIn();
    await t.account.completeSignIn(`${REDIRECT}?code=c&state=${new URL(t.went[0]).searchParams.get('state')}`);
    const again = new CognitoAccount({ host: HOST, clientId: 'client1' }, t.local, new MemoryStorage());
    expect(again.who()).toEqual({ id: 'u', name: 'Player' });
  });
});
