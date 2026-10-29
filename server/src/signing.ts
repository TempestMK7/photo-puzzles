import type { Clock } from './types';

const enc = new TextEncoder();

/** An HMAC of a text, as hex. */
async function mac(key: Uint8Array, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Equal texts, without stopping at the first difference (a signature must not be found out a letter at a time). */
function same(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Addresses of the form `<base>/media/<room>?exp=<ms>&sig=<hmac>` that say by themselves who may do what to a room's picture, until they run out. A holder of the
 * address needs no sign-in: whoever was given it by the service may use it.
 */
export class Signer {
  constructor(
    private readonly key: Uint8Array,
    private readonly clock: Clock,
    private readonly lifeMs = 10 * 60 * 1000,
  ) {}

  async address(base: string, roomId: string, what: 'put' | 'get'): Promise<string> {
    const exp = this.clock.now() + this.lifeMs;
    return `${base}/media/${encodeURIComponent(roomId)}?exp=${exp}&sig=${await mac(this.key, `${what}:${roomId}:${exp}`)}`;
  }

  /** Whether an address (what is after the `?`) was made by this signer for that purpose and has not run out. */
  async allows(roomId: string, what: 'put' | 'get', exp: string | null, sig: string | null): Promise<boolean> {
    if (!exp || !sig || !(Number(exp) > this.clock.now())) return false;
    return same(await mac(this.key, `${what}:${roomId}:${exp}`), sig);
  }
}
