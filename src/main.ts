import './style.css';
import { Prefs } from './core/prefs';
import { PhotoLibrary } from './store/photos';
import { OnlineApi } from './online/api';
import { onlineBase } from './online/config';
import { DevIdentity } from './online/identity';
import { parseInvite } from './online/protocol';
import { WsRealtime } from './online/realtime';
import { SaveStore } from './store/saves';
import type { PhotoEntry } from './store/photos';
import { LibraryScreen } from './ui/library';
import { OnlinePanel } from './ui/online';
import { PlayScreen } from './ui/play';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const prefs = new Prefs(storage());
  const saves = new SaveStore();
  const photos = new PhotoLibrary((id) => saves.removeForPhoto(id));
  await photos.init();

  const root = document.getElementById('app')!;
  // playing with friends, in a build that knows where the server is
  const base = onlineBase();
  const identity = new DevIdentity();
  const api = base ? new OnlineApi(base, () => identity.get()) : null;
  const realtime = base ? new WsRealtime(base, () => identity.get().token) : null;
  const play = new PlayScreen({
    prefs,
    photos,
    saves,
    onExit: () => showLibrary(),
    otherPhoto: (id) => library.otherPhoto(id),
    online: api ? { api } : undefined,
    photoAdded: (id) => void library.photoAdded(id),
  });
  const panel: OnlinePanel | null =
    api && realtime
      ? new OnlinePanel({
          prefs,
          photos,
          api,
          realtime,
          identity,
          chosen: (): PhotoEntry | undefined => library.chosenPhoto,
          onPlay: (room, invite) => {
            library.hide();
            library.el.hidden = true;
            play.el.hidden = false;
            void play.startOnline(room, invite);
          },
        })
      : null;
  const library: LibraryScreen = new LibraryScreen({
    prefs,
    photos,
    saves,
    onOnline: panel ? () => panel.open() : undefined,
    onPlay: (entry) => {
      library.hide();
      library.el.hidden = true;
      play.el.hidden = false;
      void play.start(entry);
    },
  });
  play.el.hidden = true;
  root.append(library.el, play.el);
  if (panel) root.append(panel.el);

  function showLibrary(): void {
    play.el.hidden = true;
    library.el.hidden = false;
    library.show();
  }

  // pictures dropped anywhere on the main screen are added to the list
  window.addEventListener('dragover', (e) => {
    if (library.el.hidden) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (library.el.hidden || !e.dataTransfer) return;
    if (e.dataTransfer.files.length) void library.addFiles([...e.dataTransfer.files]);
    else {
      const link = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) ?? e.dataTransfer.getData('text/plain');        // a picture dragged from another web page
      if (link) void library.addLink(link);
    }
  });
  // a link (or a picture) pasted on the main screen, but not into a box that wants text
  window.addEventListener('paste', (e) => {
    const into = e.target instanceof HTMLElement && (e.target.closest('input, textarea') || e.target.isContentEditable);
    if (!library.el.hidden && !into && e.clipboardData) {
      e.preventDefault();
      library.pasted(e.clipboardData);
    }
  });

  if (import.meta.env.DEV) Object.assign(window, { __play: play, __library: library });        // for poking at the game from the console while developing
  await library.load();
  // a link to a puzzle (https://.../#/join/12345~secret) joins it
  const link = window.location.hash;
  if (panel && parseInvite(link)) {
    history.replaceState(null, '', window.location.pathname + window.location.search);        // the secret does not stay in the address bar
    void panel.join(link);
  }
}

void main();
