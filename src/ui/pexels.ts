import { pexelsUrl } from '../online/protocol';
import type { StockCredit } from '../store/stock';
import { h, svg } from './dom';

/** The address that every use of the library links to (Pexels asks for a prominent link to it). */
export const PEXELS_HOME = 'https://www.pexels.com/';

/** A small mark for Pexels, drawn here (a green square with a P): it says where a picture or video came from. */
export function pexelsMark(size = 16, className = 'pmark'): HTMLElement {
  const s = svg(
    `<svg viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-label="Pexels"><title>Pexels</title><rect width="32" height="32" rx="7" fill="#05a081"/>` +
      '<path fill="#fff" fill-rule="evenodd" d="M12 7h8.2a5.4 5.4 0 0 1 0 10.8H16V25h-4zM16 11v3.2h3.8a1.6 1.6 0 0 0 0-3.2z"/></svg>',
    className,
  );
  s.title = 'Pexels';
  return s;
}

const link = (href: string, ...children: (Node | string)[]): HTMLElement =>
  h('a', { href: pexelsUrl(href) ?? PEXELS_HOME, target: '_blank', rel: 'noopener noreferrer' }, ...children);

/** "Photo by Ada on Pexels", with both names as links to Pexels (Pexels asks that the credit is shown where its pictures are). */
export function creditLine(c: StockCredit, video: boolean): HTMLElement {
  return h('div', { class: 'pcredit' }, video ? 'Video by ' : 'Photo by ', link(c.byUrl, c.by), ' on ', pexelsMark(14), link(c.url, 'Pexels'));
}

/** "Photos and videos provided by Pexels", under the stock list. */
export function attribution(): HTMLElement {
  return h('div', { class: 'attrib' }, 'Photos and videos provided by ', pexelsMark(14), link(PEXELS_HOME, 'Pexels'));
}
