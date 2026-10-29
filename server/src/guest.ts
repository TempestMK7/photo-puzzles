import { mac, same } from './signing';
import type { Auth, Clock, Player } from './types';

/** A guest token is good for this long, and is made new (for the same guest) when the game asks again before it runs out. */
export const GUEST_LIFE_MS = 90 * 24 * 3600 * 1000;

const PREFIX = 'g1.';
const ID = /^g[A-Za-z0-9_-]{22}$/;

const bytesToB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64 = (text: string): string => bytesToB64(new TextEncoder().encode(text));
const unb64 = (text: string): string => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

export const isGuestToken = (token: string): boolean => token.startsWith(PREFIX);

/**
 * Someone who joins a puzzle without an account is a guest: the server gives them an id and a token that says it (`g1.<id and end>.<signature>`), and they show the token each time they
 * ask for something. It is signed with the same key as the picture addresses, so only this server can make one. There is nothing to look up: a token is good if the signature is and it
 * has not run out. The ids start with `g`, which no Cognito id (a UUID) does.
 */
export class GuestTokens {
  constructor(
    private readonly key: Uint8Array,
    private readonly clock: Clock,
    private readonly lifeMs = GUEST_LIFE_MS,
  ) {}

  /** A token for a new guest, or (when `id` is given) a new one for that guest. */
  async issue(id?: string): Promise<{ token: string; id: string; expiresAt: number }> {
    const who = id ?? `g${bytesToB64(crypto.getRandomValues(new Uint8Array(16)))}`;
    const expiresAt = this.clock.now() + this.lifeMs;
    const payload = b64(JSON.stringify({ i: who, e: expiresAt }));
    return { token: `${PREFIX}${payload}.${await mac(this.key, `guest:${payload}`)}`, id: who, expiresAt };
  }

  /** The guest's id, if the token is one of ours and has not run out. */
  async verify(token: string): Promise<string | null> {
    if (!isGuestToken(token)) return null;
    const [payload, sig, ...more] = token.slice(PREFIX.length).split('.');
    if (!payload || !sig || more.length) return null;
    if (!same(await mac(this.key, `guest:${payload}`), sig)) return null;
    try {
      const { i, e } = JSON.parse(unb64(payload)) as { i?: unknown; e?: unknown };
      return typeof i === 'string' && ID.test(i) && typeof e === 'number' && e > this.clock.now() ? i : null;
    } catch {
      return null;
    }
  }
}

/** Guest tokens first; anything else is for the sign-in that is used where the server runs (Cognito in the cloud, a made-up one on a developer's machine). */
export class TokenAuth implements Auth {
  constructor(
    private readonly guests: GuestTokens,
    private readonly accounts: Auth,
  ) {}

  async verify(token: string): Promise<Player | null> {
    if (isGuestToken(token)) {
      const id = await this.guests.verify(token);
      return id ? { id, name: 'Guest', guest: true } : null;
    }
    return this.accounts.verify(token);
  }
}
