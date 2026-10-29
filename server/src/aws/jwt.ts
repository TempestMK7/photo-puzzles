import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { Clock } from '../types';

export type FetchJson = (url: string) => Promise<unknown>;

/** The keys of a user pool are looked at again no sooner than this, whatever the tokens say, so that a stream of made-up key ids cannot make the function ask Cognito all day. */
const REFETCH_MS = 60_000;

const part = (text: string): unknown => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));

/**
 * Checks the ID token of a Cognito user pool: the signature (RS256, against the keys the pool publishes), who issued it, for which app client, that it is an ID token, and that
 * it has not run out. It is for the places where API Gateway cannot do this for us (the broker's authorizer is our own function). It returns the claims, or nothing.
 */
export class CognitoVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = -Infinity;

  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    private readonly fetchJson: FetchJson,
    private readonly clock: Clock,
  ) {}

  async verify(token: string): Promise<Record<string, unknown> | undefined> {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = part(parts[0]) as typeof header;
      claims = part(parts[1]) as typeof claims;
    } catch {
      return undefined;
    }
    // only the algorithm the pool uses: a token that names another ("none", or a shared-secret one) is not looked at further
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || typeof claims !== 'object' || claims === null) return undefined;
    const key = await this.key(header.kid);
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return undefined;
    if (claims.iss !== this.issuer || claims.token_use !== 'id' || claims.aud !== this.audience) return undefined;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.clock.now()) return undefined;
    return claims;
  }

  private async key(kid: string): Promise<KeyObject | undefined> {
    const known = this.keys.get(kid);
    if (known || this.clock.now() - this.fetchedAt < REFETCH_MS) return known;
    this.fetchedAt = this.clock.now();
    const jwks = (await this.fetchJson(`${this.issuer}/.well-known/jwks.json`)) as { keys?: (JsonWebKey & { kid?: string })[] };
    this.keys = new Map();
    for (const k of jwks.keys ?? []) if (k.kid && k.kty === 'RSA') this.keys.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
    return this.keys.get(kid);
  }
}
