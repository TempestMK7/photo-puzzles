import type { OnlineApi } from '../online/api';
import { PLAYER_COLORS } from '../online/config';
import type { Invite } from '../online/protocol';
import type { OnlineRoom } from '../online/room';
import { h } from './dom';

/**
 * What a puzzle played with friends shows over the board: who is in it (and who is connected), whether the connection is up, a short message ("Ann is moving a piece"),
 * players waiting to be let in, and the invite (the code and the link) for the one who made it.
 */
export class OnlineBar {
  readonly el: HTMLElement;
  private chips = h('div', { class: 'chips' });
  private status = h('span', { class: 'conn' });
  private inviteBtn = h('button', { type: 'button', class: 'small', onclick: () => this.toggleInvite() }, 'Invite');
  private saveBtn = h('button', { type: 'button', class: 'small', title: 'Keep this picture in your own list', onclick: () => this.onSave() }, 'Save picture');
  private knocksEl = h('div', { class: 'knocks' });
  private bannerEl = h('div', { class: 'banner', role: 'status', hidden: true });
  private inviteEl = h('div', { class: 'invite', hidden: true });
  private room: OnlineRoom | null = null;
  private invite: Invite | null = null;
  private bannerTimer = 0;

  constructor(
    private readonly api: OnlineApi,
    private readonly onSave: () => void,
  ) {
    this.el = h('div', { class: 'onlinebar', hidden: true }, h('div', { class: 'row1' }, this.chips, this.status, this.inviteBtn, this.saveBtn), this.knocksEl, this.bannerEl, this.inviteEl);
  }

  show(room: OnlineRoom, invite: Invite | null): void {
    this.room = room;
    this.invite = invite;
    this.inviteBtn.hidden = room.me !== room.descriptor.owner;
    this.inviteEl.hidden = true;
    this.el.hidden = false;
    this.refresh();
  }

  hide(): void {
    this.room = null;
    this.el.hidden = true;
    window.clearTimeout(this.bannerTimer);
  }

  /** A short message that goes away by itself. */
  say(text: string, ms = 3500): void {
    this.bannerEl.textContent = text;
    this.bannerEl.hidden = !text;
    window.clearTimeout(this.bannerTimer);
    if (text && ms) this.bannerTimer = window.setTimeout(() => (this.bannerEl.hidden = true), ms);
  }

  refresh(): void {
    const room = this.room;
    if (!room) return;
    this.chips.replaceChildren(
      ...room.members.map((m) =>
        h(
          'span',
          { class: `chip${room.online.has(m.id) || m.id === room.me ? ' on' : ''}`, title: room.online.has(m.id) || m.id === room.me ? 'Here now' : 'Not here at the moment' },
          h('i', { style: `background:${PLAYER_COLORS[m.color % PLAYER_COLORS.length]}` }),
          m.id === room.me ? `${m.name} (you)` : m.name,
        ),
      ),
    );
    const held = room.holderOther();
    this.status.textContent =
      room.status === 'reconnecting' ? 'Reconnecting…' : room.status === 'connecting' ? 'Connecting…' : room.status === 'refused' ? 'Not allowed in this puzzle' : held ? `${held.name} is moving a piece` : '';
    this.status.className = `conn${room.status === 'online' ? '' : ' bad'}`;
    this.knocksEl.replaceChildren(
      ...room.knocks.map((k) =>
        h(
          'div',
          { class: 'knock' },
          h('span', {}, `${k.name} wants to join`),
          h('button', { type: 'button', class: 'small primary', onclick: () => this.answer(k.id, true) }, 'Let in'),
          h('button', { type: 'button', class: 'small', onclick: () => this.answer(k.id, false) }, 'No'),
        ),
      ),
    );
    this.renderInvite();
  }

  private answer(id: string, allow: boolean): void {
    const room = this.room;
    if (!room) return;
    room.knocks = room.knocks.filter((k) => k.id !== id);
    this.refresh();
    void this.api.answerKnock(room.id, id, allow);
  }

  private toggleInvite(): void {
    this.inviteEl.hidden = !this.inviteEl.hidden;
    this.renderInvite();
  }

  private renderInvite(): void {
    if (this.inviteEl.hidden) return;
    const inv = this.invite;
    const copy = async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        this.say(`${what} copied`);
      } catch {
        this.say('Could not copy: select it and copy by hand');
      }
    };
    this.inviteEl.replaceChildren(
      ...(inv
        ? [
            h('div', { class: 'hint' }, 'Tell a friend this code, or send them the link (the link needs no one to let them in):'),
            h('div', { class: 'code' }, inv.code),
            h('input', { type: 'text', readOnly: true, value: inv.link, 'aria-label': 'Invite link', onfocus: (e: Event) => (e.target as HTMLInputElement).select() }),
            h(
              'div',
              { class: 'buttons' },
              h('button', { type: 'button', onclick: () => void copy(inv.code, 'Code') }, 'Copy code'),
              h('button', { type: 'button', class: 'primary', onclick: () => void copy(inv.link, 'Link') }, 'Copy link'),
              h('button', { type: 'button', title: 'The old code and link stop working', onclick: () => void this.renew() }, 'New code'),
            ),
          ]
        : [
            h('div', { class: 'hint' }, 'The code and link are only shown when they are made. Make new ones (the old ones stop working):'),
            h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'primary', onclick: () => void this.renew() }, 'New code and link')),
          ]),
    );
  }

  private async renew(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const res = await this.api.newInvite(room.id);
    if (res.ok) {
      this.invite = res.invite;
      this.renderInvite();
    } else this.say('Could not make a new code');
  }
}
