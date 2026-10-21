// Small seeded random generator (mulberry32). The same seed always gives the same sequence on every device, so a seed can be shared to share a puzzle.
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** Next float in [0, 1). */
  unit(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [0, n). */
  below(n: number): number {
    return Math.floor(this.unit() * n);
  }
}

/** Turns any text (a typed seed) into a 32-bit number (FNV-1a). */
export function seedFromText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A short random seed the player can read out or paste. */
export function randomSeedText(): string {
  const r = new Rng((Math.random() * 4294967296) >>> 0);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[r.below(ALPHABET.length)];
  return s;
}
