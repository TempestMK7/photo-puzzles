import type { Player } from '../types';

/** Who the token says the player is. The ID token of Cognito has `sub` (never changes) and, if the player gave one, `name`; otherwise the start of the e-mail address stands in. */
export function playerFrom(claims: Record<string, unknown> | undefined): Player | undefined {
  const id = claims?.sub;
  if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) return undefined;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = (text(claims?.name) || text(claims?.email).split('@')[0] || 'Player').slice(0, 24);
  return { id, name };
}
