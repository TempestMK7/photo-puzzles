import { CognitoIdentityProviderClient, AdminLinkProviderForUserCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PreSignUpTriggerEvent } from 'aws-lambda';
import { linkKey } from './dynamo';

/** What a player is told when they sign in with Google and an account with that e-mail address (made with a password) exists that is not joined to it. It is shown to them as it is. */
export const SIGN_IN_FIRST = 'An account with this e-mail address already exists. Sign in with your e-mail and password first, then add Google from your profile.';

/** What the function needs of the world (the user pool and the table), so that its rules can be tested without them. */
export interface LinkDeps {
  /** The account that was made with this e-mail address and a password (not one that came from an outside sign-in), by its `sub`. */
  native(email: string): Promise<{ sub: string } | null>;
  /** Takes (reads and deletes) what the account asked for when its owner pressed "Add Google": who they are, and until when it counts. */
  takeIntent(email: string): Promise<{ playerId: string; expiresAt: number } | null>;
  /** Joins the outside identity to the account: signing in with it from now on is signing in to the account. */
  link(nativeSub: string, provider: string, subject: string): Promise<void>;
  now(): number;
}

/**
 * Called by the user pool before it makes an account for somebody who signed in with an outside provider (Google) for the first time. If an account with that e-mail address exists that was made
 * with a password, the two are not to become separate accounts: unless the owner of that account asked, from their profile, to add the provider (the intent they left a few minutes ago), the
 * sign-in is refused with a message that says to sign in with the password first. When they did ask, the provider is joined to the account here (the pool then answers this first sign-in with an
 * error of its own, "Already found an entry for username ...", and the next one is a sign-in to the account: the game tries again by itself). Everything else goes on as it would.
 */
export async function preSignUp<T extends Pick<PreSignUpTriggerEvent, 'triggerSource' | 'userName' | 'request'>>(event: T, d: LinkDeps): Promise<T> {
  if (event.triggerSource !== 'PreSignUp_ExternalProvider') return event;
  const attrs = event.request.userAttributes;
  const email = attrs.email?.trim().toLowerCase();
  const who = /^([A-Za-z]+)_(.+)$/.exec(event.userName);                       // "Google_<the provider's own id>"
  if (!email || !who) return event;
  const twin = await d.native(email);
  if (!twin) return event;
  const intent = await d.takeIntent(email);
  // (an e-mail address that the provider has not verified proves nothing: it is never joined to an account)
  if (!intent || intent.playerId !== twin.sub || intent.expiresAt <= d.now() || attrs.email_verified !== 'true') throw new Error(SIGN_IN_FIRST);
  await d.link(twin.sub, who[1], who[2]);
  return event;
}

let cognito: CognitoIdentityProviderClient | undefined;
let table: DynamoDBDocumentClient | undefined;

export const handler = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
  cognito ??= new CognitoIdentityProviderClient({});
  table ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const idp = cognito;
  const db = table;
  const poolId = event.userPoolId;
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is not set');
  return preSignUp(event, {
    now: () => Date.now(),
    async native(email) {
      for (const text of new Set([email, email.toUpperCase()])) {
        const found = await idp.send(new ListUsersCommand({ UserPoolId: poolId, Filter: `email = "${text.replace(/["\\]/g, '')}"`, Limit: 10 }));
        const user = (found.Users ?? []).find((u) => u.UserStatus !== 'EXTERNAL_PROVIDER');
        const sub = user?.Attributes?.find((a) => a.Name === 'sub')?.Value;
        if (sub) return { sub };
      }
      return null;
    },
    async takeIntent(email) {
      const out = await db.send(new DeleteCommand({ TableName: tableName, Key: linkKey(email), ReturnValues: 'ALL_OLD' }));
      const item = out.Attributes;
      return item && typeof item.playerId === 'string' && typeof item.expiresAt === 'number' ? { playerId: item.playerId, expiresAt: item.expiresAt } : null;
    },
    async link(nativeSub, provider, subject) {
      await idp.send(
        new AdminLinkProviderForUserCommand({
          UserPoolId: poolId,
          DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: nativeSub },
          SourceUser: { ProviderName: provider, ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: subject },
        }),
      );
    },
  });
};
