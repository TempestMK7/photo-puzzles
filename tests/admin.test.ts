import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi, sayAdminError } from '../src/admin/api';
import { relative } from '../src/admin/page';

afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body?: unknown) => vi.fn(async () => new Response(body === undefined ? 'no json' : JSON.stringify(body), { status }));

describe('the admin page\'s calls', () => {
  it('send the token and the choices, and give back what the server says', async () => {
    const fetchMock = reply(200, { ok: true, players: [], next: null });
    vi.stubGlobal('fetch', fetchMock);
    const api = new AdminApi('https://api.test', async () => 'tok');
    expect(await api.get('/admin/players', { next: 'x y' })).toEqual({ ok: true, players: [], next: null });
    expect(fetchMock).toHaveBeenCalledWith('https://api.test/admin/players?next=x+y', { method: 'GET', headers: { Authorization: 'Bearer tok' }, body: undefined });
    const post = reply(200, { ok: true });
    vi.stubGlobal('fetch', post);
    expect(await api.post('/admin/ban', { id: 'a', reason: 'r' })).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith('https://api.test/admin/ban', { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{"id":"a","reason":"r"}' });
  });

  it('say why it did not work: not signed in, not an administrator, gone, no server', async () => {
    const api = new AdminApi('https://api.test', async () => 'tok');
    vi.stubGlobal('fetch', reply(403, { ok: false, error: 'unauthorized' }));
    expect(await api.get('/admin/me')).toEqual({ ok: false, error: 'unauthorized', status: 403 });
    vi.stubGlobal('fetch', reply(401));                                   // the gateway turns a token away without any JSON
    expect(await api.get('/admin/me')).toEqual({ ok: false, error: 'sign-in', status: 401 });
    vi.stubGlobal('fetch', reply(403));
    expect(await api.get('/admin/me')).toEqual({ ok: false, error: 'unauthorized', status: 403 });
    vi.stubGlobal('fetch', reply(404, { ok: false, error: 'not-found' }));
    expect(await api.post('/admin/room/x/remove')).toEqual({ ok: false, error: 'not-found', status: 404 });
    vi.stubGlobal('fetch', reply(500));
    expect(await api.get('/admin/me')).toEqual({ ok: false, error: 'failed', status: 500 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    expect(await api.get('/admin/me')).toEqual({ ok: false, error: 'offline', status: 0 });
  });

  it('do not ask at all without a token', async () => {
    const fetchMock = reply(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    expect(await new AdminApi('https://api.test', async () => null).get('/admin/me')).toEqual({ ok: false, error: 'sign-in', status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('have words for what went wrong', () => {
    for (const error of ['offline', 'sign-in', 'unauthorized', 'not-found', 'group', 'failed']) expect(sayAdminError({ ok: false, error, status: 0 }).length).toBeGreaterThan(5);
  });
});

describe('the times in the tables', () => {
  const now = 1_000_000_000_000;
  it('say how long ago or how long until, in the biggest sensible unit', () => {
    expect(relative(now + 20_000, now)).toBe('now');
    expect(relative(now + 5 * 60_000, now)).toBe('in 5 min');
    expect(relative(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relative(now + 20 * 3600_000, now)).toBe('in 20 h');
    expect(relative(now - 2 * 3600_000, now)).toBe('2 h ago');
    expect(relative(now - 3 * 86_400_000, now)).toBe('3 days ago');
    expect(relative(now + 30 * 86_400_000, now)).toBe('in 30 days');
  });
});
