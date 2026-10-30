import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { IoTClient, DescribeEndpointCommand } from '@aws-sdk/client-iot';
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import { S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DEFAULT_LIMITS } from '../../../src/online/protocol';
import { SystemRandom, systemClock } from '../memory';
import { RateLimiter } from '../ratelimit';
import { createRouter, type Req, type Res } from '../router';
import { RoomService } from '../service';
import { GuestTokens, TokenAuth } from '../guest';
import { Signer } from '../signing';
import type { Auth, Limits } from '../types';
import { playerFrom } from './claims';
import { CognitoAccounts } from './cognito';
import { DynamoPresence, DynamoRates, DynamoStore } from './dynamo';
import { CognitoVerifier, fetchJson } from './jwt';
import { IotPubSub } from './iot';
import { S3Media } from './s3media';

/**
 * The API as a Lambda function behind an API Gateway HTTP API. Making a puzzle needs an account, so the gateway has already checked the Cognito ID token on that route (and the function
 * is given who it is). Every other route (joining a puzzle, the player's name, the guest token itself) is also open to guests: the function checks the token it is shown, a Cognito one or a
 * guest's. The picture upload has no sign-in at all (its address is signed).
 */

export { playerFrom };

export function toReq(event: APIGatewayProxyEventV2WithJWTAuthorizer): Req {
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body)) : Buffer.alloc(0);
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: new URLSearchParams(event.rawQueryString),
    authorization: event.headers?.authorization,
    ip: event.requestContext.http.sourceIp,
    body: new Uint8Array(body),
    player: playerFrom(event.requestContext.authorizer?.jwt?.claims),
  };
}

export function toResult(res: Res): APIGatewayProxyStructuredResultV2 {
  if (res.body instanceof Uint8Array) {
    return { statusCode: res.status, isBase64Encoded: true, body: Buffer.from(res.body).toString('base64'), headers: { 'content-type': res.type ?? 'application/octet-stream' } };
  }
  return { statusCode: res.status, body: JSON.stringify(res.body), headers: { 'content-type': 'application/json' } };
}

export function makeHandler(route: (req: Req) => Promise<Res>) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      return toResult(await route(toReq(event)));
    } catch (e) {
      console.error(e);
      return toResult({ status: 500, body: { ok: false, error: 'bad-request' } });
    }
  };
}

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** What the deployment says (infra/lib/api-stack.ts), turned into the service. The operator's function (admin.ts) runs the same service. */
export async function buildService() {
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: need('SIGNING_SECRET_ARN') }));
  if (!secret.SecretString) throw new Error('The signing secret is empty');
  const key = new TextEncoder().encode(secret.SecretString);
  const signer = new Signer(key, systemClock);
  const guests = new GuestTokens(key, systemClock);
  const cognito = new CognitoVerifier(`https://cognito-idp.${need('AWS_REGION')}.amazonaws.com/${need('USER_POOL_ID')}`, need('CLIENT_ID'), fetchJson, systemClock);
  const accounts: Auth = { verify: async (token) => playerFrom(await cognito.verify(token)) ?? null };
  const endpoint = (await new IoTClient({}).send(new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }))).endpointAddress;
  if (!endpoint) throw new Error('IoT has no endpoint');

  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sns = new SNSClient({});
  const table = need('TABLE_NAME');
  const media = new S3Media(new S3Client({}), need('MEDIA_BUCKET'), signer, need('API_BASE'));
  // the picture is sent through the API and a Lambda can take about 6 MB in a request (a little less than that once it is base64), so a picture may be at most 4 MB
  const limits: Limits = { ...DEFAULT_LIMITS, pictureBytes: 4_000_000, ...(JSON.parse(process.env.LIMITS ?? '{}') as Partial<Limits>) };
  const service = new RoomService({
    store: new DynamoStore(db, table, systemClock),
    media,
    pubsub: new IotPubSub(new IoTDataPlaneClient({ endpoint: `https://${endpoint}` })),
    presence: new DynamoPresence(db, table, systemClock),
    clock: systemClock,
    random: new SystemRandom(),
    limits,
    webBase: need('WEB_BASE'),
    accounts: new CognitoAccounts(new CognitoIdentityProviderClient({}), need('USER_POOL_ID')),
    // a report goes to the alarm topic, so that it reaches the operator's e-mail
    notify: async (text) => void (await sns.send(new PublishCommand({ TopicArn: need('ALERT_TOPIC_ARN'), Subject: 'PuzzleVidio: a puzzle was reported', Message: text }))),
  });
  return { service, media, guests, auth: new TokenAuth(guests, accounts), db, table };
}

async function build(): Promise<(req: Req) => Promise<Res>> {
  const { service, media, guests, auth, db, table } = await buildService();
  const limiter = new RateLimiter(new DynamoRates(db, table, systemClock), systemClock);
  return createRouter({ service, auth, media, guests, limiter });
}

let router: Promise<(req: Req) => Promise<Res>> | undefined;

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  router ??= build().catch((e) => {
    router = undefined;                       // try again at the next request
    throw e;
  });
  return makeHandler(await router.catch(() => async () => ({ status: 503, body: { ok: false, error: 'bad-request' } } satisfies Res)))(event);
};
