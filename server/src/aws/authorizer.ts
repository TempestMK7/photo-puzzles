import type { Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GuestTokens, isGuestToken } from '../guest';
import { systemClock } from '../memory';
import { playerFrom } from './claims';
import { DynamoStore } from './dynamo';
import { CognitoVerifier, fetchJson } from './jwt';

/**
 * The broker's custom authorizer (IoT Core calls it when a game connects, and again every few minutes while it stays). The game says who it is with its Cognito ID token (or, with no
 * account, a guest's token) and which room it wants in the address it connects to (`?token=...&room=...`). This checks the token, checks that the player is a member of the room, and answers with a policy that lets
 * the connection do exactly this: connect under its own name (see `liveClientId`), hear that one room, and say where the piece in *its own* hand is. Nothing else, in no other room.
 */

/** IoT asks again this often, so that a player who was removed from the room (or whose token has run out) loses the connection soon. IoT wants more than 5 minutes here, in every answer. */
export const REFRESH_S = 600;
/** However it goes, the connection is dropped after this and the game connects again with a fresh token. */
export const DISCONNECT_S = 3600;

export interface AuthorizerEvent {
  token?: string;
  protocolData?: { http?: { queryString?: string }; mqtt?: { password?: string } };
}

export interface AuthorizerResult {
  isAuthenticated: boolean;
  principalId: string;
  policyDocuments: string[];
  disconnectAfterInSeconds: number;
  refreshAfterInSeconds: number;
}

// IoT checks the times in a "no" too, and turns an answer with others (0, say) down as invalid
const DENIED: AuthorizerResult = { isAuthenticated: false, principalId: 'denied', policyDocuments: [], disconnectAfterInSeconds: DISCONNECT_S, refreshAfterInSeconds: REFRESH_S };

/** The policy for one player in one room. `arn(kind, name)` makes the address of a client, topic or topic filter. Both ids are plain letters, digits, `-` and `_`: nothing in them is a wildcard. */
export function policyFor(arn: (kind: 'client' | 'topic' | 'topicfilter', name: string) => string, room: string, player: string): string {
  const events = `puzzle/${room}/events`;
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 'iot:Connect', Resource: arn('client', `${room}:${player}:*`) },
      { Effect: 'Allow', Action: 'iot:Subscribe', Resource: [arn('topicfilter', events), arn('topicfilter', `puzzle/${room}/hand/+`)] },
      { Effect: 'Allow', Action: 'iot:Receive', Resource: [arn('topic', events), arn('topic', `puzzle/${room}/hand/*`)] },
      { Effect: 'Allow', Action: 'iot:Publish', Resource: arn('topic', `puzzle/${room}/hand/${player}`) },
    ],
  });
}

export interface AuthorizerDeps {
  verifier: { verify(token: string): Promise<Record<string, unknown> | undefined> };
  guests: { verify(token: string): Promise<string | null> };
  rooms: { membersOf(roomId: string): Promise<string[] | undefined> };
  arn: (kind: 'client' | 'topic' | 'topicfilter', name: string) => string;
}

export function makeAuthorizer(d: AuthorizerDeps) {
  return async (event: AuthorizerEvent): Promise<AuthorizerResult> => {
    const query = new URLSearchParams(event.protocolData?.http?.queryString ?? '');
    const token = query.get('token') ?? event.token ?? '';
    const room = query.get('room') ?? '';
    if (!token || !/^[\w-]{1,64}$/.test(room)) return DENIED;
    const guest = isGuestToken(token) ? await d.guests.verify(token) : null;
    const player = guest ? { id: guest } : playerFrom(await d.verifier.verify(token));
    if (!player) return DENIED;
    if (!(await d.rooms.membersOf(room))?.includes(player.id)) return DENIED;
    return {
      isAuthenticated: true,
      // alphanumeric only, as IoT asks
      principalId: player.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 128) || 'player',
      policyDocuments: [policyFor(d.arn, room, player.id)],
      disconnectAfterInSeconds: DISCONNECT_S,
      refreshAfterInSeconds: REFRESH_S,
    };
  };
}

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

let ready: Promise<ReturnType<typeof makeAuthorizer>> | undefined;

async function build(context: Context): Promise<ReturnType<typeof makeAuthorizer>> {
  const region = need('AWS_REGION');
  const account = context.invokedFunctionArn.split(':')[4];
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: need('SIGNING_SECRET_ARN') }));
  if (!secret.SecretString) throw new Error('The signing secret is empty');
  return makeAuthorizer({
    verifier: new CognitoVerifier(`https://cognito-idp.${region}.amazonaws.com/${need('USER_POOL_ID')}`, need('CLIENT_ID'), fetchJson, systemClock),
    guests: new GuestTokens(new TextEncoder().encode(secret.SecretString), systemClock),
    rooms: new DynamoStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), need('TABLE_NAME'), systemClock),
    arn: (kind, name) => `arn:aws:iot:${region}:${account}:${kind}/${name}`,
  });
}

export const handler = async (event: AuthorizerEvent, context: Context): Promise<AuthorizerResult> => {
  ready ??= build(context).catch((e) => {
    ready = undefined;                     // try again at the next connection
    throw e;
  });
  // an error (the table cannot be read, say) is not caught: IoT turns the connection away, the game tries again by itself, and the alarm on the function's errors is told
  return (await ready)(event);
};
