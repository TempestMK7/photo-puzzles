import type { OnlineApi } from '../online/api';
import type { AccountNotice } from '../online/protocol';
import type { OnlineSession } from '../online/session';
import type { PhotoLibrary } from '../store/photos';
import { h } from './dom';

/**
 * What the server wants the player told (see `AccountNotice`): shown in a window the next time the game is open with the account signed in, and acknowledged when the player presses OK, so
 * that it is not shown again. A notice that names a file also puts it with the photo or video that it was sent from, so that the next puzzle from that file needs no check.
 */
export class NoticesUi {
  readonly dialog: HTMLElement;
  private readonly body = h('div', { class: 'body' });
  private shown = new Set<string>();

  constructor(
    private readonly identity: OnlineSession,
    private readonly api: Pick<OnlineApi, 'ackNotices'>,
    private readonly photos: Pick<PhotoLibrary, 'setServerFile'>,
  ) {
    this.dialog = h(
      'div',
      { class: 'inprogress notices-dialog', role: 'dialog', 'aria-label': 'Message', hidden: true },
      h('div', { class: 'card' }, h('header', {}, h('h2', {}, 'A message for you')), this.body, h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'primary', onclick: () => void this.ok() }, 'OK'))),
    );
    identity.onChange(() => void this.check());
  }

  private current(): AccountNotice[] {
    return this.identity.kind() === 'account' ? this.identity.summary().notices ?? [] : [];
  }

  private async check(): Promise<void> {
    const fresh = this.current().filter((n) => !this.shown.has(n.id));
    if (!fresh.length || !this.dialog.hidden) return;
    for (const n of fresh) {
      this.shown.add(n.id);
      if (n.fileId && n.sourceId) await this.photos.setServerFile(n.sourceId, n.fileId);
    }
    this.body.replaceChildren(...fresh.map((n) => h('p', {}, n.text)));
    this.dialog.dataset.ids = fresh.map((n) => n.id).join(',');
    this.dialog.hidden = false;
  }

  private async ok(): Promise<void> {
    const ids = (this.dialog.dataset.ids ?? '').split(',').filter(Boolean);
    this.dialog.hidden = true;
    const res = await this.api.ackNotices(ids);
    if (res.ok) this.identity.setSummary(res.account);
    else for (const id of ids) this.shown.delete(id);                       // (could not tell the server: shown again the next time)
  }
}
