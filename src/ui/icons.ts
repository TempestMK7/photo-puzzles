import type { KindId } from '../core/kinds';

// One small icon per puzzle type, drawn in code (no image files). 48 x 48, currentColor.
const BOX = 'viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"';

export const KIND_ICONS: Record<KindId, string> = {
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
