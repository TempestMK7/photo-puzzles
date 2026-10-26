import { FocusGame, type FocusState } from '../core/focus';
import type { Rect } from '../core/layout';
import { draw, type Anim, type View } from '../render';
import { buzz, hapticToggles } from './feedback';
import type { Pt, PuzzleSession, SessionInit } from './types';

/** Focus Point: click two pieces to trade places and sizes. */
export class FocusSession implements PuzzleSession {
  readonly toggles = [
    { key: 'grid', label: 'Grid', title: 'Grid lines' },
    { key: 'animate', label: 'Animate', title: 'Swap animations' },
    ...hapticToggles(),
  ];
  readonly rotatable = false;
  private game: FocusGame;
  private anims = new Map<number, Anim>();
  private hover = -1;

  constructor(private readonly init: SessionInit) {
    this.game = new FocusGame(init.width, init.height, { seed: init.seed, pieces: init.opts.pieces, irregular: init.opts.irregular === 1 });
    if (init.restore) this.game.restore(init.restore as FocusState);
  }

  serialize(): unknown {
    return this.game.snapshot();
  }

  layout(): { width: number; height: number } {
    return { width: this.init.width, height: this.init.height };
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    return draw(ctx, this.init.source, this.game, view, this.anims, this.hover, now, this.init.flag('grid'));
  }

  pointerDown(p: Pt): void {
    const game = this.game;
    const piece = game.pieceAt(p.x, p.y);
    if (piece < 0) return;
    const before = game.slotOf.map((_, i) => game.slotRect(i));
    const result = game.click(piece);
    if (result === 'swap') {
      buzz(this.init, game.solved ? 'solved' : 'join');
      if (this.init.flag('animate')) {
        const now = performance.now();
        for (let i = 0; i < game.count; i++) {
          const to: Rect = game.slotRect(i);
          if (to !== before[i]) this.anims.set(i, { from: before[i], to, start: now });
        }
      }
    } else if (result === 'select') buzz(this.init, 'grab');
    else if (result === 'deselect') buzz(this.init, 'drop');
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    const piece = this.game.pieceAt(p.x, p.y);
    if (piece !== this.hover) {
      this.hover = piece;
      this.init.requestDraw();
    }
  }

  pointerUp(): void {}

  pointerCancel(): void {
    this.hover = -1;
  }

  secondary(): void {}

  status(): string {
    const n = this.game.swaps;
    return `${n} ${n === 1 ? 'swap' : 'swaps'}`;
  }

  get solved(): boolean {
    return this.game.solved;
  }

  settingsChanged(): void {
    if (!this.init.flag('animate')) this.anims.clear();
    this.init.requestDraw();
  }
}
