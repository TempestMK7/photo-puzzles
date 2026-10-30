import { privacy, terms, type Block, type LegalPage, type LegalValues } from './content';

/** Which pages there are, and the file each is built into (the template of the same name at the top of the repository). */
export const LEGAL_FILES = { 'privacy.html': 'privacy', 'terms.html': 'terms' } as const;

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A text with its marks (see content.ts) as HTML: everything in it is escaped first, only the marks make tags. */
function inline(text: string, v: LegalValues): string {
  const contact = v.contact.trim();
  return escape(text)
    .replace(/\{operator\}/g, escape(v.operator.trim() || 'the operator of PuzzleVidio'))
    .replace(/\{contact\}/g, contact ? `<a href="mailto:${escape(contact)}">${escape(contact)}</a>` : '<strong>(the contact address is not set in this build)</strong>')
    .replace(/\{delete\}/g, '<a href="./#/delete-account">the game\'s delete-account page</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function block(b: Block, v: LegalValues): string {
  if ('h' in b) return `<h2>${inline(b.h, v)}</h2>`;
  if ('p' in b) return `<p>${inline(b.p, v)}</p>`;
  if ('ul' in b) return `<ul>${b.ul.map((li) => `<li>${inline(li, v)}</li>`).join('')}</ul>`;
  const { head, rows } = b.table;
  const cell = (tag: string, text: string, label?: string) => `<${tag}${label ? ` data-label="${escape(label)}"` : ''}>${inline(text, v)}</${tag}>`;
  return `<div class="table"><table><thead><tr>${head.map((t) => cell('th', t)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((t, i) => cell('td', t, head[i])).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** The text of one page, with the heading and the date, ready to go into the template (`<!--legal-->`). */
export function renderLegal(file: keyof typeof LEGAL_FILES, v: LegalValues): { title: string; html: string } {
  const page: LegalPage = LEGAL_FILES[file] === 'privacy' ? privacy() : terms(v);
  const other = LEGAL_FILES[file] === 'privacy' ? { href: 'terms.html', text: 'Terms of service' } : { href: 'privacy.html', text: 'Privacy policy' };
  const html =
    `<h1>${escape(page.title)}</h1><p class="updated">PuzzleVidio · last changed ${escape(page.updated)}</p>` +
    page.blocks.map((b) => block(b, v)).join('') +
    `<footer><a href="./">← Back to the game</a> · <a href="${other.href}">${other.text}</a></footer>`;
  return { title: `${page.title} · PuzzleVidio`, html };
}
