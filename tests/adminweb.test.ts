import { describe, expect, it } from 'vitest';
import type { AdminLogEvent, AdminLogGroup } from '../src/online/adminProtocol';
import { makeAdminWeb, parseGroups, type AdminWebReq, type Directory, type DirectoryUser, type LogSource } from '../server/src/adminweb';
import { CloudWatchLogSource, CognitoDirectory, friendlyLogName, toAdminReq, toAdminResult } from '../server/src/aws/adminweb';
import { ann, bob, joined, open, world } from './helpers/world';

const users: DirectoryUser[] = [
  { id: 'ann', email: 'ann@example.com', created: 1000, status: 'CONFIRMED', enabled: true },
  { id: 'bob', email: 'bob@example.com', created: 2000, status: 'UNCONFIRMED', enabled: true },
];

function setup(extra = {}) {
  const w = world({ freeRoomsPerWeek: 50, ...extra });
  const asked: { group: string; since: number; filter: string; limit: number }[] = [];
  const pages: (string | undefined)[] = [];
  const directory: Directory = {
    async listUsers(next) {
      pages.push(next);
      return next ? { users: [users[1]] } : { users: [users[0]], next: 'more' };
    },
  };
  const groups: AdminLogGroup[] = [{ name: 'PuzzleVidio-dev-Api-ApiLogsAAAAAAAA-x', label: 'Api' }];
  const logs: LogSource = {
    groups: async () => groups,
    async events(group, since, filter, limit): Promise<AdminLogEvent[]> {
      asked.push({ group, since, filter, limit });
      return [{ t: 5, message: 'ERROR something' }];
    },
  };
  const handle = makeAdminWeb({ service: w.service, directory, logs, now: () => w.clock.t });
  const call = (method: string, path: string, o: { query?: string; body?: unknown; groups?: string[] } = {}) =>
    handle({ method, path, query: new URLSearchParams(o.query ?? ''), body: o.body ?? {}, groups: o.groups ?? ['admins'] } satisfies AdminWebReq);
  return { w, call, asked, pages, groups };
}

describe('the groups claim', () => {
  it('is read from the forms the gateway gives it in', () => {
    expect(parseGroups('[admins]')).toEqual(['admins']);
    expect(parseGroups('[admins editors]')).toEqual(['admins', 'editors']);
    expect(parseGroups('admins')).toEqual(['admins']);
    expect(parseGroups(['admins', 3, 'x'])).toEqual(['admins', 'x']);
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups('')).toEqual([]);
    expect(parseGroups('[]')).toEqual([]);
  });
});

describe('the admin routes', () => {
  it('turn away anyone who is not in the admin group, on every route, and change nothing', async () => {
    const { w, call } = setup();
    const made = await open(w);
    for (const who of [[], ['users'], ['admin'], ['Admins']]) {
      for (const [method, path] of [['GET', '/admin/me'], ['GET', '/admin/players'], ['GET', '/admin/rooms'], ['GET', `/admin/room/${made.roomId}`], ['POST', `/admin/room/${made.roomId}/remove`], ['GET', '/admin/files'], ['POST', '/admin/file/x/remove'], ['GET', '/admin/reports'], ['GET', '/admin/bans'], ['POST', '/admin/ban'], ['POST', '/admin/unban'], ['GET', '/admin/logs/groups'], ['GET', '/admin/logs']]) {
        expect(await call(method, path, { groups: who, body: { id: 'ann' } }), `${method} ${path} as ${who}`).toEqual({ status: 403, body: { ok: false, error: 'unauthorized' } });
      }
    }
    expect(await w.service.adminRoom(made.roomId)).toBeDefined();                // the puzzle is still there
    expect(await w.service.adminBans()).toEqual([]);
  });

  it('say yes to an administrator, and know no other route', async () => {
    const { call } = setup();
    expect(await call('GET', '/admin/me')).toEqual({ status: 200, body: { ok: true } });
    expect(await call('GET', '/admin/nothing')).toMatchObject({ status: 404 });
    expect(await call('POST', '/admin/me')).toMatchObject({ status: 404 });
    expect(await call('GET', '/admin/me/')).toMatchObject({ status: 200 });
  });

  it('list the accounts a page at a time, with the name each chose and whether they are banned', async () => {
    const { w, call, pages } = setup();
    await w.service.setProfile(ann, 'Annie');
    await w.service.adminBan('bob', 'rude');
    const first = await call('GET', '/admin/players');
    expect(first.body).toEqual({ ok: true, next: 'more', players: [{ ...users[0], name: 'Annie', banned: false }] });
    const second = await call('GET', '/admin/players', { query: 'next=more' });
    expect(second.body).toEqual({ ok: true, next: null, players: [{ ...users[1], name: '', banned: true }] });
    expect(pages).toEqual([undefined, 'more']);
  });

  it('list the puzzles that exist, with who is in each and who is connected, and the time played', async () => {
    const { w, call } = setup();
    const made = await open(w);
    await joined(w, made, bob);
    w.online.add('bob');
    const rec = (await w.store.getRoom(made.roomId))!;
    await w.store.putRoom({ ...rec, played: { ms: 90_000, since: w.clock.t - 10_000 }, rev: rec.rev + 1 });
    const res = await call('GET', '/admin/rooms');
    expect(res.body.rooms).toEqual([
      {
        id: made.roomId,
        owner: { id: 'ann', name: 'Ann' },
        members: [{ id: 'ann', name: 'Ann', online: false }, { id: 'bob', name: 'Bob', online: true }],
        pieces: 100,
        status: 'open',
        ready: true,
        createdAt: w.clock.t,
        expiresAt: w.clock.t + 24 * 3600 * 1000,
        playedMs: 100_000,
      },
    ]);
    w.clock.t += 2 * 24 * 3600 * 1000;                                    // a puzzle that has run out is not listed
    expect((await call('GET', '/admin/rooms')).body.rooms).toEqual([]);
  });

  it('show a puzzle with the address of its picture, and end it when asked', async () => {
    const { w, call } = setup();
    const made = await open(w);
    const seen = await call('GET', `/admin/room/${made.roomId}`);
    expect(seen.body.room).toMatchObject({ id: made.roomId, ownerId: 'ann', picture: expect.stringContaining(made.roomId) });
    expect(await call('GET', '/admin/room/nothing')).toMatchObject({ status: 404 });
    expect(await call('POST', `/admin/room/${made.roomId}/remove`)).toEqual({ status: 200, body: { ok: true } });
    expect(await call('POST', `/admin/room/${made.roomId}/remove`)).toMatchObject({ status: 404 });
    expect(w.media.has(made.roomId)).toBe(false);
    expect(await call('GET', '/admin/room/..%2Fx')).toMatchObject({ status: 404 });
  });

  it('list the pictures and videos the server keeps, newest first, a page at a time, and delete one with the puzzles made from it', async () => {
    const { w, call } = setup({ activeRoomsPerPlayer: 99 });
    const first = await open(w);
    w.clock.t += 1000;
    const second = await open(w, bob);
    const listed = (await call('GET', '/admin/files')).body as unknown as { files: { id: string; ownerId: string; url: string }[]; next: string | null };
    expect(listed.files.map((f) => f.ownerId)).toEqual(['bob', 'ann']);
    expect(listed.files[0].url).toMatch(/^http:\/\/media\.test\/media\//);
    expect(listed.next).toBeNull();
    for (const bad of ['x', '123#a', '000000001000000#a b', '000000001000000#']) expect((await call('GET', '/admin/files', { query: `before=${encodeURIComponent(bad)}` })).status, bad).toBe(400);
    expect(((await call('GET', '/admin/files', { query: `before=${encodeURIComponent(`${String(w.clock.t - 1).padStart(15, '0')}#zzz`)}` })).body.files as unknown[]).length).toBe(1);
    const fileId = (await w.store.getRoom(first.roomId))!.fileId!;
    expect(await call('POST', `/admin/file/${fileId}/remove`)).toEqual({ status: 200, body: { ok: true } });
    expect(await w.service.adminRoom(first.roomId)).toBeUndefined();            // the puzzle made from it ended with it
    expect(await w.service.adminRoom(second.roomId)).toBeDefined();
    expect(await call('POST', `/admin/file/${fileId}/remove`)).toMatchObject({ status: 404 });
    expect(((await call('GET', '/admin/files')).body.files as unknown[]).length).toBe(1);
  });

  it('list the reports of the last days, and refuse a number of days that makes no sense', async () => {
    const { w, call } = setup();
    const made = await open(w);
    await joined(w, made, bob);
    await w.service.report(bob, made.roomId, { reason: 'illegal', note: 'look' });
    expect((await call('GET', '/admin/reports')).body.reports).toMatchObject([{ roomId: made.roomId, reporterId: 'bob', reason: 'illegal', note: 'look' }]);
    expect((await call('GET', '/admin/reports', { query: 'days=1' })).body.reports).toHaveLength(1);
    for (const days of ['0', '-1', '91', 'x']) expect((await call('GET', '/admin/reports', { query: `days=${days}` })).status, days).toBe(400);
  });

  it('ban and unban a player, and list the bans', async () => {
    const { w, call } = setup();
    const made = await open(w);
    expect(await call('POST', '/admin/ban', { body: { id: 'ann', reason: 'not hers' } })).toEqual({ status: 200, body: { ok: true } });
    expect((await call('GET', '/admin/bans')).body.bans).toMatchObject([{ playerId: 'ann', reason: 'not hers' }]);
    expect(await w.service.adminRoom(made.roomId)).toBeUndefined();            // the puzzle she made ended with the ban
    expect(await call('POST', '/admin/unban', { body: { id: 'ann' } })).toEqual({ status: 200, body: { ok: true } });
    expect((await call('GET', '/admin/bans')).body.bans).toEqual([]);
    for (const bad of [{}, { id: '' }, { id: '../x' }, { id: 5 }]) expect((await call('POST', '/admin/ban', { body: bad })).status).toBe(400);
    expect((await call('POST', '/admin/unban', { body: {} })).status).toBe(400);
  });

  it('read the logs of one of the groups it offers, within the last day, and no other', async () => {
    const { w, call, asked, groups } = setup();
    expect((await call('GET', '/admin/logs/groups')).body.groups).toEqual(groups);
    const got = await call('GET', '/admin/logs', { query: `group=${groups[0].name}&minutes=30&filter=ERROR` });
    expect(got.body.events).toEqual([{ t: 5, message: 'ERROR something' }]);
    expect(asked).toEqual([{ group: groups[0].name, since: w.clock.t - 30 * 60_000, filter: 'ERROR', limit: 200 }]);
    for (const query of [`group=other&minutes=30`, `group=${groups[0].name}&minutes=0`, `group=${groups[0].name}&minutes=1441`, `group=${groups[0].name}&minutes=x`, `group=${groups[0].name}&filter=${'x'.repeat(101)}`, '']) {
      expect((await call('GET', '/admin/logs', { query })).status, query).toBe(400);
    }
    expect(asked).toHaveLength(1);
  });
});

describe('the pieces that ask AWS', () => {
  it('turns the user pool\'s accounts into players, and passes the page token on', async () => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      send: async (c: { input: Record<string, unknown> }) => {
        sent.push(c.input);
        return {
          Users: [
            { Username: 'u-1', UserStatus: 'CONFIRMED', Enabled: true, UserCreateDate: new Date(1234), Attributes: [{ Name: 'sub', Value: 'sub-1' }, { Name: 'email', Value: 'a@example.com' }] },
            { Username: 'u-2', UserStatus: 'FORCE_CHANGE_PASSWORD', Enabled: false },
          ],
          PaginationToken: 'tok',
        };
      },
    };
    const dir = new CognitoDirectory(client as never, 'pool1');
    expect(await dir.listUsers('prev')).toEqual({
      users: [
        { id: 'sub-1', email: 'a@example.com', created: 1234, status: 'CONFIRMED', enabled: true },
        { id: 'u-2', email: '', created: 0, status: 'FORCE_CHANGE_PASSWORD', enabled: false },
      ],
      next: 'tok',
    });
    expect(sent[0]).toMatchObject({ UserPoolId: 'pool1', Limit: 60, PaginationToken: 'prev' });
  });

  it('names the functions\' log groups by what they are', () => {
    expect(friendlyLogName('PuzzleVidio-dev-Api-ApiLogs3D05D88B-RmE2OgIY9qKH')).toBe('Api');
    expect(friendlyLogName('PuzzleVidio-dev-Api-AdminWebLogs4026B555-3JnHiloFq8BC')).toBe('AdminWeb');
    expect(friendlyLogName('PuzzleVidio-dev-Live-AuthorizerLogsBA5DABC9-Ucw9bV1GWQ6z')).toBe('Authorizer');
    expect(friendlyLogName('something-else')).toBe('something-else');
  });

  it('lists the log groups of the deployment and reads events newest first, truncated, at most the limit', async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push({ name: c.constructor.name, input: c.input });
        if (c.constructor.name === 'DescribeLogGroupsCommand') {
          return c.input.nextToken ? { logGroups: [{ logGroupName: 'PuzzleVidio-dev-Live-PresenceLogs6B2F162C-T' }] } : { logGroups: [{ logGroupName: 'PuzzleVidio-dev-Api-ApiLogs3D05D88B-R' }], nextToken: 'n' };
        }
        return { events: [{ timestamp: 1, message: 'old\n' }, { timestamp: 3, message: 'x'.repeat(5000) }, { timestamp: 2, message: 'mid' }] };
      },
    };
    const source = new CloudWatchLogSource(client as never, 'PuzzleVidio-dev-');
    expect((await source.groups()).map((g) => g.label)).toEqual(['Api', 'Presence']);
    const events = await source.events('group', 100, 'ERROR', 2);
    expect(events.map((e) => e.t)).toEqual([3, 2]);
    expect(events[0].message).toHaveLength(2000);
    expect(calls.find((c) => c.name === 'FilterLogEventsCommand')!.input).toMatchObject({ logGroupName: 'group', startTime: 100, filterPattern: 'ERROR', limit: 2 });
    expect(calls.find((c) => c.name === 'DescribeLogGroupsCommand')!.input).toMatchObject({ logGroupNamePrefix: 'PuzzleVidio-dev-' });
  });

  it('turns a gateway event into a request, and a result into an answer that is not kept in any cache', () => {
    const req = toAdminReq({
      rawPath: '/admin/players/',
      rawQueryString: 'next=abc',
      isBase64Encoded: false,
      body: '{"id":"x"}',
      requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims: { 'cognito:groups': '[admins]' } } } },
    } as never);
    expect(req).toMatchObject({ method: 'POST', path: '/admin/players', body: { id: 'x' }, groups: ['admins'] });
    expect(req.query.get('next')).toBe('abc');
    expect(toAdminReq({ rawPath: '/admin/me', rawQueryString: '', body: 'not json', requestContext: { http: { method: 'GET' } } } as never)).toMatchObject({ body: {}, groups: [] });
    const out = toAdminResult({ status: 403, body: { ok: false, error: 'unauthorized' } });
    expect(out).toMatchObject({ statusCode: 403, headers: { 'cache-control': 'no-store' } });
  });
});
