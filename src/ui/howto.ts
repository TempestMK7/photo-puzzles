import { hasHelp } from '../core/help';
import { findKind, type KindId } from '../core/kinds';
import { h } from './dom';

/** One line of the list of controls: what is done, with a mouse and keyboard, and on a touch screen. */
interface Control {
  what: string;
  mouse: string;
  touch: string;
}

const MOVE: Control = { what: 'Move the board', mouse: 'Drag on the bare board (or drag with the right button)', touch: 'Drag one finger on the bare board' };
const ZOOM: Control = { what: 'Zoom', mouse: 'Mouse wheel, or the − and + buttons at the bottom right (click the number to show everything)', touch: 'Pinch with two fingers' };
const ORIGINAL: Control = { what: 'See the whole picture', mouse: 'The Show Photo (or Show Video) button at the top opens a window with the original', touch: 'The same button at the top' };
const HINT: Control = { what: 'Use a hint', mouse: 'Press Hint at the top, then click a piece: it goes where it belongs (Esc cancels)', touch: 'Tap Hint, then tap a piece' };
const BOMB: Control = { what: 'Use a bomb', mouse: 'Press Bomb at the top, then click a spot: the pieces around it go where they belong (Esc cancels)', touch: 'Tap Bomb, then tap a spot' };
const VIDEO: Control = { what: 'Control a video', mouse: 'The bar under the board pauses it, moves through it and turns the sound on and off; Duration picks the part that plays over and over', touch: 'The same bar' };

const CONTROLS: Record<KindId, Control[]> = {
  focus: [{ what: 'Swap two pieces', mouse: 'Click one piece, then click another', touch: 'Tap one piece, then tap another' }],
  overlap: [
    { what: 'Place a piece', mouse: 'Drag the top piece of a stack onto the board, centre square first', touch: 'Drag it with a finger (it rides above your finger so you can see where it goes)' },
    { what: 'Turn a piece', mouse: 'Click it without dragging, or press R or the right button (while carrying it, or over its stack)', touch: 'Tap it, or touch a second finger on the screen while carrying it' },
    { what: 'Move a piece to another stack', mouse: 'Drag it onto that stack', touch: 'Drag it onto that stack' },
    { what: 'Scroll the stacks', mouse: 'Mouse wheel over the panel at the left, or hold a piece near its top or bottom edge', touch: 'Drag the empty part of the panel, or hold a piece near its top or bottom edge' },
  ],
  strips: [
    { what: 'Place a strip', mouse: 'Drag it into its hole: it locks when it lies exactly there, the right way up', touch: 'Drag it with a finger' },
    { what: 'Turn a strip', mouse: 'Click it without dragging, or press R or the right button', touch: 'Tap it, or touch a second finger on the screen while carrying it' },
    { what: 'Change tab', mouse: 'Click a tab, or press 1 to 9 and 0; drag a strip onto a tab to move it there', touch: 'Tap a tab; drag a strip onto a tab to move it there' },
  ],
  jigsaw: [
    { what: 'Move a piece', mouse: 'Drag it. Put it against a piece it belongs beside and it joins (joined pieces move together)', touch: 'Drag it with a finger (it rides above your finger)' },
    { what: 'Select a piece', mouse: 'Click it: it glows', touch: 'Tap it' },
    { what: 'Turn a piece (when turned pieces are on)', mouse: 'Select it and press R, the Rotate button or the right button; or do that while carrying it', touch: 'Select it and press the Rotate button, or touch a second finger on the screen while carrying it' },
    { what: 'Move the table', mouse: 'Right-drag, or drag on bare ground', touch: 'Drag one finger on bare ground (two fingers zoom and move it)' },
  ],
  sliding: [{ what: 'Slide tiles', mouse: 'Click a tile in the empty space’s row or column: it and the tiles between slide over', touch: 'Tap a tile in the empty space’s row or column' }],
  rotascope: [{ what: 'Slide a piece', mouse: 'Click a piece that touches the empty space', touch: 'Tap a piece that touches the empty space' }],
};

const RULES: Record<KindId, string[]> = {
  focus: [
    'The picture is cut into rectangles of different sizes and shuffled. Swap two pieces and they trade places and sizes. Put every piece back where it belongs.',
    'A piece that is in its right place locks there and cannot be moved again.',
  ],
  overlap: [
    'The board is a grid like a checkerboard. Every piece has a centre square of its own and some squares around it that other pieces share, so pieces overlap. The pieces wait in stacks down the left side.',
    'Drag the top piece onto the board, centre square first, turned the way it lies in the picture. If it is right it stays and shows its part of the picture; if not it goes back to its stack.',
    'Some pieces have a window that shows a bit of the background pattern from where the piece belongs, as a clue.',
  ],
  strips: [
    'The picture is cut into straight strips that lie scattered and turned over several tabs. Drag each strip into its hole, turned the right way. It locks when it is exactly right.',
    'Every strip covers at least one square that no other strip does, so its place is certain.',
  ],
  jigsaw: [
    'Classic interlocking pieces on a big table. The four corners start in place. Put a loose piece against a piece it belongs beside and it joins; anything that joins a piece in place becomes part of the picture.',
    'With turned pieces on, pieces only join when they are turned the same way, and only upright pieces join the picture.',
  ],
  sliding: [
    'The picture is cut into tiles and one is missing. Slide tiles into the empty space until the picture is whole again; the missing tile appears when you have solved it.',
    'The puzzle can always be solved.',
  ],
  rotascope: [
    'A round picture is cut into rings of wedges round an empty middle. Slide pieces into the empty space; a piece grows or shrinks and turns as it passes between rings.',
    'The picture is whole again when every piece is home.',
  ],
};

const HELP_RULES = 'Hints and bombs: a hint places one piece for you; a bomb places all the pieces around a spot. You earn hints by solving puzzles, and the Inventory says how to get more (including watching an ad).';

/** The controls of a puzzle type: its own first, then the ones that every board shares, then the ones for hints and bombs where it has them. */
export function controlsOf(kind: KindId): Control[] {
  return [...CONTROLS[kind], MOVE, ZOOM, ...(hasHelp(kind) ? [HINT, BOMB] : []), ORIGINAL, VIDEO];
}

export function rulesOf(kind: KindId): string[] {
  return [...RULES[kind], ...(hasHelp(kind) ? [HELP_RULES] : [])];
}

/** Opens the How To Play window for a type of puzzle over whatever screen is showing. `closed` is called when it is put away. */
export function openHowTo(kind: KindId, closed: () => void = () => {}): void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = (): void => {
    window.removeEventListener('keydown', onKey, true);
    root.remove();
    previous?.focus();
    closed();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  const table = h(
    'table',
    { class: 'controls' },
    h('thead', {}, h('tr', {}, h('th', {}, 'To…'), h('th', {}, 'Mouse and keyboard'), h('th', {}, 'Touch screen'))),
    h('tbody', {}, ...controlsOf(kind).map((c) => h('tr', {}, h('th', { scope: 'row' }, c.what), h('td', { dataset: { label: 'Mouse' } }, c.mouse), h('td', { dataset: { label: 'Touch' } }, c.touch)))),
  );
  const root = h(
    'div',
    { class: 'inprogress howto-dialog', role: 'dialog', 'aria-label': 'How To Play', onclick: (e: Event) => (e.target === root ? close() : undefined) },
    h(
      'div',
      { class: 'card' },
      h('header', {}, h('h2', {}, `How To Play: ${findKind(kind)?.name ?? ''}`), h('button', { type: 'button', onclick: close }, 'Close')),
      h('div', { class: 'body' }, h('h3', {}, 'Controls'), table, h('h3', {}, 'The rules'), ...rulesOf(kind).map((p) => h('p', {}, p))),
    ),
  );
  window.addEventListener('keydown', onKey, true);
  document.body.append(root);
  root.querySelector<HTMLElement>('button')?.focus();
}
