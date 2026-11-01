import type { HelpKind } from '../core/help';
import type { Command, RoomEvent, RoomState } from '../core/jigsawRoom';
import type { HandMessage } from '../online/protocol';
import type { View } from '../render';

export interface Pt {
  x: number;
  y: number;
}

/** What a puzzle played with friends needs from the room it is in (see online/room.ts). */
export interface OnlineHooks {
  /** The name of another player who holds a piece, if one does: nothing can be picked up meanwhile. */
  blockedBy(): string | null;
  /** The player did this to the board (already applied here), or chose a piece, or let their choice go: send it to the room. */
  send(op: Command): void;
  /** The pieces that other players have chosen, with their names: nobody else may pick one up or turn it (a piece of each group). */
  reserved(): { by: string; name: string; piece: number }[];
  /** Where the piece in hand is; the room passes it on a few times a second. */
  hand(pose: Omit<HandMessage, 'n'>): void;
  /** A piece (one of its group) is in hand, or let go: the hold has to be kept alive while it lasts. */
  holding(piece: number | null): void;
  /** Tell the player why something did not happen. */
  notify(text: string): void;
  /** The colour (CSS) a player's piece in hand glows in. */
  colorOf(id: string): string;
}

export interface SessionInit {
  /**
   * What the pieces are cut from: a picture, or - when the puzzle is made from a video - a canvas that holds the video's current picture (the play screen copies each new
   * picture into it once, so drawing a piece costs a canvas draw and not a video-frame copy, which is slow on a slow device).
   */
  source: CanvasImageSource;
  /** The video itself, when the puzzle is made from one: for a session that takes the frames to the graphics card by itself. */
  video?: HTMLVideoElement;
  width: number;
  height: number;
  /** Seed of this puzzle (already mixed with the photo and the type). */
  seed: number;
  /** The difficulty options of the type, by key. */
  opts: Record<string, number>;
  /** A setting of the settings window (grid lines, animations...): on unless the player turned it off. */
  flag(key: string): boolean;
  requestDraw(): void;
  /** The session changed the tab by itself (a dragged piece rested on a tab): the tab bar should be refreshed. */
  tabsChanged?(): void;
  /** What `serialize` gave when this puzzle was left: the session puts it back (and throws if it does not fit). */
  restore?: unknown;
  /** The session changed the game by itself, not because of a pointer event (a timer): the progress text and the end of the puzzle should be looked at again. */
  progress?(): void;
  /** Set when the puzzle is shared with other players. */
  online?: OnlineHooks;
  /** The sorting trays changed (one was made or taken away, a piece went in or out): the list of them should be looked at again. */
  traysChanged?(): void;
}

/** One puzzle being played. The play screen owns the canvas, the clock and the dialogs; a session owns the rules, the layout and the drawing. */
export interface PuzzleSession {
  /** Show a Rotate button (and use the secondary action to turn pieces). */
  readonly rotatable: boolean;
  /** The size of the board in its own units for a canvas of this shape (a session may lay itself out differently on a phone held upright). */
  layout(canvasW: number, canvasH: number): { width: number; height: number };
  /** Clears and draws the canvas. Returns true while something is still moving. */
  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean;
  /** `touch`: a finger (and not a mouse or a pen) pressed: a session may then hold the piece where a finger does not cover it. */
  pointerDown(p: Pt, touch?: boolean): void;
  pointerMove(p: Pt): void;
  pointerUp(p: Pt): void;
  pointerCancel(): void;
  /** Right click, a second finger, the Rotate button, the R key: turn the piece in hand (or the chosen one). */
  secondary(): void;
  /** Everything that has to be kept to carry on later, as plain data (JSON-able); the rest follows from the seed. */
  serialize(): unknown;
  /** A canvas the session draws on itself, shown over the board's (and the same size): the play screen puts it in the page. */
  readonly overlay?: HTMLCanvasElement;
  /** A transparent canvas of the session's, shown over the overlay (and the same size): what has to lie over the pieces drawn there. */
  readonly front?: HTMLCanvasElement;
  /** The video the puzzle is cut from shows a new picture: redraw only what depends on it (the board underneath did not change). Without this the whole board is drawn. */
  videoFrame?(now: number): void;
  /** The session is being replaced or left: let go of anything held on the graphics card. */
  dispose?(): void;
  /** The progress text for the header ("3 swaps", "5 / 12 placed"). */
  status(): string;
  readonly solved: boolean;
  /** A setting changed (a display switch). */
  settingsChanged(): void;
  /** Sorting trays (a puzzle that has them): the list, with how many pieces lie in each and which one is open on this screen. */
  trays?(): { id: number; pieces: number; open: boolean }[];
  /** Opens a tray on this screen (and closes the one that was open), or closes it (-1). */
  openTray?(id: number): void;
  addTray?(): void;
  removeTray?(id: number): void;
  /** Where the open tray lies, in CSS pixels of the canvas, and how tall its header is (the page puts the tray's title and buttons there); nothing when none is open. */
  trayPanel?(): { x: number; y: number; w: number; h: number; header: number; id: number; pieces: number } | null;
  /** Tabs (pages) of the board, when the puzzle has more than one: how many loose pieces each holds, and which one is showing. */
  tabInfo?(): { counts: number[]; active: number } | null;
  selectTab?(tab: number): void;
  /** The pointer, while a piece is being dragged, is over this tab's button (-1: over none). */
  dragOverTab?(tab: number): void;

  // Hints and bombs (Tile Swap, Overlap, Strips and Jigsaw: see core/help.ts). `p` is a board point, as for `pointerDown`.
  /** Whether a hint (on the piece under `p`) or a bomb (dropped at `p`) would place anything: the game asks before it spends one. */
  canHelp?(kind: HelpKind, p: Pt): boolean;
  /** Places the piece, or the pieces round the point, and (played with friends) sends the operation to the room. */
  help?(kind: HelpKind, p: Pt): void;

  // A board with a camera (Jigsaw): the session picks the view itself instead of fitting the whole board on the canvas.
  /** The view for a canvas of this size (in canvas pixels). */
  view?(canvasW: number, canvasH: number): View;
  /** Mouse wheel over the board point `at`. */
  wheel?(at: Pt, deltaY: number): void;
  /** Two fingers: what was under `from` (canvas pixels) is now under `to`, and the board is `factor` times bigger. */
  pinch?(from: Pt, to: Pt, factor: number): void;
  /** A piece is in hand: a second finger then turns it (`secondary`) instead of starting a pinch. */
  holding?(): boolean;
  /** The right button, pressed on the board / dragged / let go; used instead of `secondary` when present. */
  rightDown?(p: Pt): void;
  rightMove?(p: Pt): void;
  rightUp?(p: Pt): void;
  /** The zoom control: zoom in or out by a factor about the middle of the screen, show everything, and the text that tells the zoom. */
  zoomBy?(factor: number): void;
  zoomFit?(): void;
  zoomLabel?(): string;

  // A puzzle shared with other players (Jigsaw): what they did is applied here. These are what the room (online/room.ts) calls.
  /** Another player's operation. */
  applyEvent?(event: RoomEvent): void;
  /** Take the room's board instead of this one. */
  resync?(state: RoomState): void;
  /** Where the piece another player holds is now (`null`: it is let go). */
  hand?(by: string, pose: HandMessage | null): void;
  groupCount?(): number;
}

export type SessionFactory = (init: SessionInit) => PuzzleSession;
