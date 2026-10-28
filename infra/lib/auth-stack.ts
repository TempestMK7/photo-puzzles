import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import type { Stage } from './config';

export interface AuthStackProps extends StackProps {
  stage: Stage;
  /** Where the game is served from: sign-in sends the player back to one of these. */
  origins: string[];
  google?: { clientId: string; secretName: string };
}

/** Accounts: e-mail with a password, and Google. Sign-in is the standard OAuth code flow with PKCE (no client secret in the game). */
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
      userVerification: { emailStyle: cognito.VerificationEmailStyle.CODE },
      // Cognito's own e-mail is limited to 50 a day: Amazon SES (and a verified sender in the domain) is needed before a public launch.
      email: cognito.UserPoolEmail.withCognito(),
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const google = props.google
      ? new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
          userPool: this.pool,
          clientId: props.google.clientId,
          clientSecretValue: SecretValue.secretsManager(props.google.secretName),
          scopes: ['openid', 'email', 'profile'],
          attributeMapping: { email: cognito.ProviderAttribute.GOOGLE_EMAIL, fullname: cognito.ProviderAttribute.GOOGLE_NAME },
        })
      : undefined;

    const returns = props.origins.map((o) => `${o}/`);
    this.client = this.pool.addClient('Game', {
      generateSecret: false,
      authFlows: { userSrp: true },
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
