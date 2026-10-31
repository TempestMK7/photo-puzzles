import { Tags, type App } from 'aws-cdk-lib';
import { ApiStack } from './api-stack';
import { AuthStack } from './auth-stack';
import { APP_ORIGINS, REGION, STAGES, apiDomain, settings, siteDomain, siteOrigins, stackName } from './config';
import { DataStack } from './data-stack';
import { LiveStack } from './live-stack';
import { OpsStack } from './ops-stack';
import { WebStack } from './web-stack';

/** Every stack of every stage. The account comes from the credentials that run `cdk`; nothing about it is written down here. */
export function build(app: App): void {
  const s = settings(app.node);
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

  new OpsStack(app, stackName('shared', 'Ops'), { env, zoneName: s.zoneName, hostedZoneId: s.hostedZoneId, budgetUsd: s.budgetUsd, alertEmail: s.alertEmail, githubRepo: s.githubRepo, githubSubjectPrefix: s.githubSubjectPrefix, githubProviderArn: s.githubProviderArn });

  for (const stage of STAGES) {
    const origins = siteOrigins(stage, s.zoneName);
    // the Android app's pages may call the API and use the picture storage too (but they are not a return address for the sign-in page)
    const calling = [...origins, ...APP_ORIGINS];
    const data = new DataStack(app, stackName(stage, 'Data'), { env, stage, origins: calling });
    const auth = new AuthStack(app, stackName(stage, 'Auth'), {
      env,
      stage,
      origins,
      emailDomain: s.zoneName,
      cognitoEmail: s.cognitoEmail,
      google: s.googleClientId && s.googleSecretName ? { clientId: s.googleClientId, secretName: s.googleSecretName } : undefined,
    });
    new WebStack(app, stackName(stage, 'Web'), { env, stage, zoneName: s.zoneName, hostedZoneId: s.hostedZoneId, domain: siteDomain(stage, s.zoneName) });
    new ApiStack(app, stackName(stage, 'Api'), {
      env,
      stage,
      zoneName: s.zoneName,
      hostedZoneId: s.hostedZoneId,
      domain: apiDomain(stage, s.zoneName),
      webDomain: siteDomain(stage, s.zoneName),
      origins: calling,
      limits: s.limits,
      admobAdUnits: s.admobAdUnits,
      pexelsSecretName: s.pexelsSecretName,
      pixabaySecretName: s.pixabaySecretName,
      table: data.table,
      media: data.media,
      signing: data.signingKey,
      pool: auth.pool,
      client: auth.client,
    });
    new LiveStack(app, stackName(stage, 'Live'), { env, stage, table: data.table, pool: auth.pool, client: auth.client, signing: data.signingKey });
  }

  Tags.of(app).add('app', 'puzzlevidio');
}
