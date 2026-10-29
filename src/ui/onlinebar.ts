import type { OnlineApi } from '../online/api';
import { PLAYER_COLORS } from '../online/config';
import type { Invite } from '../online/protocol';
import type { OnlineRoom } from '../online/room';
import { h } from './dom';
import { qrSvg } from './qr';

/**
 * What a puzzle played with friends shows over the board: who is in it (and who is connected), whether the connection is up, a short message ("Ann is moving a piece"),
 * players waiting to be let in, and for the one who made it the invite (the code, the link, a QR code, sharing) and the list of players, with a way to send one out.
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
  private qrShown = false;
  /** The QR code is made once for a link, not again at every change of the room. */
  private qr: { link: string; el: SVGSVGElement | null } | null = null;
  /** The player whom the owner has clicked "Remove" for and has not yet said yes to. */
  private confirming: string | null = null;

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
    this.qrShown = false;
    this.confirming = null;
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
    const room = this.room;
    const copy = async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        this.say(`${what} copied`);
      } catch {
        this.say('Could not copy: select it and copy by hand');
      }
    };
    // the share sheet of the phone or the browser, where there is one (a cancelled one is not an error)
    const share = (i: Invite) => void navigator.share({ title: 'PuzzleVidio', text: `Join my puzzle with the code ${i.code}, or with this link:`, url: i.link }).catch(() => undefined);
    const parts: (Node | null)[] = [
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
              typeof navigator.share === 'function' ? h('button', { type: 'button', onclick: () => share(inv) }, 'Share…') : null,
              h('button', { type: 'button', 'aria-expanded': String(this.qrShown), title: 'For a friend who is next to you: they point the camera of a phone at it', onclick: () => this.toggleQr() }, this.qrShown ? 'Hide QR code' : 'QR code'),
              h('button', { type: 'button', title: 'The old code and link stop working', onclick: () => void this.renew() }, 'New code'),
            ),
            this.qrShown ? this.qrBox(inv) : null,
          ]
        : [
            h('div', { class: 'hint' }, 'The code and link are only shown when they are made. Make new ones (the old ones stop working):'),
            h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'primary', onclick: () => void this.renew() }, 'New code and link')),
          ]),
      room ? this.playersEl(room) : null,
    ];
    this.inviteEl.replaceChildren(...parts.filter((p): p is Node => !!p));
  }

  private toggleQr(): void {
    this.qrShown = !this.qrShown;
    this.renderInvite();
  }

  /** The QR code of the link, made when it is first shown (and again for a new link). */
  private qrBox(inv: Invite): HTMLElement {
    const box = h('div', { class: 'qr' });
    if (this.qr?.link === inv.link && this.qr.el) {
      box.append(this.qr.el);
      return box;
    }
    box.textContent = 'Making the code…';
    const mine = { link: inv.link, el: null as SVGSVGElement | null };
    this.qr = mine;
    qrSvg(inv.link, 'QR code of the invite link').then(
      (el) => {
        mine.el = el;
        if (this.qr === mine && this.qrShown) this.renderInvite();
      },
      () => (box.textContent = 'Could not make the QR code.'),
    );
    return box;
  }

  /** Who is in the puzzle, with a way for its owner to send one out (asking once more first: it cannot be taken back, though they can come in again with the link). */
  private playersEl(room: OnlineRoom): HTMLElement {
    const owner = room.descriptor.owner === room.me;
    return h(
      'div',
      { class: 'players' },
      h('div', { class: 'hint' }, 'Players'),
      ...room.members.map((m) => {
        const you = m.id === room.me;
        const asked = this.confirming === m.id;
        return h(
          'div',
          { class: 'player' },
          h('i', { style: `background:${PLAYER_COLORS[m.color % PLAYER_COLORS.length]}` }),
          h('span', { class: 'who' }, you ? `${m.name} (you)` : m.name),
          room.online.has(m.id) || you ? h('span', { class: 'here' }, 'here') : null,
          owner && !you
            ? asked
              ? h(
                  'span',
                  { class: 'ask' },
                  h('button', { type: 'button', class: 'small primary', onclick: () => void this.remove(m.id, m.name) }, 'Send out'),
                  h('button', { type: 'button', class: 'small', onclick: () => ((this.confirming = null), this.renderInvite()) }, 'Cancel'),
                )
              : h('button', { type: 'button', class: 'small', 'aria-label': `Send ${m.name} out of the puzzle`, onclick: () => ((this.confirming = m.id), this.renderInvite()) }, 'Remove')
            : null,
        );
      }),
    );
  }

  private async remove(id: string, name: string): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.confirming = null;
    const res = await this.api.removeMember(room.id, id);
    if (res.ok) {
      room.members = room.members.filter((m) => m.id !== id);
      room.online.delete(id);
      this.say(`${name} was sent out. If they still have the link or the code, make a new one.`, 8000);
      this.refresh();
    } else {
      this.say(res.error === 'not-found' ? `${name} has gone already.` : 'Could not send them out.');
      this.renderInvite();
    }
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
