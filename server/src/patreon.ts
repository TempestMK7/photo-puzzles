import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Patreon, PatreonMember } from './types';

/** What the deployment keeps in the secret (a JSON text), from Patreon's developer pages (https://www.patreon.com/portal/registration/register-clients) and the campaign. */
export interface PatreonSettings {
  clientId: string;
  clientSecret: string;
  /** The secret of the webhook that Patreon calls when a pledge changes (the webhook's page shows it). */
  webhookSecret: string;
  /** The creator's own access token (the client's page shows it): it reads a member of the campaign by id. */
  creatorToken: string;
  /** The id of the campaign whose pledges count (a pledge to anyone else's is nobody's business). */
  campaignId: string;
  /** The least a pledge may be, in cents, to make an account paid (500: the $5 tier; a higher tier of the same campaign counts too). */
  minCents?: number;
}

const API = 'https://www.patreon.com/api/oauth2/v2';
const AUTHORIZE = 'https://www.patreon.com/oauth2/authorize';
const TOKEN = 'https://www.patreon.com/api/oauth2/token';
const MEMBER_FIELDS = 'patron_status,currently_entitled_amount_cents,last_charge_date,last_charge_status';

type Fetcher = typeof fetch;

interface Resource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string; type?: string } | { id?: string; type?: string }[] | null }>;
}

/** Reads the secret's text; nothing when it is not a complete set of settings (Patreon is then left off). */
export function parsePatreonSettings(text: string | undefined): PatreonSettings | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as Partial<PatreonSettings>;
    const ok = [v.clientId, v.clientSecret, v.webhookSecret, v.creatorToken, v.campaignId].every((x) => typeof x === 'string' && x);
    return ok ? (v as PatreonSettings) : undefined;
  } catch {
    return undefined;
  }
}

/** The member that a Patreon resource of type `member` describes: paid up (`active_patron`, last payment not declined) and pledging at least `minCents`. */
function memberOf(userId: string, m: Resource | undefined, minCents: number): PatreonMember {
  if (!m) return { userId, active: false };
  const a = m.attributes ?? {};
  const cents = typeof a.currently_entitled_amount_cents === 'number' ? a.currently_entitled_amount_cents : 0;
  const paidLast = a.last_charge_status === undefined || a.last_charge_status === null || a.last_charge_status === 'Paid';
  const lastCharge = typeof a.last_charge_date === 'string' && a.last_charge_status === 'Paid' ? a.last_charge_date : undefined;
  return { userId, memberId: m.id, active: a.patron_status === 'active_patron' && cents >= minCents && paidLast, ...(lastCharge ? { lastCharge } : {}) };
}

/** Patreon's API (version 2) for what the game needs: who a player is on Patreon, and whether they pledge to this campaign. */
export class HttpPatreon implements Patreon {
  constructor(
    private readonly settings: PatreonSettings,
    /** Where Patreon sends the player back to (the API's own address for `/patreon/callback`). */
    private readonly redirectUri: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private get minCents(): number {
    return this.settings.minCents ?? 500;
  }

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({ response_type: 'code', client_id: this.settings.clientId, redirect_uri: this.redirectUri, scope: 'identity identity.memberships', state });
    return `${AUTHORIZE}?${q}`;
  }

  async identify(code: string): Promise<PatreonMember> {
    const tokenRes = await this.fetcher(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: this.settings.clientId, client_secret: this.settings.clientSecret, redirect_uri: this.redirectUri }),
    });
    if (!tokenRes.ok) throw new Error(`Patreon refused the code (${tokenRes.status})`);
    const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!token) throw new Error('Patreon gave no token');
    const q = new URLSearchParams({ include: 'memberships,memberships.campaign', 'fields[member]': MEMBER_FIELDS });
    const res = await this.fetcher(`${API}/identity?${q}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Patreon would not say who this is (${res.status})`);
    const body = (await res.json()) as { data?: Resource; included?: Resource[] };
    const userId = body.data?.id;
    if (!userId) throw new Error('Patreon gave no user');
    const ours = (body.included ?? []).find((r) => r.type === 'member' && (r.relationships?.campaign?.data as { id?: string } | undefined)?.id === this.settings.campaignId);
    return memberOf(userId, ours, this.minCents);
  }

  async member(memberId: string): Promise<PatreonMember | null> {
    const q = new URLSearchParams({ include: 'user', 'fields[member]': MEMBER_FIELDS });
    const res = await this.fetcher(`${API}/members/${encodeURIComponent(memberId)}?${q}`, { headers: { authorization: `Bearer ${this.settings.creatorToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Patreon would not say about a member (${res.status})`);
    const body = (await res.json()) as { data?: Resource };
    const userId = (body.data?.relationships?.user?.data as { id?: string } | undefined)?.id;
    return userId ? memberOf(userId, body.data, this.minCents) : null;
  }

  /** The signature is the MD5 HMAC (hex) of the body under the webhook's secret (Patreon's own scheme). */
  webhook(body: string, signature: string | undefined): PatreonMember | null {
    if (!signature) return null;
    const want = Buffer.from(createHmac('md5', this.settings.webhookSecret).update(body).digest('hex'));
    const got = Buffer.from(signature);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    let parsed: { data?: Resource };
    try {
      parsed = JSON.parse(body) as { data?: Resource };
    } catch {
      return null;
    }
    const userId = (parsed.data?.relationships?.user?.data as { id?: string } | undefined)?.id;
    return userId && parsed.data?.type === 'member' ? memberOf(userId, parsed.data, this.minCents) : null;
  }
}
