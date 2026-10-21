import { FocusGame } from './core/focus';
import { randomSeedText, seedFromText } from './core/rng';
import { loadPhoto, samplePhoto } from './image';
import { draw, fitView, type Anim, type View } from './render';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('board');
const ctx = canvas.getContext('2d')!;
const piecesInput = $<HTMLInputElement>('pieces');
const piecesOut = $<HTMLOutputElement>('piecesOut');
const irregularInput = $<HTMLInputElement>('irregular');
const seedInput = $<HTMLInputElement>('seed');
const statusEl = $<HTMLElement>('status');

let photo: HTMLCanvasElement = samplePhoto();
let game: FocusGame;
let view: View = { scale: 1, ox: 0, oy: 0 };
let hover = -1;
const anims = new Map<number, Anim>();
let frame = 0;

function newPuzzle(): void {
  const seedText = seedInput.value.trim() || randomSeedText();
  seedInput.value = seedText.toUpperCase();
  game = new FocusGame(photo.width, photo.height, {
    seed: seedFromText(seedInput.value),
    pieces: Number(piecesInput.value),
    irregular: irregularInput.checked,
  });
  anims.clear();
  hover = -1;
  updateStatus();
  requestDraw();
}

function updateStatus(): void {
  statusEl.textContent = game.solved ? `Solved in ${game.swaps} swaps!` : `${game.count} pieces · ${game.swaps} swaps`;
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  view = fitView(photo.width, photo.height, w, h, 12 * dpr);
  requestDraw();
}

function requestDraw(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

function render(now: number): void {
  frame = 0;
  if (!game) return;
  if (draw(ctx, photo, game, view, anims, hover, now)) requestDraw();
}

function pieceAtEvent(e: PointerEvent): number {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / r.width;
  const x = ((e.clientX - r.left) * dpr - view.ox) / view.scale;
  const y = ((e.clientY - r.top) * dpr - view.oy) / view.scale;
  return game.pieceAt(x, y);
}

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const h = pieceAtEvent(e);
  if (h !== hover) {
    hover = h;
    requestDraw();
  }
});
canvas.addEventListener('pointerleave', () => {
  hover = -1;
  requestDraw();
});
canvas.addEventListener('pointerdown', (e) => {
  const p = pieceAtEvent(e);
  if (p < 0) return;
  const before = game.slotOf.map((_, i) => game.slotRect(i));
  const what = game.click(p);
  if (what === 'swap') {
    const now = performance.now();
    for (let i = 0; i < game.count; i++) {
      const to = game.slotRect(i);
      if (to !== before[i]) anims.set(i, { from: before[i], to, start: now });
    }
    updateStatus();
  }
  requestDraw();
});

async function useFile(file: Blob): Promise<void> {
  try {
    photo = await loadPhoto(file);
    resize();
    newPuzzle();
  } catch {
    statusEl.textContent = 'That file could not be read as a picture.';
  }
}

$('open').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void useFile(f);
});
piecesInput.addEventListener('input', () => {
  piecesOut.value = piecesInput.value;
});
piecesInput.addEventListener('change', newPuzzle);
irregularInput.addEventListener('change', newPuzzle);
seedInput.addEventListener('change', newPuzzle);
$('reroll').addEventListener('click', () => {
  seedInput.value = randomSeedText();
  newPuzzle();
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files[0];
  if (f && f.type.startsWith('image/')) void useFile(f);
});

new ResizeObserver(resize).observe(canvas);
seedInput.value = randomSeedText();
newPuzzle();
resize();
