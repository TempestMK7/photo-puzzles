import { AdminDeleteUserCommand, AdminGetUserCommand, type CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Accounts } from '../types';

/** The user pool, which forgets an account when asked (and says which outside providers are joined to one; the function may do nothing else to it). The player's id is the `sub` of the token, which the pool takes in place of a user name. */
export class CognitoAccounts implements Accounts {
  constructor(
    private readonly client: Pick<CognitoIdentityProviderClient, 'send'>,
    private readonly poolId: string,
  ) {}

  async linked(playerId: string): Promise<string[]> {
    try {
      const user = await this.client.send(new AdminGetUserCommand({ UserPoolId: this.poolId, Username: playerId }));
      const raw = user.UserAttributes?.find((a) => a.Name === 'identities')?.Value;
      const list = raw ? (JSON.parse(raw) as { providerName?: unknown }[]) : [];
      return list.flatMap((i) => (typeof i.providerName === 'string' ? [i.providerName] : []));
    } catch {
      return [];                                                                     // (the game then offers to add one: asking again says no if it is there)
    }
  }

  async delete(playerId: string): Promise<void> {
    try {
      await this.client.send(new AdminDeleteUserCommand({ UserPoolId: this.poolId, Username: playerId }));
    } catch (e) {
      if ((e as { name?: string })?.name !== 'UserNotFoundException') throw e;      // gone already: asking again after a failure is fine
    }
  }
}
