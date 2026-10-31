import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import { ADMIN_GROUP, APP_SIGN_IN_REDIRECTS, MAIL_FROM_NAME, mailFrom, REGION, type Stage } from './config';

export interface AuthStackProps extends StackProps {
  stage: Stage;
  /** Where the game is served from: sign-in sends the player back to one of these. */
  origins: string[];
  /** The domain whose SES identity the e-mails are sent from (the Ops stack verifies it). */
  emailDomain: string;
  google?: { clientId: string; secretName: string };
}

/**
 * Accounts: e-mail with a password, and Google. The game has its own sign-in and sign-up pages that call the user pool directly (a password sign-in with the e-mail address, the codes that
 * confirm an address and reset a password), and Cognito's sign-in page and the OAuth code flow with PKCE (no client secret in the game) stay for Google.
 */
export class AuthStack extends Stack {
  readonly pool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const prod = props.stage === 'prod';

    this.pool = new cognito.UserPool(this, 'Pool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true }, fullname: { required: false, mutable: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Eight characters with a capital, a small letter and a digit: the game's sign-up page lists exactly these (src/online/password.ts) when someone starts a password.
      passwordPolicy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: 'Your PuzzleVidio code',
        emailBody: 'Your PuzzleVidio code is {####}. If you did not ask for it, you can ignore this message.',
      },
      // From our own domain, through SES (Cognito's own sender is limited to 50 a day and shows an amazon address).
      email: cognito.UserPoolEmail.withSES({ fromEmail: mailFrom(props.emailDomain), fromName: MAIL_FROM_NAME, sesRegion: REGION, sesVerifiedDomain: props.emailDomain }),
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Whoever is in this group may use the admin page (https://<the game's address>/admin): its token says so, and the admin routes of the API check it. Put an account in it by
    // hand: `aws cognito-idp admin-add-user-to-group --user-pool-id <id> --username <the e-mail address> --group-name admins` (docs/runbook.md).
    new cognito.CfnUserPoolGroup(this, 'Admins', { userPoolId: this.pool.userPoolId, groupName: ADMIN_GROUP, description: 'May use the admin page' });

    const google = props.google
      ? new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
          userPool: this.pool,
          clientId: props.google.clientId,
          clientSecretValue: SecretValue.secretsManager(props.google.secretName),
          scopes: ['openid', 'email', 'profile'],
          attributeMapping: { email: cognito.ProviderAttribute.GOOGLE_EMAIL, fullname: cognito.ProviderAttribute.GOOGLE_NAME, profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE },
        })
      : undefined;

    // (the Android app signs in through the phone's browser and is sent back to its own address)
    const returns = [...props.origins.map((o) => `${o}/`), ...APP_SIGN_IN_REDIRECTS];
    this.client = this.pool.addClient('Game', {
      generateSecret: false,
      // The test stage also allows the "admin" sign-in, which only someone with AWS credentials can use (it is signed with them): it lets a script make a token for a test user.
      authFlows: { userPassword: true, userSrp: true, adminUserPassword: !prod },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: returns,
        logoutUrls: returns,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO, ...(google ? [cognito.UserPoolClientIdentityProvider.GOOGLE] : [])],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
    if (google) this.client.node.addDependency(google);

    // The address of the sign-in pages. A name of our own (auth.<domain>) needs a certificate and a record in the parent domain; later.
    const domain = this.pool.addDomain('Hosted', { cognitoDomain: { domainPrefix: `puzzlevidio-${props.stage}` } });

    new CfnOutput(this, 'UserPoolId', { value: this.pool.userPoolId });
    new CfnOutput(this, 'ClientId', { value: this.client.userPoolClientId });
    new CfnOutput(this, 'SignInHost', { value: domain.baseUrl() });
  }
}
