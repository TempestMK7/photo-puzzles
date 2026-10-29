import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { build } from '../lib/app';
import { settings, siteDomain, siteOrigins } from '../lib/config';

const context = { hostedZoneId: 'ZTESTZONE', alertEmail: 'alerts@example.com', 'aws:cdk:bundling-stacks': [] };
const app = (extra: Record<string, string> = {}) => {
  const a = new App({ context: { ...context, ...extra } });
  build(a);
  return a;
};
const stack = (a: App, name: string) => Template.fromStack(a.node.findChild(name) as never);

describe('settings', () => {
  it('needs the hosted zone', () => {
    expect(() => settings(new App().node)).toThrow(/hosted zone/);
  });
  it('wants Google as a whole or not at all', () => {
    expect(() => new App({ context: { ...context, googleClientId: 'x' } }) && build(new App({ context: { ...context, googleClientId: 'x' } }))).toThrow(/both/);
  });
  it('serves the real game at the bare domain and the others below it', () => {
    expect(siteDomain('prod', 'puzzlevid.io')).toBe('puzzlevid.io');
    expect(siteDomain('dev', 'puzzlevid.io')).toBe('dev.puzzlevid.io');
    expect(siteOrigins('prod', 'puzzlevid.io')).toEqual(['https://puzzlevid.io']);
    expect(siteOrigins('dev', 'puzzlevid.io')).toContain('http://localhost:5173');
  });
});

describe('data', () => {
  const dev = stack(app(), 'PuzzleVidio-dev-Data');
  const prod = stack(app(), 'PuzzleVidio-prod-Data');

  it('bills per request and lets items expire', () => {
    dev.hasResourceProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST', TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } });
  });
  it('keeps the data of the real stage, and can lose that of a test stage', () => {
    prod.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain', Properties: { DeletionProtectionEnabled: true } });
    dev.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });
  it('has a private bucket for pictures, with a backstop that deletes old ones', () => {
    prod.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 35 })]) },
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['https://puzzlevid.io'] })] },
    });
    prod.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });
});

describe('auth', () => {
  it('signs in with e-mail, by the code flow without a secret', () => {
    const t = stack(app(), 'PuzzleVidio-prod-Auth');
    t.hasResourceProperties('AWS::Cognito::UserPool', { UsernameAttributes: ['email'], AutoVerifiedAttributes: ['email'], DeletionProtection: 'ACTIVE' });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      CallbackURLs: ['https://puzzlevid.io/'],
      SupportedIdentityProviders: ['COGNITO'],
    });
  });
  it('lets a local game sign in to the test stage only', () => {
    stack(app(), 'PuzzleVidio-dev-Auth').hasResourceProperties('AWS::Cognito::UserPoolClient', { CallbackURLs: ['https://dev.puzzlevid.io/', 'http://localhost:5173/'] });
  });
  it('adds Google when it is configured, and takes the secret from Secrets Manager', () => {
    const t = stack(app({ googleClientId: 'client-id', googleSecretName: 'puzzlevidio/google' }), 'PuzzleVidio-prod-Auth');
    t.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', { ProviderType: 'Google' });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { SupportedIdentityProviders: ['COGNITO', 'Google'] });
    expect(JSON.stringify(t.toJSON())).toContain('resolve:secretsmanager:puzzlevidio/google');
  });
});

describe('web', () => {
  const t = stack(app(), 'PuzzleVidio-prod-Web');
  it('serves a private bucket through CloudFront, over https only, at the domain', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['puzzlevid.io'],
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021' }),
      }),
    });
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });
  it('has a certificate that is checked through DNS, and records for the domain', () => {
    t.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'puzzlevid.io', ValidationMethod: 'DNS' });
    t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'puzzlevid.io.', Type: 'A' });
    t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'puzzlevid.io.', Type: 'AAAA' });
  });
  it('gives the deploy role the right to put files in the bucket and clear the cache, and nothing else', () => {
    const policies = t.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }).Properties.PolicyDocument.Statement);
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions.sort()).toEqual(['cloudfront:CreateInvalidation', 's3:DeleteObject', 's3:ListBucket', 's3:PutObject']);
  });
});

describe('ops', () => {
  const t = stack(app(), 'PuzzleVidio-shared-Ops');
  it('lets only the main branch of the repository take the deploy role', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'puzzlevidio-github-deploy',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:TempestMK7/photo-puzzles:ref:refs/heads/main' },
            },
          }),
        ],
      },
    });
  });
  it('can only use the roles of the bootstrap (and read stacks), not change the account itself', () => {
    const statements = Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
      (p) => (p as { Properties: { PolicyDocument: { Statement: { Action: string }[] } } }).Properties.PolicyDocument.Statement,
    );
    expect(statements.map((s) => s.Action).sort()).toEqual(['cloudformation:DescribeStacks', 'sts:AssumeRole']);
  });
  it('uses the OIDC provider that the account already has, if it is named', () => {
    const arn = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
    const other = stack(app({ githubProviderArn: arn }), 'PuzzleVidio-shared-Ops');
    other.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    t.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  });
  it('says the address of the deploy role, for the GitHub variable', () => {
    expect(Object.keys(t.findOutputs('*'))).toEqual(['DeployRoleArn']);
  });
  it('has the topic that the alarms are sent to, under a name the other stacks know', () => {
    t.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'puzzlevidio-alarms' });
  });
  it('writes when the bill grows, if there is someone to write to', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', { Budget: { BudgetLimit: { Amount: 25, Unit: 'USD' }, TimeUnit: 'MONTHLY' } });
    const without = new App({ context: { hostedZoneId: 'Z', 'aws:cdk:bundling-stacks': [] } });
    build(without);
    Template.fromStack(without.node.findChild('PuzzleVidio-shared-Ops') as never).resourceCountIs('AWS::Budgets::Budget', 0);
  });
});

type Statement = { Effect: string; Action: string | string[]; Resource: unknown };
const statementsOf = (t: Template, role?: RegExp): Statement[] =>
  Object.entries(t.findResources('AWS::IAM::Policy'))
    .filter(([id]) => !role || role.test(id))
    .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement);
const actionsOf = (st: Statement[]) => st.flatMap((x) => (Array.isArray(x.Action) ? x.Action : [x.Action]));

describe('api', () => {
  const prod = stack(app(), 'PuzzleVidio-prod-Api');
  const dev = stack(app(), 'PuzzleVidio-dev-Api');

  it('is at its own address, with a certificate, and has no other', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: 'api.puzzlevid.io' });
    dev.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: 'api.dev.puzzlevid.io' });
    prod.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'api.puzzlevid.io', ValidationMethod: 'DNS' });
    prod.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'api.puzzlevid.io.', Type: 'A' });
    prod.hasResourceProperties('AWS::ApiGatewayV2::Api', { DisableExecuteApiEndpoint: true });
  });

  it('checks the Cognito ID token on every route but the upload of a picture', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT', JwtConfiguration: { Audience: [Match.anyValue()], Issuer: Match.anyValue() } });
    const routes = Object.values(prod.findResources('AWS::ApiGatewayV2::Route')).map((r) => (r as { Properties: { RouteKey: string; AuthorizationType?: string } }).Properties);
    expect(routes.map((r) => [r.RouteKey, r.AuthorizationType ?? 'NONE']).sort()).toEqual(
      [
        ['GET /rooms', 'JWT'],
        ['GET /rooms/{proxy+}', 'JWT'],
        ['POST /join', 'JWT'],
        ['POST /rooms', 'JWT'],
        ['POST /rooms/{proxy+}', 'JWT'],
        ['PUT /media/{id}', 'NONE'],
      ].sort(),
    );
  });

  it("lets browsers call it only from the game's own addresses", () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: Match.objectLike({ AllowOrigins: ['https://puzzlevid.io'], AllowHeaders: ['Authorization', 'Content-Type'] }) });
    dev.hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: Match.objectLike({ AllowOrigins: ['https://dev.puzzlevid.io', 'http://localhost:5173'] }) });
  });

  it('has a limit on how fast it answers, a low one for the test stage', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingRateLimit: 1000, ThrottlingBurstLimit: 2000 } });
    dev.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 } });
  });

  it('runs the service on Node 22 with a month of logs, and its settings in the environment but not the key', () => {
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: { Variables: Match.objectLike({ API_BASE: 'https://api.puzzlevid.io', WEB_BASE: 'https://puzzlevid.io', TABLE_NAME: Match.anyValue(), MEDIA_BUCKET: Match.anyValue(), SIGNING_SECRET_ARN: Match.anyValue() }) },
    });
    prod.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    const text = JSON.stringify(prod.toJSON());
    expect(text).not.toContain('resolve:secretsmanager');                  // the function reads the key when it starts; it is not put in the template
    prod.hasResourceProperties('AWS::SecretsManager::Secret', { GenerateSecretString: Match.objectLike({ PasswordLength: 48 }) });
  });

  it('can publish only to the topics of puzzles, and does no more than it must', () => {
    const st = statementsOf(prod, /^ApiServiceRole|ApiDefaultPolicy|ApiServiceRoleDefaultPolicy/);
    const iot = st.filter((x) => actionsOf([x]).some((a) => a.startsWith('iot:')));
    expect(iot.map((x) => actionsOf([x]).join()).sort()).toEqual(['iot:DescribeEndpoint', 'iot:Publish']);
    const publish = iot.find((x) => actionsOf([x]).includes('iot:Publish'))!;
    expect(JSON.stringify(publish.Resource)).toContain('topic/puzzle/*');
    expect(actionsOf(st)).not.toContain('*');
    expect(actionsOf(st).filter((a) => a.startsWith('secretsmanager:')).sort()).toEqual(['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
  });

  it('deletes the picture of a room when the room is removed from the table, and can do nothing else to the bucket', () => {
    prod.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 25,
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 5,
      StartingPosition: 'LATEST',
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ eventName: ['REMOVE'] }) }] },
    });
    const st = statementsOf(prod, /Cleanup/);
    const s3 = actionsOf(st).filter((a) => a.startsWith('s3:'));
    expect(s3.every((a) => a.startsWith('s3:DeleteObject'))).toBe(true);
    expect(s3.length).toBeGreaterThan(0);
  });

  it('tells the alarm topic when something fails', () => {
    const alarms = Object.values(prod.findResources('AWS::CloudWatch::Alarm')).map((a) => (a as { Properties: { AlarmActions: unknown[]; MetricName: string } }).Properties);
    expect(alarms.map((a) => a.MetricName).sort()).toEqual(['5xx', 'Errors', 'Errors', 'Throttles']);
    for (const a of alarms) expect(JSON.stringify(a.AlarmActions)).toContain('puzzlevidio-alarms');
  });
});
