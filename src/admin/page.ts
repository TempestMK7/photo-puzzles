import { formatTime } from '../core/prefs';
import type { AdminLogEvent, AdminLogGroup, AdminPlayer, AdminReport, AdminRoomDetail, AdminRoomSummary } from '../online/adminProtocol';
import { CognitoAccount } from '../online/cognito';
import { cloudConfig } from '../online/config';
import { h } from '../ui/dom';
import { SignInDialog } from '../ui/signin';
import { AdminApi, sayAdminError, type AdminFailure } from './api';

type Tab = 'players' | 'rooms' | 'reports' | 'logs';
const TABS: { id: Tab; label: string }[] = [
  { id: 'players', label: 'Players' },
  { id: 'rooms', label: 'Puzzles' },
  { id: 'reports', label: 'Reports' },
  { id: 'logs', label: 'Logs' },
];

const when = (ms: number): string => (ms ? new Date(ms).toLocaleString() : '');
const short = (id: string): string => (id.length > 10 ? `${id.slice(0, 8)}…` : id);

/** How long until a time, or how long ago it was, for a table ("in 5 h", "2 days ago"). */
export function relative(ms: number, now = Date.now()): string {
  const d = ms - now;
  const a = Math.abs(d) / 60_000;
  const text = a < 1 ? 'now' : a < 60 ? `${Math.round(a)} min` : a < 48 * 60 ? `${Math.round(a / 60)} h` : `${Math.round(a / 1440)} days`;
  return text === 'now' ? text : d > 0 ? `in ${text}` : `${text} ago`;
}

/**
 * The admin page (`/admin`): sign in with an account that is in the admin group, and look at the players with accounts, the puzzles that exist, the reports and the functions' logs.
 * Everything is asked of the API's admin routes, which check the group again: this page only shows what they give. Ending a puzzle and banning a player ask a second time, in the page.
 */
class AdminPage {
  private readonly body = h('div', { class: 'content' });
  private readonly top = h('header', { class: 'top' });
  private readonly account: CognitoAccount;
  private readonly api: AdminApi;
  private readonly dialog: SignInDialog;
  private tab: Tab = 'players';
  /** Bumped by every draw: an answer that comes after the page has moved on is dropped. */
  private draw = 0;
  /** The thing the administrator has pressed once and has to press again ("end:<id>", "ban:<id>"). */
  private asked = '';
  private reason = '';
  private look: AdminRoomDetail | null = null;
  private message = '';
  private logs = { groups: [] as AdminLogGroup[], group: '', minutes: 60, filter: '', events: null as AdminLogEvent[] | null };
  private players: { list: AdminPlayer[]; next: string | null } = { list: [], next: null };

  constructor(private readonly root: HTMLElement, base: string, host: string, clientId: string) {
    this.account = new CognitoAccount({ host, clientId }, store('local'), store('session'));
    this.api = new AdminApi(base, () => this.account.token());
    this.dialog = new SignInDialog(this.account.passwords);
    this.root.replaceChildren(h('div', { class: 'admin' }, this.top, this.body), this.dialog.el);
  }

  async start(): Promise<void> {
    await this.enter();
  }

  // ---------------------------------------------------------------------------------------------------------------- signing in

  private header(extra: Node[] = []): void {
    const who = this.account.who();
    this.top.replaceChildren(
      h('h1', {}, 'PuzzleVidio admin'),
      h('span', { class: 'spacer' }),
      ...extra,
      ...(who ? [h('span', { class: 'dim' }, who.email ?? who.name), h('button', { type: 'button', class: 'small', onclick: () => this.signOut() }, 'Sign out')] : []),
      h('a', { class: 'back', href: '/' }, 'The game'),
    );
  }

  private card(...kids: (Node | string)[]): void {
    this.body.replaceChildren(h('div', { class: 'gate' }, ...kids));
  }

  /** Signed in or not, and an administrator or not. */
  private async enter(): Promise<void> {
    this.header();
    if (!this.account.who()) {
      this.card(h('h2', {}, 'Sign in'), h('p', {}, 'Only accounts in the admin group get further.'), h('button', { type: 'button', class: 'primary', onclick: () => void this.signIn() }, 'Sign in'));
      return;
    }
    this.card(h('p', {}, 'Checking…'));
    const me = await this.api.get('/admin/me');
    if (me.ok) {
      this.show();
      return;
    }
    if (me.error === 'sign-in') {
      this.card(h('p', {}, 'Your sign-in has run out.'), h('button', { type: 'button', class: 'primary', onclick: () => void this.signIn() }, 'Sign in'));
      return;
    }
    this.card(h('h2', {}, me.error === 'unauthorized' ? 'Not an administrator' : 'Could not check'), h('p', {}, sayAdminError(me)), h('button', { type: 'button', onclick: () => void this.enter() }, 'Try again'));
  }

  private async signIn(): Promise<void> {
    if (await this.dialog.ask()) await this.enter();
  }

  private signOut(): void {
    this.account.signOut();
    this.players = { list: [], next: null };
    this.look = null;
    void this.enter();
  }

  // ---------------------------------------------------------------------------------------------------------------- the tabs

  private show(): void {
    this.header();
    const tabs = h(
      'div',
      { class: 'tabs', role: 'tablist' },
      ...TABS.map((t) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(t.id === this.tab), onclick: () => this.go(t.id) }, t.label)),
    );
    this.body.replaceChildren(tabs, h('div', { class: 'pane' }));
    void this.fill();
  }

  private go(tab: Tab): void {
    this.tab = tab;
    this.asked = '';
    this.message = '';
    this.show();
  }

  private pane(): HTMLElement {
    return this.body.querySelector('.pane') as HTMLElement;
  }

  /** Draws the open tab: what is known now at once, and what has to be asked for when it comes. */
  private async fill(): Promise<void> {
    const mine = ++this.draw;
    const pane = this.pane();
    const shown = (...kids: Node[]) => {
      if (mine === this.draw) pane.replaceChildren(...(this.message ? [h('p', { class: 'note' }, this.message)] : []), ...kids);
    };
    const failed = (f: AdminFailure) => shown(h('p', { class: 'error' }, sayAdminError(f)), h('button', { type: 'button', onclick: () => void this.fill() }, 'Try again'));
    if (this.tab === 'logs') {
      const view = await this.logsView(failed);
      if (view) shown(view);
      return;
    }
    shown(h('p', { class: 'dim' }, 'Loading…'));
    if (this.tab === 'players') {
      if (!this.players.list.length) {
        const res = await this.api.get<{ players: AdminPlayer[]; next: string | null }>('/admin/players');
        if (!res.ok) return failed(res);
        this.players = { list: res.players, next: res.next };
      }
      shown(this.playersView());
    } else if (this.tab === 'rooms') {
      const res = await this.api.get<{ rooms: AdminRoomSummary[] }>('/admin/rooms');
      if (!res.ok) return failed(res);
      shown(...(this.look ? [this.lookView()] : []), this.roomsView(res.rooms));
    } else {
      const res = await this.api.get<{ reports: AdminReport[] }>('/admin/reports', { days: '30' });
      if (!res.ok) return failed(res);
      shown(...(this.look ? [this.lookView()] : []), this.reportsView(res.reports));
    }
  }

  private refreshButton(): HTMLElement {
    return h('button', { type: 'button', class: 'small', onclick: () => void this.fill() }, 'Refresh');
  }

  private copy(id: string): HTMLElement {
    return h(
      'button',
      { type: 'button', class: 'link id', title: `${id} (press to copy)`, onclick: () => void navigator.clipboard?.writeText(id).then(() => this.say('Copied.')) },
      short(id),
    );
  }

  private say(text: string): void {
    this.message = text;
    const note = this.pane().querySelector('.note');
    if (note) note.textContent = text;
    else this.pane().prepend(h('p', { class: 'note' }, text));
  }

  private table(head: string[], rows: (Node | string)[][]): HTMLElement {
    return h(
      'div',
      { class: 'scroll' },
      h('table', {}, h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, c)))), h('tbody', {}, ...(rows.length ? rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c)))) : [h('tr', {}, h('td', { colSpan: head.length, class: 'dim' }, 'None.'))]))),
    );
  }

  // ---------------------------------------------------------------------------------------------------------------- players

  private playersView(): HTMLElement {
    const p = this.players;
    return h(
      'div',
      {},
      h('div', { class: 'row' }, h('span', { class: 'dim' }, `${p.list.length} account${p.list.length === 1 ? '' : 's'}${p.next ? ' so far' : ''}`), this.refreshButton()),
      this.table(
        ['Name', 'E-mail', 'Joined', 'Status', 'Id', ''],
        p.list.map((u) => [
          u.name || h('span', { class: 'dim' }, 'no name'),
          u.email,
          when(u.created),
          h('span', {}, u.status.toLowerCase().replace(/_/g, ' '), ...(u.enabled ? [] : [h('span', { class: 'badge' }, 'disabled')]), ...(u.banned ? [h('span', { class: 'badge bad' }, 'banned')] : [])),
          this.copy(u.id),
          this.banControl(u),
        ]),
      ),
      ...(p.next ? [h('button', { type: 'button', onclick: () => void this.morePlayers() }, 'More')] : []),
    );
  }

  private banControl(u: AdminPlayer): Node {
    if (u.banned) return h('button', { type: 'button', class: 'small', onclick: () => void this.unban(u.id) }, 'Unban');
    if (this.asked !== `ban:${u.id}`) return h('button', { type: 'button', class: 'small', onclick: () => this.ask(`ban:${u.id}`) }, 'Ban…');
    return h(
      'span',
      { class: 'ask', role: 'alertdialog', 'aria-label': 'Ban this player' },
      h('input', { type: 'text', class: 'plain', maxLength: 100, placeholder: 'Why (kept with the ban)', 'aria-label': 'Reason', value: this.reason, oninput: (e: Event) => (this.reason = (e.target as HTMLInputElement).value) }),
      h('button', { type: 'button', class: 'small danger', onclick: () => void this.ban(u.id) }, 'Ban'),
      h('button', { type: 'button', class: 'small', onclick: () => this.ask('') }, 'Cancel'),
    );
  }

  private ask(what: string): void {
    this.asked = what;
    this.reason = '';
    this.redraw();
  }

  /** Draws the open tab again from what is known, without asking the server. */
  private redraw(): void {
    if (this.tab === 'players') this.pane().replaceChildren(...(this.message ? [h('p', { class: 'note' }, this.message)] : []), this.playersView());
    else void this.fill();
  }

  private async morePlayers(): Promise<void> {
    const next = this.players.next;
    if (!next) return;
    const res = await this.api.get<{ players: AdminPlayer[]; next: string | null }>('/admin/players', { next });
    if (!res.ok) return this.say(sayAdminError(res));
    this.players = { list: [...this.players.list, ...res.players], next: res.next };
    this.redraw();
  }

  private async ban(id: string): Promise<void> {
    const reason = this.reason;
    this.asked = '';
    const res = await this.api.post('/admin/ban', { id, reason });
    this.message = res.ok ? 'Banned. The puzzles they made have ended.' : sayAdminError(res);
    this.players = { list: [], next: null };
    this.look = null;
    void this.fill();
  }

  private async unban(id: string): Promise<void> {
    const res = await this.api.post('/admin/unban', { id });
    this.message = res.ok ? 'Unbanned.' : sayAdminError(res);
    this.players = { list: [], next: null };
    void this.fill();
  }

  // ---------------------------------------------------------------------------------------------------------------- puzzles

  private roomsView(rooms: AdminRoomSummary[]): HTMLElement {
    return h(
      'div',
      {},
      h('div', { class: 'row' }, h('span', { class: 'dim' }, `${rooms.length} puzzle${rooms.length === 1 ? '' : 's'}`), this.refreshButton()),
      this.table(
        ['Made by', 'Players', 'Pieces', 'State', 'Played', 'Ends', 'Id', ''],
        rooms.map((r) => [
          r.owner.name || h('span', { class: 'dim' }, 'no name'),
          h('span', {}, ...r.members.flatMap((m, i) => [...(i ? [', '] : []), h('span', { class: m.online ? 'on' : 'off', title: m.online ? 'connected' : 'not connected' }, m.name || m.id)])),
          String(r.pieces),
          r.status === 'solved' ? 'solved' : r.ready ? 'open' : 'waiting for the picture',
          formatTime(r.playedMs),
          h('span', { title: when(r.expiresAt) }, relative(r.expiresAt)),
          this.copy(r.id),
          h('button', { type: 'button', class: 'small', onclick: () => void this.lookAt(r.id) }, 'Look'),
        ]),
      ),
    );
  }

  private async lookAt(id: string): Promise<void> {
    const res = await this.api.get<{ room: AdminRoomDetail }>(`/admin/room/${encodeURIComponent(id)}`);
    if (!res.ok) {
      this.look = null;
      this.message = sayAdminError(res);
    } else {
      this.look = res.room;
      this.message = '';
    }
    this.asked = '';
    void this.fill();
  }

  /** One puzzle, to look at and to end: who is in it and its picture. */
  private lookView(): HTMLElement {
    const r = this.look!;
    const ending = this.asked === `end:${r.id}`;
    return h(
      'section',
      { class: 'look' },
      h('h2', {}, 'A puzzle'),
      h('p', { class: 'dim' }, `${r.pieces} pieces · ${r.status} · made ${when(r.createdAt)} · ends ${when(r.expiresAt)}`),
      h('p', {}, 'Made by ', this.copy(r.ownerId), ' · players: ', r.members.map((m) => m.name || m.id).join(', ')),
      r.picture ? h('img', { src: r.picture, alt: 'The picture of the puzzle', class: 'picture' }) : h('p', { class: 'dim' }, 'The picture has not arrived.'),
      h(
        'div',
        { class: 'row' },
        ending
          ? h('span', { class: 'ask', role: 'alertdialog', 'aria-label': 'End this puzzle' }, 'End it for good? Its picture is deleted and the players are told it was closed. ', h('button', { type: 'button', class: 'small danger', onclick: () => void this.end(r.id) }, 'End the puzzle'), h('button', { type: 'button', class: 'small', onclick: () => this.ask('') }, 'Cancel'))
          : h('button', { type: 'button', class: 'danger small', onclick: () => this.ask(`end:${r.id}`) }, 'End this puzzle…'),
        h('button', { type: 'button', class: 'small', onclick: () => ((this.look = null), void this.fill()) }, 'Close'),
      ),
    );
  }

  private async end(id: string): Promise<void> {
    this.asked = '';
    const res = await this.api.post(`/admin/room/${encodeURIComponent(id)}/remove`);
    this.message = res.ok ? 'The puzzle was ended.' : sayAdminError(res);
    this.look = null;
    void this.fill();
  }

  // ---------------------------------------------------------------------------------------------------------------- reports

  private reportsView(reports: AdminReport[]): HTMLElement {
    return h(
      'div',
      {},
      h('div', { class: 'row' }, h('span', { class: 'dim' }, `${reports.length} report${reports.length === 1 ? '' : 's'} in the last 30 days`), this.refreshButton()),
      this.table(
        ['When', 'Why', 'Note', 'Puzzle', 'Made by', 'Reported by', ''],
        reports.map((r) => [
          h('span', { title: when(r.at) }, relative(r.at)),
          r.reason,
          r.note || h('span', { class: 'dim' }, 'no note'),
          this.copy(r.roomId),
          this.copy(r.ownerId),
          this.copy(r.reporterId),
          h('button', { type: 'button', class: 'small', onclick: () => void this.lookAt(r.roomId) }, 'Look'),
        ]),
      ),
      h('p', { class: 'dim' }, 'A puzzle that has ended cannot be looked at any more; the report keeps who made it and who was in it (the ids). To ban a player, find them under Players by id.'),
    );
  }

  // ---------------------------------------------------------------------------------------------------------------- logs

  /** The controls and the events of the logs tab; nothing (after `failed` has said why) if the list of functions could not be had. */
  private async logsView(failed: (f: AdminFailure) => void): Promise<HTMLElement | null> {
    if (!this.logs.groups.length) {
      const res = await this.api.get<{ groups: AdminLogGroup[] }>('/admin/logs/groups');
      if (!res.ok) {
        failed(res);
        return null;
      }
      this.logs.groups = res.groups;
      this.logs.group ||= res.groups.find((g) => g.label === 'Api')?.name ?? res.groups[0]?.name ?? '';
    }
    const l = this.logs;
    const select = h(
      'select',
      { 'aria-label': 'Which function', onchange: (e: Event) => (l.group = (e.target as HTMLSelectElement).value) },
      ...l.groups.map((g) => h('option', { value: g.name, selected: g.name === l.group }, g.label)),
    );
    const minutes = h(
      'select',
      { 'aria-label': 'How far back', onchange: (e: Event) => (l.minutes = Number((e.target as HTMLSelectElement).value)) },
      ...[[15, '15 minutes'], [60, 'an hour'], [360, '6 hours'], [1440, 'a day']].map(([m, t]) => h('option', { value: String(m), selected: m === l.minutes }, String(t))),
    );
    const filter = h('input', { type: 'text', class: 'plain', placeholder: 'Filter, like ERROR or "a piece"', maxLength: 100, 'aria-label': 'Filter', value: l.filter, oninput: (e: Event) => (l.filter = (e.target as HTMLInputElement).value), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void this.loadLogs() });
    const events = h('div', { class: 'events' });
    this.logsOut = events;
    this.drawEvents();
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'row wrap' },
        select,
        minutes,
        filter,
        h('button', { type: 'button', class: 'primary small', onclick: () => void this.loadLogs() }, 'Show'),
        h('button', { type: 'button', class: 'small', title: 'Only the lines that say ERROR', onclick: () => ((l.filter = filter.value = 'ERROR'), void this.loadLogs()) }, 'Errors'),
      ),
      events,
    );
  }

  private logsOut: HTMLElement | null = null;

  private async loadLogs(): Promise<void> {
    const l = this.logs;
    if (!this.logsOut) return;
    this.logsOut.replaceChildren(h('p', { class: 'dim' }, 'Loading…'));
    const res = await this.api.get<{ events: AdminLogEvent[] }>('/admin/logs', { group: l.group, minutes: String(l.minutes), filter: l.filter });
    if (!res.ok) {
      l.events = null;
      this.logsOut?.replaceChildren(h('p', { class: 'error' }, sayAdminError(res)));
      return;
    }
    l.events = res.events;
    this.drawEvents();
  }

  private drawEvents(): void {
    const out = this.logsOut;
    const events = this.logs.events;
    if (!out) return;
    if (!events) {
      out.replaceChildren(h('p', { class: 'dim' }, 'Choose a function and press Show. The newest events come first (at most 200).'));
      return;
    }
    out.replaceChildren(
      h('p', { class: 'dim' }, `${events.length} event${events.length === 1 ? '' : 's'}${events.length >= 200 ? ' (the newest 200: narrow the time or the filter)' : ''}`),
      h('div', { class: 'log' }, ...events.map((e) => h('div', { class: /error|exception|timed out/i.test(e.message) ? 'line bad' : 'line' }, h('span', { class: 'at' }, new Date(e.t).toLocaleTimeString()), ' ', e.message))),
    );
  }
}

function store(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Shows the admin page in `root` (the game is not started). */
export async function openAdmin(root: HTMLElement): Promise<void> {
  document.title = 'PuzzleVidio admin';
  const cloud = cloudConfig();
  if (!cloud) {
    root.replaceChildren(h('div', { class: 'admin' }, h('div', { class: 'gate' }, h('h2', {}, 'No server'), h('p', {}, 'This build does not know where the online server is, so there is nothing to administer.'))));
    return;
  }
  await new AdminPage(root, cloud.api, cloud.cognitoHost, cloud.cognitoClientId).start();
}

