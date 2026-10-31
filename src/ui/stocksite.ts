import { STOCK_HOMES, STOCK_NAMES, stockUrl, type StockSite } from '../online/protocol';
import type { StockCredit } from '../store/stock';
import { h, svg } from './dom';

/** A small mark for a stock site, drawn here (a coloured square with a P): it says where a picture or video came from. */
export function siteMark(site: StockSite, size = 16, className = 'pmark'): HTMLElement {
  const [back, front] = site === 'pexels' ? ['#05a081', '#fff'] : ['#191b26', '#2ec66d'];
  const name = STOCK_NAMES[site];
  const s = svg(
    `<svg viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-label="${name}"><title>${name}</title><rect width="32" height="32" rx="7" fill="${back}"/>` +
      `<path fill="${front}" fill-rule="evenodd" d="M12 7h8.2a5.4 5.4 0 0 1 0 10.8H16V25h-4zM16 11v3.2h3.8a1.6 1.6 0 0 0 0-3.2z"/></svg>`,
    className,
  );
  s.title = name;
  return s;
}

/** A small badge that says that an AI made the picture or video (the sites that know say so): "AI" on a thumbnail, "AI generated" in a line of text. */
export function aiMark(label = false): HTMLElement {
  const m = h('span', { class: label ? 'aimark long' : 'aimark', title: 'Made by an AI', 'aria-label': 'AI generated' }, label ? 'AI generated' : 'AI');
  return m;
}

const link = (site: StockSite, href: string, ...children: (Node | string)[]): HTMLElement =>
  h('a', { href: stockUrl(site, href) ?? STOCK_HOMES[site], target: '_blank', rel: 'noopener noreferrer' }, ...children);

/** "Photo by Ada on Pexels", with both names as links to the site (the sites ask that the credit is shown where their pictures are). */
export function creditLine(c: StockCredit, video: boolean): HTMLElement {
  return h('div', { class: 'pcredit' }, video ? 'Video by ' : 'Photo by ', link(c.source, c.byUrl, c.by), ' on ', siteMark(c.source, 14), link(c.source, c.url, STOCK_NAMES[c.source]), ...(c.ai ? [aiMark(true)] : []));
}

/** "Photos and videos provided by Pexels", under the stock list. */
export function attribution(site: StockSite): HTMLElement {
  return h('div', { class: 'attrib' }, 'Photos and videos provided by ', siteMark(site, 14), link(site, STOCK_HOMES[site], STOCK_NAMES[site]));
}
