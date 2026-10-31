import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/online/protocol';
import { GUEST_LIFE_MS } from '../server/src/guest';
import { privacy, terms, type LegalValues } from '../src/legal/content';
import { LEGAL_FILES, renderLegal } from '../src/legal/html';

const values: LegalValues = { operator: 'Example & Co', contact: 'privacy@example.test', law: 'the laws of Exampleland' };

const text = (blocks: ReturnType<typeof privacy>['blocks']): string =>
  blocks.map((b) => ('h' in b ? b.h : 'p' in b ? b.p : 'ul' in b ? b.ul.join(' ') : [...b.table.head, ...b.table.rows.flat()].join(' '))).join('\n');

describe('what the privacy policy and the terms say', () => {
  it('has no blanks left to fill in', () => {
    for (const t of [text(privacy().blocks), text(terms(values).blocks)]) {
      expect(t).not.toMatch(/\[[^\]]*\]/);
      expect(t.toLowerCase()).not.toContain('draft');
    }
  });

  it('gives the times and limits that the code uses', () => {
    const days = (ms: number) => ms / (24 * 3600 * 1000);
    const both = `${text(privacy().blocks)}\n${text(terms(values).blocks)}`;
    expect(both).toContain(`${days(DEFAULT_LIMITS.maxAgeMs)} days`);
    expect(both).toContain(`${days(GUEST_LIFE_MS)} days`);                    // a guest's token
    expect(both).toContain('starts with five photo credits');
    expect(DEFAULT_LIMITS.freePhotoCredits).toBe(5);
    expect(both).toContain('eight players');
    expect(DEFAULT_LIMITS.playersPerRoom).toBe(8);
    expect(both).toContain('nobody has touched it for a day');
    expect(DEFAULT_LIMITS.idleMs).toBe(24 * 3600 * 1000);
    expect(both).toContain('an hour after it is solved');
    expect(DEFAULT_LIMITS.solvedKeepMs).toBe(3600 * 1000);
  });

  it('says nothing about a law that it was not given', () => {
    expect(text(terms({ ...values, law: '' }).blocks)).not.toContain('Which law');
    expect(text(terms(values).blocks)).toContain('These terms go by the laws of Exampleland.');
    const numbered = (law: string) => terms({ ...values, law }).blocks.filter((b): b is { h: string } => 'h' in b).map((b) => b.h);
    expect(numbered('').at(-1)).toBe('8. Copyright notices');
    expect(numbered('x').at(-1)).toBe('9. Copyright notices');
  });
});

describe('the pages that are built from it', () => {
  it('put the name and the address in, and escape everything', () => {
    for (const file of Object.keys(LEGAL_FILES) as (keyof typeof LEGAL_FILES)[]) {
      const { title, html } = renderLegal(file, values);
      expect(title).toContain('PuzzleVidio');
      expect(html).toContain('Example &amp; Co');
      expect(html).toContain('<a href="mailto:privacy@example.test">privacy@example.test</a>');
      expect(html).not.toContain('{');
      expect(html).not.toContain('**');
      expect(html).toContain('href="./"');
    }
    expect(renderLegal('privacy.html', values).html).toContain('<table>');
    expect(renderLegal('privacy.html', values).html).toContain('href="terms.html"');
    expect(renderLegal('terms.html', values).html).toContain('href="privacy.html"');
  });

  it('cannot be made to carry markup by the values', () => {
    const { html } = renderLegal('terms.html', { operator: '<script>x</script>', contact: '"><img src=x>', law: '<b>law</b>' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>law');
  });

  it('say so when there is nowhere to write, rather than leave a gap', () => {
    expect(renderLegal('privacy.html', { operator: '', contact: '', law: '' }).html).toContain('the contact address is not set in this build');
    expect(renderLegal('privacy.html', { operator: '', contact: '', law: '' }).html).toContain('the operator of PuzzleVidio');
  });
});
