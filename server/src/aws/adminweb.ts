import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AdminLogEvent, AdminLogGroup } from '../../../src/online/adminProtocol';
import { makeAdminWeb, parseGroups, type AdminWebReq, type AdminWebRes, type Directory, type DirectoryUser, type LogSource } from '../adminweb';
import { systemClock } from '../memory';
import { buildService } from './api';

/**
 * The admin page's function (see adminweb.ts for what it answers): the routes under /admin of the API, behind the gateway's check of the Cognito token. It may list the accounts of
 * the user pool and read the logs of this deployment's functions, besides what the operator's function (admin.ts) may do.
 */

const PAGE = 60;

/** The accounts of the user pool, a page at a time. */
export class CognitoDirectory implements Directory {
  constructor(
    private readonly client: Pick<CognitoIdentityProviderClient, 'send'>,
    private readonly poolId: string,
  ) {}

  async listUsers(next?: string): Promise<{ users: DirectoryUser[]; next?: string }> {
    const res = await this.client.send(new ListUsersCommand({ UserPoolId: this.poolId, Limit: PAGE, PaginationToken: next }));
    const users = (res.Users ?? []).map((u) => {
      const attr = (name: string) => u.Attributes?.find((a) => a.Name === name)?.Value ?? '';
      return { id: attr('sub') || (u.Username ?? ''), email: attr('email'), created: u.UserCreateDate?.getTime() ?? 0, status: u.UserStatus ?? '', enabled: u.Enabled !== false };
    });
    return { users, next: res.PaginationToken };
  }
}

/** `PuzzleVidio-dev-Api-ApiLogs3D05D88B-RmE2OgIY9qKH` -> `Api`; `...-Live-AuthorizerLogsBA5DABC9-...` -> `Authorizer`. Anything else keeps its name. */
export function friendlyLogName(name: string): string {
  return /^[^-]+-[^-]+-[^-]+-(.+?)Logs[0-9A-F]{8}-/.exec(name)?.[1] ?? name;
}

const MESSAGE_MAX = 2000;

/** The logs of this deployment's functions: every log group whose name starts with `PuzzleVidio-<stage>-`. */
export class CloudWatchLogSource implements LogSource {
  constructor(
    private readonly client: Pick<CloudWatchLogsClient, 'send'>,
    private readonly prefix: string,
  ) {}

  async groups(): Promise<AdminLogGroup[]> {
    const out: AdminLogGroup[] = [];
    let next: string | undefined;
    do {
      const res = await this.client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: this.prefix, nextToken: next }));
      for (const g of res.logGroups ?? []) if (g.logGroupName) out.push({ name: g.logGroupName, label: friendlyLogName(g.logGroupName) });
      next = res.nextToken;
    } while (next);
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  async events(group: string, since: number, filter: string, limit: number): Promise<AdminLogEvent[]> {
    const events: AdminLogEvent[] = [];
    let next: string | undefined;
    do {
      const res = await this.client.send(new FilterLogEventsCommand({ logGroupName: group, startTime: since, filterPattern: filter || undefined, limit, nextToken: next }));
      for (const e of res.events ?? []) events.push({ t: e.timestamp ?? 0, message: (e.message ?? '').trimEnd().slice(0, MESSAGE_MAX) });
      next = res.nextToken;
    } while (next && events.length < limit);
    return events.sort((a, b) => b.t - a.t).slice(0, limit);
  }
}

export function toAdminReq(event: APIGatewayProxyEventV2WithJWTAuthorizer): AdminWebReq {
  let body: unknown = {};
  if (event.body) {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
    } catch {
      body = {};
    }
  }
  return {
    method: event.requestContext.http.method,
    path: event.rawPath.replace(/\/+$/, ''),
    query: new URLSearchParams(event.rawQueryString),
    body,
    groups: parseGroups(event.requestContext.authorizer?.jwt?.claims?.['cognito:groups']),
  };
}

export const toAdminResult = (res: AdminWebRes): APIGatewayProxyStructuredResultV2 => ({ statusCode: res.status, body: JSON.stringify(res.body), headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

let run: Promise<(req: AdminWebReq) => Promise<AdminWebRes>> | undefined;

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    run ??= buildService()
      .then(({ service }) =>
        makeAdminWeb({
          service,
          directory: new CognitoDirectory(new CognitoIdentityProviderClient({}), need('USER_POOL_ID')),
          logs: new CloudWatchLogSource(new CloudWatchLogsClient({}), `PuzzleVidio-${need('STAGE')}-`),
          now: () => systemClock.now(),
        }),
      )
      .catch((e) => {
        run = undefined;                       // try again at the next request
        throw e;
      });
    return toAdminResult(await (await run)(toAdminReq(event)));
  } catch (e) {
    console.error(e);
    return toAdminResult({ status: 500, body: { ok: false, error: 'failed' } });
  }
};
