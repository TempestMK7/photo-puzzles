import { AdminDeleteUserCommand, type CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Accounts } from '../types';

/** The user pool, which forgets an account when asked (the function may do nothing else to it). The player's id is the `sub` of the token, which the pool takes in place of a user name. */
export class CognitoAccounts implements Accounts {
  constructor(
    private readonly client: Pick<CognitoIdentityProviderClient, 'send'>,
    private readonly poolId: string,
  ) {}

  async delete(playerId: string): Promise<void> {
    try {
      await this.client.send(new AdminDeleteUserCommand({ UserPoolId: this.poolId, Username: playerId }));
    } catch (e) {
      if ((e as { name?: string })?.name !== 'UserNotFoundException') throw e;      // gone already: asking again after a failure is fine
    }
  }
}
