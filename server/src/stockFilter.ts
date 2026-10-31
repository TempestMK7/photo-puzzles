/**
 * What keeps adult pictures out of the stock library. The sites' own switches are not enough: Pixabay's `safesearch` still returns pictures tagged "nude woman", "lingerie" or
 * "eroticism" (it leaves out much, not all; its site keeps such pictures behind a "sensitive content" cover that the API does not offer). So a search that asks for such things is
 * answered with nothing, and a picture whose tags, description or page address (which carries its title) use such a word is left out, whatever the site says. It is a list of words
 * and so it misses some and catches some that are harmless ("naked eye"); it is the first of two layers, the second being the stricter automatic look (for nudity that is not explicit) that a puzzle
 * made from a stock picture gets before anyone else can join (`strict` in `server/src/aws/rekognition.ts`).
 */
const TERMS = [
  'nude[sd]?',
  'nudity',
  'nudist',
  'naked',
  'nsfw',
  'erotic(?:a|ism|s)?',
  'sex',
  'sexy',
  'sexier',
  'sexual(?:ly)?',
  'sensual(?:ity)?',
  'seduct(?:ive|ion)',
  'seduce[sd]?',
  'lingerie',
  'underwear',
  'panties',
  'thongs?',
  'g string',
  'bras?',
  'topless',
  'boobs?',
  'breasts',
  'cleavage',
  'busty',
  'porn(?:o|ography|ographic)?',
  'fetish(?:es)?',
  'bdsm',
  'bondage',
  'dominatrix',
  'strippers?',
  'striptease',
  'hentai',
  'xxx',
  'provocative',
  'naughty',
  'kinky',
  'orgy',
  'buttocks',
  'booty',
  'butt',
  'twerk(?:ing)?',
  'playboy',
  'onlyfans',
];

const ADULT = new RegExp(`\\b(?:${TERMS.join('|')})\\b`, 'i');

/** Whether this text (a search, tags, a description, a page address) uses a word of the list. Hyphens and underscores count as spaces, so the words of an address are found. */
export function adultText(text: string): boolean {
  return ADULT.test(text.replace(/[-_/+.]+/g, ' '));
}

/** The path of an address, for `adultText` (a site's page address carries the title of the picture); nothing if it is not an address. */
export function pathOf(address: unknown): string {
  if (typeof address !== 'string') return '';
  try {
    return new URL(address).pathname;
  } catch {
    return '';
  }
}
