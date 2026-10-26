import './style.css';
import { Prefs } from './core/prefs';
import { PhotoLibrary } from './store/photos';
import { SaveStore } from './store/saves';
import { LibraryScreen } from './ui/library';
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
  const play = new PlayScreen({ prefs, photos, saves, onExit: () => showLibrary() });
  const library = new LibraryScreen({
    prefs,
    photos,
    onPlay: (entry) => {
      library.hide();
      library.el.hidden = true;
      play.el.hidden = false;
      void play.start(entry);
    },
  });
  play.el.hidden = true;
  root.append(library.el, play.el);

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
    if (!library.el.hidden && e.dataTransfer?.files.length) void library.addFiles([...e.dataTransfer.files]);
  });

  if (import.meta.env.DEV) Object.assign(window, { __play: play, __library: library });        // for poking at the game from the console while developing
  await library.load();
}

void main();
