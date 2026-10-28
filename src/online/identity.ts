import type { Identity } from './api';

const ID_KEY = 'photo-puzzles/online/id';
const NAME_KEY = 'photo-puzzles/online/name';

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Who this player is while there is no real sign-in: a made-up id and a name the player chooses, kept for this browser tab only (so two tabs are two players, which is what
 * trying it out needs). The local server takes whatever it is told; the real server will want a Cognito token in its place.
 */
export class DevIdentity {
  private store = session();
  private idValue: string;
  private nameValue: string;

  constructor() {
    const random = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    this.idValue = this.store?.getItem(ID_KEY) ?? random(12);
    this.nameValue = this.store?.getItem(NAME_KEY) ?? `Player ${Math.floor(1000 + Math.random() * 9000)}`;
    this.store?.setItem(ID_KEY, this.idValue);
    this.store?.setItem(NAME_KEY, this.nameValue);
  }

  setName(name: string): void {
    const clean = name.trim().slice(0, 24);
    if (!clean) return;
    this.nameValue = clean;
    this.store?.setItem(NAME_KEY, clean);
  }

  get(): Identity {
    return { id: this.idValue, name: this.nameValue, token: `dev:${this.idValue}:${encodeURIComponent(this.nameValue)}` };
  }
}
