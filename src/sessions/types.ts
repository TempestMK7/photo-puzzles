import type { View } from '../render';

export interface Pt {
  x: number;
  y: number;
}

export interface ToggleDef {
  key: string;
  label: string;
  title: string;
}

export interface SessionInit {
  /** What the pieces are cut from: a picture or a playing video. */
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Seed of this puzzle (already mixed with the photo and the type). */
  seed: number;
  /** The difficulty options of the type, by key. */
  opts: Record<string, number>;
  /** A display setting (grid lines, animations): on unless the player turned it off. */
  flag(key: string): boolean;
  requestDraw(): void;
  /** The session changed the tab by itself (a dragged piece rested on a tab): the tab bar should be refreshed. */
  tabsChanged?(): void;
}

/** One puzzle being played. The play screen owns the canvas, the clock and the dialogs; a session owns the rules, the layout and the drawing. */
export interface PuzzleSession {
  /** Display switches shown in the header. */
  readonly toggles: ToggleDef[];
  /** Show a Rotate button (and use the secondary action to turn pieces). */
  readonly rotatable: boolean;
  /** The size of the board in its own units for a canvas of this shape (a session may lay itself out differently on a phone held upright). */
  layout(canvasW: number, canvasH: number): { width: number; height: number };
  /** Clears and draws the canvas. Returns true while something is still moving. */
  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean;
  pointerDown(p: Pt): void;
  pointerMove(p: Pt): void;
  pointerUp(p: Pt): void;
  pointerCancel(): void;
  /** Right click, a second finger, the Rotate button, the R key: turn the piece in hand (or the chosen one). */
  secondary(): void;
  /** The progress text for the header ("3 swaps", "5 / 12 placed"). */
  status(): string;
  readonly solved: boolean;
  /** A setting changed (a display switch). */
  settingsChanged(): void;
  /** Tabs (pages) of the board, when the puzzle has more than one: how many loose pieces each holds, and which one is showing. */
  tabInfo?(): { counts: number[]; active: number } | null;
  selectTab?(tab: number): void;
  /** The pointer, while a piece is being dragged, is over this tab's button (-1: over none). */
  dragOverTab?(tab: number): void;

  // A board with a camera (Jigsaw): the session picks the view itself instead of fitting the whole board on the canvas.
  /** The view for a canvas of this size (in canvas pixels). */
  view?(canvasW: number, canvasH: number): View;
  /** Mouse wheel over the board point `at`. */
  wheel?(at: Pt, deltaY: number): void;
  /** Two fingers: what was under `from` (canvas pixels) is now under `to`, and the board is `factor` times bigger. */
  pinch?(from: Pt, to: Pt, factor: number): void;
  /** The right button, pressed on the board / dragged / let go; used instead of `secondary` when present. */
  rightDown?(p: Pt): void;
  rightMove?(p: Pt): void;
  rightUp?(p: Pt): void;
  /** The zoom control: zoom in or out by a factor about the middle of the screen, show everything, and the text that tells the zoom. */
  zoomBy?(factor: number): void;
  zoomFit?(): void;
  zoomLabel?(): string;
  /** The pieces are cut from a still copy of the source, so a video is paused and its controls hidden. */
  readonly stillSource?: boolean;
}

export type SessionFactory = (init: SessionInit) => PuzzleSession;
