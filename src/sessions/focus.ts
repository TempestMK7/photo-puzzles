import { FocusGame, type FocusState } from '../core/focus';
import type { Rect } from '../core/layout';
import { draw, SWAP_MS, type Anim, type View } from '../render';
import { Ripples } from './ripple';
import { playEffect } from '../sounds';
import { buzz } from './feedback';
import type { Pt, PuzzleSession, SessionInit } from './types';

/** Tile Swap: click two pieces to trade places and sizes. */
export class FocusSession implements PuzzleSession {
  readonly rotatable = false;
  private game: FocusGame;
  private anims = new Map<number, Anim>();
  private hover = -1;
  private ripples = new Ripples();

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
    const moving = draw(ctx, this.init.source, this.game, view, this.anims, this.hover, now, this.init.flag('grid'));
    return this.ripples.draw(ctx, now) || moving;
  }

  pointerDown(p: Pt): void {
    const game = this.game;
    const piece = game.pieceAt(p.x, p.y);
    if (piece < 0) return;
    const before = game.slotOf.map((_, i) => game.slotRect(i));
    const wasPlaced = game.slotOf.map((_, i) => game.placed(i));
    const result = game.click(piece);
    if (result === 'swap') {
      buzz(this.init, game.solved ? 'solved' : 'join');
      const now = performance.now();
      let found = false;
      game.homes.forEach((home, i) => {                                                    // a piece that has just found its place gets a ripple once it arrives
        if (game.placed(i) && !wasPlaced[i]) {
          this.ripples.add([home], now, this.init.flag('animate') ? SWAP_MS : 0);
          found = true;
        }
      });
      if (!game.solved) playEffect(found ? 'placed' : 'pickup');                         // (the end of the puzzle has its own sound)
      if (this.init.flag('animate')) {
        for (let i = 0; i < game.count; i++) {
          const to: Rect = game.slotRect(i);
          if (to !== before[i]) this.anims.set(i, { from: before[i], to, start: now });
        }
      }
    } else if (result === 'select') {
      buzz(this.init, 'grab');
      playEffect('select');
    }
    else if (result === 'deselect') buzz(this.init, 'drop');
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    let piece = this.game.pieceAt(p.x, p.y);
    if (piece >= 0 && this.game.placed(piece)) piece = -1;                  // a locked piece is not offered
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
