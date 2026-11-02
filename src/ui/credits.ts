import { DEFAULT_LIMITS, type AccountSummary } from '../online/protocol';
import type { Platform } from '../platform';

export type CreditKind = 'photo' | 'video';

/** What the inventory says about the credits (see `src/ui/inventory.ts`, which shows them). */
/** What a number of credits looks like: the infinity sign when the account does not spend them. */
export const creditText = (n: number, infinite: boolean): string => (infinite ? '∞' : String(n));

export interface CreditsExplanation {
  title: string;
  paragraphs: string[];
  /** The button that plays an ad for credits. `enabled`: the account may watch one now. */
  ad?: { label: string; note: string };
  /** The dialog offers to sign in or make an account (a guest has no credits to speak of). */
  signIn?: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What the dialog says about one kind of credit, for the account as it stands and the place the game is running in. Ads are only in the Android and iOS apps: on Steam, itch and the web page
 * the dialog says where they can be watched instead (the credits are the account's, so they work everywhere).
 */
export function explainCredits(kind: CreditKind, a: AccountSummary, where: Platform): CreditsExplanation {
  const photo = kind === 'photo';
  const held = photo ? a.photo : a.video;
  const left = photo ? a.photoAdsLeft : a.videoAdsLeft;
  const give = photo ? a.adPhoto : a.adVideo;
  const unit = photo ? 'photo' : 'video';
  const lead = photo
    ? 'Playing on your own is always free and unlimited, and so is joining a friend’s puzzle. A photo credit pays for starting a multiplayer puzzle from a picture.'
    : 'Playing a video on your own is always free and unlimited, and so is joining a friend’s video puzzle. A video credit pays for starting a multiplayer puzzle from a video.';
  const title = photo ? 'Photo credits' : 'Video credits';
  const mobile = where === 'android' || where === 'ios';
  const outside = 'Ads can only be watched in the Android and iOS apps (Steam, itch and the web page have none). Install the game on your phone and sign in with this account: the credits you get there are yours here too.';

  if (a.type === 'guest') {
    return {
      title,
      paragraphs: [lead, photo ? `Guests can join any puzzle but cannot start one. Make an account to start puzzles: a free account starts with ${DEFAULT_LIMITS.freePhotoCredits} photo credits.` : 'Guests cannot start puzzles. Video puzzles are for paid accounts.'],
      signIn: true,
    };
  }
  if (photo ? a.photoInfinite : a.videoInfinite) {
    return { title, paragraphs: [lead, a.type === 'paid' ? 'Your account starts as many puzzles from pictures as you like, so photo credits are never used up.' : 'Your account starts puzzles from pictures and videos without using credits.'] };
  }

  const paragraphs = [lead];
  if (photo) paragraphs.push(`Each puzzle you start from a picture costs 1 photo credit. You have ${held}. Credits never expire: they stay until you use them.`);
  else if (a.type === 'paid') paragraphs.push(`Each puzzle you start from a video costs 1 video credit. You have ${held}. A paid account gets ${DEFAULT_LIMITS.paidVideoCredits} video credits for each payment period, and credits you do not use carry over for ever.`);
  else paragraphs.push(`Video puzzles are for paid accounts. You have ${held} video credits: they are kept, and can be used again if your account becomes a paid one.`);

  // ads: a free account gets photo credits and a paid account video credits (the server decides: this only says what it will do)
  const eligible = photo ? a.type === 'free' : a.type === 'paid';
  if (!eligible) return { title, paragraphs };
  if (!mobile) {
    paragraphs.push(outside);
    return { title, paragraphs };
  }
  if (held > 0) {
    paragraphs.push(`When you have none left you can watch an ad for ${plural(give, `${unit} credit`, `${unit} credits`)} (${plural(left, 'ad', 'ads')} left today).`);
    return { title, paragraphs };
  }
  if (left < 1) {
    paragraphs.push('You have watched all of today’s ads. You can watch more tomorrow.');
    return { title, paragraphs };
  }
  return { title, paragraphs, ad: { label: `Watch an ad for ${plural(give, `${unit} credit`, `${unit} credits`)}`, note: `${plural(left, 'ad', 'ads')} left today` } };
}
