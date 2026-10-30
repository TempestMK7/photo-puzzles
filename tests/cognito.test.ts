import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CognitoAccount, pictureOf, type CognitoEnv } from '../src/online/cognito';

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

  it('goes straight to Google when asked, with the same code flow, and not otherwise', async () => {
    const t = setup();
    await t.account.signIn();
    expect(new URL(t.went[0]).searchParams.has('identity_provider')).toBe(false);
    await t.account.signInWithGoogle('#/x');
    const url = new URL(t.went[1]);
    expect(`${url.origin}${url.pathname}`).toBe(`${HOST}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ identity_provider: 'Google', response_type: 'code', code_challenge_method: 'S256', redirect_uri: REDIRECT });
    expect(JSON.parse(t.session.getItem('photo-puzzles/online/auth-flow')!).hash).toBe('#/x');       // what comes back is the flow that was started last
    expect(t.account.hasGoogle).toBe(false);                                                         // this one was set up without Google
    expect(new CognitoAccount({ host: HOST, clientId: 'c', google: true }, null, null).hasGoogle).toBe(true);
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
    expect(await withClaims({ sub: 'u1', name: 'Ann Lee', email: 'x@example.com' })).toEqual({ id: 'u1', name: 'Ann Lee', email: 'x@example.com' });
    expect(await withClaims({ sub: 'u1', email: 'ann.lee@example.com' })).toEqual({ id: 'u1', name: 'ann.lee', email: 'ann.lee@example.com' });
    expect(await withClaims({ sub: 'u1' })).toEqual({ id: 'u1', name: 'Player', email: undefined });
    expect((await withClaims({ sub: 'u1', name: 'A'.repeat(40) }))!.name).toHaveLength(24);
  });
  it('has a profile picture when the sign-in service gives one, and only a secure address', async () => {
    const url = 'https://lh3.googleusercontent.com/a/abc=s96-c';
    expect((await withClaims({ sub: 'u1', name: 'Ann', picture: url }))!.picture).toBe(url);
    expect((await withClaims({ sub: 'u1', name: 'Ann' }))!.picture).toBeUndefined();
    expect((await withClaims({ sub: 'u1', picture: 'http://example.com/a.png' }))!.picture).toBeUndefined();
    expect((await withClaims({ sub: 'u1', picture: 'javascript:alert(1)' }))!.picture).toBeUndefined();
    expect((await withClaims({ sub: 'u1', picture: 7 }))!.picture).toBeUndefined();
  });
  it('takes no picture that is not an address, or is absurdly long', () => {
    expect(pictureOf('not a url')).toBeUndefined();
    expect(pictureOf('')).toBeUndefined();
    expect(pictureOf(`https://example.com/${'a'.repeat(600)}`)).toBeUndefined();
    expect(pictureOf(' https://example.com/a.png ')).toBe('https://example.com/a.png');
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
    expect(t.account.signOut()).toBe(true);          // the page is taken away (and comes back)
    expect(t.account.who()).toBeNull();
    expect(t.local!.getItem('photo-puzzles/online/auth')).toBeNull();
    const url = new URL(t.went[t.went.length - 1]);
    expect(`${url.origin}${url.pathname}`).toBe(`${HOST}/logout`);
    expect(url.searchParams.get('logout_uri')).toBe(REDIRECT);
  });
});

/** A user pool that answers in its own way: what was asked (the target and the body), and a reply for each target. */
function pool(replies: Record<string, Response | (() => Response)>) {
  const asked: { url: string; target: string; body: Record<string, unknown> }[] = [];
  const t = setup();
  const reply = (target: string): Response => {
    const r = replies[target];
    return typeof r === 'function' ? r() : (r ?? json({ __type: 'InternalErrorException' }, 500));
  };
  const env = (t.account as unknown as { env: CognitoEnv }).env;
  env.fetch = (async (url: string, init: RequestInit) => {
    const target = String((init.headers as Record<string, string>)['X-Amz-Target']).split('.').pop()!;
    asked.push({ url, target, body: JSON.parse(String(init.body)) });
    return reply(target);
  }) as never;
  return { ...t, asked };
}
const error = (type: string) => json({ __type: `com.amazonaws.cognito#${type}` , message: 'm' }, 400);

describe('the e-mail and password pages', () => {
  it('signs in by asking the user pool of the region in the address of the sign-in pages, and keeps the tokens', async () => {
    const t = pool({ InitiateAuth: json({ AuthenticationResult: { IdToken: jwt({ sub: 'u9', email: 'me@example.com', exp: 1_700_003_600 }), RefreshToken: 'r9' } }) });
    const res = await new CognitoAccount({ host: 'https://x.auth.eu-west-2.amazoncognito.com', clientId: 'c' }, null, null, (t.account as unknown as { env: CognitoEnv }).env).passwords.signInWithPassword(' me@example.com ', 'Secret123');
    expect(res).toEqual({ ok: true });
    expect(t.asked[0].url).toBe('https://cognito-idp.eu-west-2.amazonaws.com/');
    expect(t.asked[0].target).toBe('InitiateAuth');
    expect(t.asked[0].body).toEqual({ ClientId: 'c', AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: 'me@example.com', PASSWORD: 'Secret123' } });
  });

  it('is signed in afterwards, with the e-mail address of the account, and the refresh token is the one the pool gave', async () => {
    const t = pool({ InitiateAuth: json({ AuthenticationResult: { IdToken: jwt({ sub: 'u9', email: 'me@example.com', exp: 1_700_003_600 }), RefreshToken: 'r9' } }) });
    expect(await t.account.passwords.signInWithPassword('me@example.com', 'Secret123')).toEqual({ ok: true });
    expect(t.account.who()).toEqual({ id: 'u9', name: 'me', email: 'me@example.com' });
    expect(JSON.parse(t.local!.getItem('photo-puzzles/online/auth')!).refresh).toBe('r9');
  });

  it('says what went wrong, in words the page can use, and is not signed in', async () => {
    const cases: [string, string][] = [
      ['NotAuthorizedException', 'wrong'],
      ['UserNotFoundException', 'wrong'],
      ['UserNotConfirmedException', 'unconfirmed'],
      ['PasswordResetRequiredException', 'reset'],
      ['TooManyRequestsException', 'limit'],
      ['SomethingNew', 'failed'],
    ];
    for (const [type, want] of cases) {
      const t = pool({ InitiateAuth: error(type) });
      expect(await t.account.passwords.signInWithPassword('a@b.co', 'x')).toEqual({ ok: false, error: want });
      expect(t.account.who()).toBeNull();
    }
  });

  it('says "offline" when the pool cannot be reached, and "failed" for a challenge it does not know how to answer', async () => {
    const t = setup({ reply: () => { throw new TypeError('network'); } });
    expect(await t.account.passwords.signInWithPassword('a@b.co', 'x')).toEqual({ ok: false, error: 'offline' });
    const c = pool({ InitiateAuth: json({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' }) });
    expect(await c.account.passwords.signInWithPassword('a@b.co', 'x')).toEqual({ ok: false, error: 'failed' });
  });

  it('makes an account with the e-mail address and, if given, the name; says whether a code has to be given', async () => {
    const t = pool({ SignUp: json({ UserConfirmed: false, UserSub: 's' }) });
    expect(await t.account.passwords.signUp(' new@example.com', 'Secret123', ' Ann ')).toEqual({ ok: true, needsCode: true });
    expect(t.asked[0].body).toEqual({ ClientId: 'client1', Username: 'new@example.com', Password: 'Secret123', UserAttributes: [{ Name: 'email', Value: 'new@example.com' }, { Name: 'name', Value: 'Ann' }] });
    const bare = pool({ SignUp: json({ UserConfirmed: true }) });
    expect(await bare.account.passwords.signUp('n@example.com', 'Secret123', '  ')).toEqual({ ok: true, needsCode: false });
    expect((bare.asked[0].body.UserAttributes as unknown[]).length).toBe(1);
  });

  it('says that an address is taken, or a password is not allowed', async () => {
    expect(await pool({ SignUp: error('UsernameExistsException') }).account.passwords.signUp('a@b.co', 'Secret123', '')).toEqual({ ok: false, error: 'exists' });
    expect(await pool({ SignUp: error('InvalidPasswordException') }).account.passwords.signUp('a@b.co', 'weak', '')).toEqual({ ok: false, error: 'password' });
  });

  it('confirms an address, sends the code again, and resets a password with a code', async () => {
    const t = pool({ ConfirmSignUp: json({}), ResendConfirmationCode: json({}), ForgotPassword: json({}), ConfirmForgotPassword: json({}) });
    expect(await t.account.passwords.confirmSignUp('a@b.co', ' 123456 ')).toEqual({ ok: true });
    expect(await t.account.passwords.resendCode('a@b.co')).toEqual({ ok: true });
    expect(await t.account.passwords.forgotPassword('a@b.co')).toEqual({ ok: true });
    expect(await t.account.passwords.resetPassword('a@b.co', '654321', 'Secret123')).toEqual({ ok: true });
    expect(t.asked.map((a) => a.target)).toEqual(['ConfirmSignUp', 'ResendConfirmationCode', 'ForgotPassword', 'ConfirmForgotPassword']);
    expect(t.asked[0].body).toEqual({ ClientId: 'client1', Username: 'a@b.co', ConfirmationCode: '123456' });
    expect(t.asked[3].body).toEqual({ ClientId: 'client1', Username: 'a@b.co', ConfirmationCode: '654321', Password: 'Secret123' });
  });

  it('says that a code is wrong or has run out', async () => {
    expect(await pool({ ConfirmSignUp: error('CodeMismatchException') }).account.passwords.confirmSignUp('a@b.co', '1')).toEqual({ ok: false, error: 'code' });
    expect(await pool({ ConfirmSignUp: error('ExpiredCodeException') }).account.passwords.confirmSignUp('a@b.co', '1')).toEqual({ ok: false, error: 'expired' });
  });

  it('signs out without leaving the page (and revokes the refresh token) when the player signed in with a password', async () => {
    const t = pool({ InitiateAuth: json({ AuthenticationResult: { IdToken: jwt({ sub: 'u9', exp: 1_700_003_600 }), RefreshToken: 'r9' } }), RevokeToken: json({}) });
    await t.account.passwords.signInWithPassword('a@b.co', 'x');
    expect(t.account.signOut()).toBe(false);
    expect(t.went).toEqual([]);
    expect(t.account.who()).toBeNull();
    expect(t.asked.at(-1)).toMatchObject({ target: 'RevokeToken', body: { Token: 'r9', ClientId: 'client1' } });
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
