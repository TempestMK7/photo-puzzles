import type { KindId } from '../core/kinds';

// One small icon per puzzle type, drawn in code (no image files). 48 x 48, currentColor.
const BOX = 'viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"';

export const KIND_ICONS: Record<KindId, string> = {
  // rings of wedges round a hole
  rotascope: `<svg ${BOX}><circle cx="24" cy="24" r="19"/><circle cx="24" cy="24" r="11"/><circle cx="24" cy="24" r="4"/><path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.6 10.6l4.2 4.2M33.2 33.2l4.2 4.2M37.4 10.6l-4.2 4.2M14.8 33.2l-4.2 4.2"/></svg>`,
  // rectangles of different sizes
  focus: `<svg ${BOX}><rect x="5" y="5" width="22" height="20"/><rect x="27" y="5" width="16" height="12"/><rect x="27" y="17" width="16" height="26"/><rect x="5" y="25" width="10" height="18"/><rect x="15" y="25" width="12" height="18"/></svg>`,
  // two overlapping tiles
  overlap: `<svg ${BOX}><rect x="5" y="5" width="25" height="25"/><rect x="18" y="18" width="25" height="25"/></svg>`,
  // long strips that cross
  strips: `<svg ${BOX}><rect x="5" y="9" width="38" height="8"/><rect x="5" y="31" width="38" height="8"/><rect x="15" y="4" width="8" height="40"/></svg>`,
  // a jigsaw piece
  jigsaw: `<svg ${BOX}><path d="M6 12h12a5 5 0 1 1 10 0h14v12a5 5 0 1 0 0 10v10H28a5 5 0 1 0-10 0H6z"/></svg>`,
  // a 3 x 3 grid with the last tile missing
  sliding: `<svg ${BOX}><rect x="5" y="5" width="11" height="11"/><rect x="18.5" y="5" width="11" height="11"/><rect x="32" y="5" width="11" height="11"/><rect x="5" y="18.5" width="11" height="11"/><rect x="18.5" y="18.5" width="11" height="11"/><rect x="32" y="18.5" width="11" height="11"/><rect x="5" y="32" width="11" height="11"/><rect x="18.5" y="32" width="11" height="11"/></svg>`,
};

/** The icons of the hint and the bomb: on their buttons in the play screen (currentColor), and in the cursors (style.css draws the same shapes with colours of their own). */
const SMALL = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
export const HELP_ICONS = {
  hint: `<svg ${SMALL}><circle cx="12" cy="12" r="10"/><path d="M9.2 9.3a2.9 2.9 0 1 1 4.2 2.6c-.9.5-1.4 1.1-1.4 2.1"/><path d="M12 17.2h.01"/></svg>`,
  bomb: `<svg ${SMALL}><circle cx="11" cy="14" r="7"/><path d="M16 8l2-2M18 3v2M21 6h-2"/></svg>`,
};
