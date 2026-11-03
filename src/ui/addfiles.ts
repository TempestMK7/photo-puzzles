import { nameFromLink, parseLink } from '../store/link';
import { h } from './dom';

export interface AddFilesDeps {
  /** Opens the system's file browser (the dialog has closed by then). */
  browse(): void;
  /** Downloads the file a link points to, telling `onStatus` how far it is; throws an Error whose message can be shown as it is. */
  download(url: URL, onStatus: (text: string) => void, signal: AbortSignal): Promise<File>;
  /** Puts a file in the player's library (it takes its turn with everything else that is being added or removed). */
  add(file: File): Promise<void>;
}

/** A download that has been asked for: what it is, how it stands, and (while it runs) the way to stop it. */
interface Job {
  name: string;
  status: string;
  abort: AbortController | null;
  /** It has ended: added, stopped or failed. */
  over: boolean;
  failed: boolean;
}

/**
 * The window that Add Files opens: add files from the system's file browser (which closes the window), or paste a link and add from that. A link does not close the window: each
 * one gets a line with how its download stands, and the player can start the next while the others go on.
 */
export class AddFilesDialog {
  readonly el: HTMLElement;
  private readonly input = h('input', {
    type: 'url',
    class: 'link',
    placeholder: 'Paste a link to a photo or video',
    spellcheck: false,
    autocapitalize: 'off',
    'aria-label': 'Link to a photo or video',
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') this.addLink(this.input.value);
    },
  });
  private readonly note = h('p', { class: 'note', role: 'status' });
  private readonly list = h('ul', { class: 'jobs' });
  private jobs: Job[] = [];

  constructor(private readonly deps: AddFilesDeps) {
    this.el = h(
      'div',
      { class: 'inprogress add-dialog', role: 'dialog', 'aria-label': 'Add Files', hidden: true, onclick: (e: Event) => (e.target === this.el ? this.close() : undefined) },
      h(
        'div',
        { class: 'card' },
        h('header', {}, h('h2', {}, 'Add Files'), h('button', { type: 'button', class: 'close', onclick: () => this.close() }, 'Close')),
        h(
          'div',
          { class: 'body' },
          h('button', { type: 'button', class: 'primary', onclick: () => this.browse() }, 'Add From My Device'),
          h('p', { class: 'or' }, 'or paste a link to a photo or video:'),
          h('div', { class: 'linkrow' }, this.input, h('button', { type: 'button', onclick: () => this.addLink(this.input.value) }, 'Add From Link')),
          this.note,
          this.list,
          h('p', { class: 'dim' }, 'Files are kept on this device only. A link is downloaded here, and nothing is sent to our server.'),
        ),
      ),
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Opens the window; the downloads that have ended since it was last open are cleared away. */
  open(): void {
    this.jobs = this.jobs.filter((j) => !j.over);
    this.note.textContent = '';
    this.render();
    this.el.hidden = false;
    this.input.focus();
  }

  close(): void {
    this.el.hidden = true;
  }

  private browse(): void {
    this.close();
    this.deps.browse();
  }

  /** Starts downloading what a link points to, and adding it. The window stays open, and the box is empty for the next link. */
  addLink(text: string): void {
    const url = parseLink(text);
    if (!url) {
      this.note.textContent = text.trim() ? 'That is not a web address.' : 'Paste a link first.';
      return;
    }
    this.note.textContent = '';
    this.input.value = '';
    const job: Job = { name: nameFromLink(url, ''), status: 'Downloading…', abort: new AbortController(), over: false, failed: false };
    this.jobs.push(job);
    this.render();
    void this.run(job, url);
    this.input.focus();
  }

  private async run(job: Job, url: URL): Promise<void> {
    const signal = job.abort!.signal;
    try {
      const file = await this.deps.download(url, (text) => this.update(job, text), signal);
      job.abort = null;
      this.update(job, 'Adding…');
      await this.deps.add(file);
      job.status = 'Added';
    } catch (e) {
      job.failed = !signal.aborted;
      job.status = signal.aborted ? 'Stopped' : e instanceof Error ? e.message : 'Could not download that.';
    }
    job.abort = null;
    job.over = true;
    this.render();
  }

  private update(job: Job, text: string): void {
    job.status = text;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.jobs.map((j) =>
        h(
          'li',
          { class: `job${j.failed ? ' failed' : ''}${j.over ? ' over' : ''}` },
          h('span', { class: 'name', title: j.name }, j.name),
          h('span', { class: 'status', role: 'status' }, j.status),
          j.abort
            ? h('button', { type: 'button', class: 'small', onclick: () => j.abort?.abort() }, 'Stop')
            : h('button', { type: 'button', class: 'small', 'aria-label': `Remove ${j.name} from the list`, onclick: () => this.dismiss(j) }, '×'),
        ),
      ),
    );
  }

  private dismiss(job: Job): void {
    this.jobs = this.jobs.filter((j) => j !== job);
    this.render();
  }
}
