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
  /** An OIDC provider for GitHub that the account already has (an account can only have one). */
  githubProviderArn?: string;
  /** Google sign-in: the OAuth client id and the name of the Secrets Manager secret that holds its client secret. Both, or neither. */
  googleClientId?: string;
  googleSecretName?: string;
}

const text = (node: Node, key: string, fallback?: string): string | undefined => {
  const v = node.tryGetContext(key) ?? process.env[`PUZZLEVIDIO_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`] ?? fallback;
  return v === undefined || v === '' ? undefined : String(v);
};

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
    githubProviderArn: text(node, 'githubProviderArn'),
    googleClientId,
    googleSecretName,
  };
}

/** The address of the game: the bare domain for the real thing, a sub-domain for the others. */
export function siteDomain(stage: Stage, zoneName: string): string {
  return stage === 'prod' ? zoneName : `${stage}.${zoneName}`;
}

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
export const ALARM_TOPIC_NAME = 'puzzlevidio-alarms';

export const stackName = (stage: Stage | 'shared', part: string): string => `PuzzleVidio-${stage}-${part}`;

/** The role that GitHub Actions takes, by name so that the stacks can attach to it without depending on each other. */
export const DEPLOY_ROLE_NAME = 'puzzlevidio-github-deploy';
