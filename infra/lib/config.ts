import type { Node } from 'constructs';

/** Everything runs in one region: CloudFront only takes certificates from us-east-1, and IoT Core, Cognito and Lambda are all there. */
export const REGION = 'us-east-1';

export type Stage = 'dev' | 'prod';
export const STAGES: Stage[] = ['dev', 'prod'];

/**
 * What differs between one deployment and the next. Nothing here is a secret, but ids of the account are not committed either: they are given as CDK context
 * (`-c name=value`, or `cdk.context.json`, which is ignored by git).
 */
export interface Settings {
  /** The domain name, registered in Route 53. */
  zoneName: string;
  /** The id of its hosted zone. */
  hostedZoneId: string;
  /** Who hears about the budget. Without it no budget is made. */
  alertEmail?: string;
  /** The monthly budget (USD) that the alarms are scaled to. */
  budgetUsd: number;
  /** `owner/name` of the GitHub repository whose `main` branch may deploy. */
  githubRepo: string;
  /**
   * What GitHub puts in front of `:ref:...` in the token of a repository with immutable subjects: `owner@ownerId/name@repoId` (the ids are in
   * `gh api repos/<owner>/<name>/actions/oidc/customization/sub`, as `sub_claim_prefix` without its `repo:`). Such a repository's tokens no longer say `repo:owner/name`.
   */
  githubSubjectPrefix?: string;
  /** An OIDC provider for GitHub that the account already has (an account can only have one). */
  githubProviderArn?: string;
  /** Google sign-in: the OAuth client id and the name of the Secrets Manager secret that holds its client secret. Both, or neither. */
  googleClientId?: string;
  googleSecretName?: string;
  /**
   * The stock library: the name of the Secrets Manager secret that holds each site's API key (`puzzlevidio/pexels` and `puzzlevidio/pixabay` unless the deploy says otherwise; `none`
   * leaves a site out). A site whose secret is not there, or is empty, is skipped when the API starts: the game offers the sites that have a key.
   */
  pexelsSecretName?: string;
  pixabaySecretName?: string;
  /**
   * The AdMob ad units that the game's rewarded ads are made of (the ids, comma-separated, like `ca-app-pub-123/456`). AdMob tells the server when an ad was watched, and the server believes
   * only a call that is about one of these. Without them no ad is accepted (unless the limit `adsTrusted` is set).
   */
  admobAdUnits?: string;
  /** Changes to the service's limits (see `Limits` in server/src/types.ts), as numbers by name: `hostingPaused: 1` switches the making of puzzles off. */
  limits?: Record<string, number>;
}

/** The limits that may be set, and nothing else (a misspelt one would silently do nothing). */
export const LIMIT_NAMES = ['jigsawPieces', 'playersPerRoom', 'activeRoomsPerPlayer', 'idleMs', 'solvedKeepMs', 'maxAgeMs', 'pictureBytes', 'videoBytes', 'videoMs', 'fileKeepMs', 'hostingPaused', 'freePhotoCredits', 'adPhotoCredits', 'adVideoCredits', 'adsPerDay', 'videoAdsPerDay', 'adsTrusted', 'paidVideoCredits'];

/** Limits that existed and are gone (the weekly counts of puzzles: credits took their place). A setting that still names one is left out, so that a deployment that has it goes on working. */
const RETIRED_LIMITS = ['freeRoomsPerWeek', 'videoRoomsPerWeek'];

function parseLimits(raw: string | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('limits must be JSON, like {"hostingPaused":1}');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('limits must be an object, like {"hostingPaused":1}');
  for (const k of RETIRED_LIMITS) delete (parsed as Record<string, unknown>)[k];
  for (const [k, v] of Object.entries(parsed)) {
    if (!LIMIT_NAMES.includes(k)) throw new Error(`limits: ${k} is not a limit (${LIMIT_NAMES.join(', ')})`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`limits: ${k} must be a number, 0 or more`);
  }
  return Object.keys(parsed).length ? (parsed as Record<string, number>) : undefined;
}

/** Where the stock sites' keys are looked for. */
export const DEFAULT_STOCK_SECRETS = { pexels: 'puzzlevidio/pexels', pixabay: 'puzzlevidio/pixabay' };

const text = (node: Node, key: string, fallback?: string): string | undefined => {
  const v = node.tryGetContext(key) ?? process.env[`PUZZLEVIDIO_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`] ?? fallback;
  return v === undefined || v === '' ? undefined : String(v);
};

/** The name of a stock site's secret: the one that is given, else the usual one; `none` is no secret at all. */
function stockSecret(node: Node, key: string, usual: string): string | undefined {
  const v = text(node, key);
  return v === 'none' ? undefined : (v ?? usual);
}

export function settings(node: Node): Settings {
  const hostedZoneId = text(node, 'hostedZoneId');
  if (!hostedZoneId) {
    throw new Error('Give the id of the hosted zone of the domain: cdk synth -c hostedZoneId=Z... (or PUZZLEVIDIO_HOSTED_ZONE_ID)');
  }
  const googleClientId = text(node, 'googleClientId');
  const googleSecretName = text(node, 'googleSecretName');
  if (!googleClientId !== !googleSecretName) throw new Error('Google sign-in needs both googleClientId and googleSecretName');
  return {
    zoneName: text(node, 'zoneName', 'puzzlevid.io')!,
    hostedZoneId,
    alertEmail: text(node, 'alertEmail'),
    budgetUsd: Number(text(node, 'budgetUsd', '25')),
    githubRepo: text(node, 'githubRepo', 'TempestMK7/photo-puzzles')!,
    githubSubjectPrefix: text(node, 'githubSubjectPrefix'),
    githubProviderArn: text(node, 'githubProviderArn'),
    googleClientId,
    googleSecretName,
    admobAdUnits: text(node, 'admobAdUnits'),
    pexelsSecretName: stockSecret(node, 'pexelsSecretName', DEFAULT_STOCK_SECRETS.pexels),
    pixabaySecretName: stockSecret(node, 'pixabaySecretName', DEFAULT_STOCK_SECRETS.pixabay),
    limits: parseLimits(text(node, 'limits')),
  };
}

/** The address of the game: the bare domain for the real thing, a sub-domain for the others. */
export function siteDomain(stage: Stage, zoneName: string): string {
  return stage === 'prod' ? zoneName : `${stage}.${zoneName}`;
}

/** The address that the Android app's pages come from (the app serves its own files under it): it may call the API and fetch and upload pictures, but is not a place to sign in from. */
export const APP_ORIGINS = ['https://appassets.androidplatform.net'];

/** Where the game may be served from, for the places that must know (sign-in return addresses, upload CORS). */
export function siteOrigins(stage: Stage, zoneName: string): string[] {
  return [`https://${siteDomain(stage, zoneName)}`, ...(stage === 'dev' ? ['http://localhost:5173'] : [])];
}

/** The address of the API: `api.` in front of the game's own address. */
export const apiDomain = (stage: Stage, zoneName: string): string => `api.${siteDomain(stage, zoneName)}`;

/** What the gateway lets through before it answers 429: requests per second on average, and in a burst. Raise it when there are many players. */
export const API_THROTTLE: Record<Stage, { rate: number; burst: number }> = { dev: { rate: 20, burst: 40 }, prod: { rate: 1000, burst: 2000 } };

/**
 * How many requests in five minutes make an alarm say "look at this" (it does not say something is wrong): the API's, and the broker's authorizer's (one call for every connection, and again
 * every ten minutes for as long as it lasts). Set well above what a launch needs, and below what a script could run up a bill with. Change them as use grows.
 */
export const BUSY_ALARMS: Record<Stage, { api: number; authorizer: number }> = { dev: { api: 2000, authorizer: 300 }, prod: { api: 60_000, authorizer: 6000 } };

/** The name of the broker's custom authorizer: the game puts it in the address it connects to (`x-amz-customauthorizer-name`). */
export const liveAuthorizerName = (stage: Stage): string => `puzzlevidio-${stage}`;

/** The topic that alarms are sent to (made by the Ops stack, found by name by the others). */
/** The Cognito group whose members may use the admin page (`ADMIN_GROUP` in src/online/adminProtocol.ts: keep the two in step). */
export const ADMIN_GROUP = 'admins';

export const ALARM_TOPIC_NAME = 'puzzlevidio-alarms';

export const stackName = (stage: Stage | 'shared', part: string): string => `PuzzleVidio-${stage}-${part}`;

/** The role that GitHub Actions takes, by name so that the stacks can attach to it without depending on each other. */
/** The address and name the sign-up and password-reset e-mails come from (the domain is verified in the Ops stack). */
export const mailFrom = (zoneName: string): string => `no-reply@${zoneName}`;
export const MAIL_FROM_NAME = 'PuzzleVidio';

export const DEPLOY_ROLE_NAME = 'puzzlevidio-github-deploy';
