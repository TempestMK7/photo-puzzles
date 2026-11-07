import { billingAvailable, buySubscription, manageSubscription, onBilling, queryProduct, restorePurchases, type BillingEvent } from '../platform';
import type { OnlineApi } from './api';
import type { OnlineSession } from './session';

type Host = Parameters<typeof billingAvailable>[0];
type Target = Parameters<typeof onBilling>[1];

/** What the player is told about a purchase that did not happen. */
const ERRORS: Record<'canceled' | 'unavailable' | 'error', string> = {
  canceled: 'The purchase was cancelled.',
  unavailable: 'Google Play could not be reached for this. The subscription can only be bought in the app that you installed from Google Play.',
  error: 'The purchase did not go through. Please try again.',
};

/**
 * The subscription in the Android app: the page's side of Google Play Billing (the shell does the buying, `src/platform.ts`, `android/.../Billing.java`). Whatever the shell reports as bought is given to
 * the server, which asks Google and makes the account paid (`POST /me/play/verify`); this never decides that the player has paid. A signed-in account that is not paid up is also offered what Play still
 * has for the player when the game starts (a new phone, a reinstall, a payment that was pending), so that nothing paid for is lost; that happens quietly, and only a purchase that the player just made says
 * anything about how it went.
 */
export class PlayBilling {
  private price = new Map<string, string>();
  /** The player pressed Subscribe and the purchase has not come back yet (what is said about it is said only then). */
  private buying = false;
  private restoredFor = '';
  private readonly listeners = new Set<(text: string | null) => void>();

  constructor(
    private readonly identity: OnlineSession,
    private readonly api: OnlineApi,
    private readonly host: Host = undefined,
    target?: Target,
  ) {
    this.host = host ?? (typeof window === 'undefined' ? undefined : (window as unknown as { PhotoPuzzlesNative?: Host }).PhotoPuzzlesNative);
    onBilling((e) => void this.heard(e), target);
    identity.onChange(() => this.restore());
  }

  /** Whether the subscription can be bought here (the app has Google Play Billing), and the server sells one (it says so with the account's \`play\`). */
  get available(): boolean {
    return billingAvailable(this.host);
  }

  /** Calls `fn` when something changed that the screen shows (the price came, a purchase was counted), with what to tell the player if there is anything. Returns the way to stop. */
  onUpdate(fn: (text: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private update(text: string | null): void {
    for (const fn of this.listeners) fn(text);
  }

  /** The price that Google Play charges, in the player's currency (nothing until Play has said). */
  priceOf(productId: string): string | null {
    return this.price.get(productId) ?? null;
  }

  /** Asks Google Play for the price (once for each ask; the answer comes as an update). */
  loadPrice(productId: string): void {
    if (this.available && !this.price.has(productId)) queryProduct(productId, this.host);
  }

  /** The player pressed Subscribe: Google Play's purchase sheet opens. */
  subscribe(productId: string): void {
    const who = this.identity.who();
    if (!who || this.identity.kind() !== 'account' || this.buying) return;
    this.buying = buySubscription(productId, who.id, this.host);
  }

  manage(productId: string): void {
    manageSubscription(productId, this.host);
  }

  /** An account that is not paid up through Google Play is given what Play still has for the player, once for each account in a run of the game. */
  private restore(): void {
    const who = this.identity.kind() === 'account' ? this.identity.who() : null;
    const play = this.identity.summary().play;
    if (!who || !play?.on || play.active || this.restoredFor === who.id || !this.available) return;
    this.restoredFor = who.id;
    restorePurchases(this.host);
  }

  private async heard(e: BillingEvent): Promise<void> {
    if (e.kind === 'product') {
      this.price.set(e.productId, e.price);
      this.update(null);
    } else if (e.kind === 'error') {
      const was = this.buying;
      this.buying = false;
      if (was) this.update(ERRORS[e.error]);
    } else {
      await this.verify(e.token, e.pending);
    }
  }

  /** The server is given a purchase: what it says is what counts. */
  private async verify(token: string, pending: boolean): Promise<void> {
    const mine = this.buying;
    this.buying = false;
    const res = await this.api.playVerify(token);
    if (res.ok) {
      this.identity.setSummary(res.account);
      const active = res.account.play?.active === true;
      this.update(active ? (mine ? 'Thank you! Your subscription is active and this is now a paid account.' : null) : pending ? 'Your payment is pending. The subscription starts when Google Play confirms it.' : null);
      return;
    }
    if (!mine) return;                                                // (a purchase that was found, not made now: nothing is said)
    if (res.error === 'purchase-taken') this.update('That Google Play subscription belongs to another account here.');
    else this.update('The purchase went through, but the server could not be reached to count it. Open the game again while you are signed in and it will be counted.');
  }
}
