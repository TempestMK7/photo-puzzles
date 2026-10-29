import { Tags, type App } from 'aws-cdk-lib';
import { ApiStack } from './api-stack';
import { AuthStack } from './auth-stack';
import { REGION, STAGES, apiDomain, settings, siteDomain, siteOrigins, stackName } from './config';
import { DataStack } from './data-stack';
import { LiveStack } from './live-stack';
import { OpsStack } from './ops-stack';
import { WebStack } from './web-stack';

/** Every stack of every stage. The account comes from the credentials that run `cdk`; nothing about it is written down here. */
export function build(app: App): void {
  const s = settings(app.node);
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

  new OpsStack(app, stackName('shared', 'Ops'), { env, budgetUsd: s.budgetUsd, alertEmail: s.alertEmail, githubRepo: s.githubRepo, githubProviderArn: s.githubProviderArn });

  for (const stage of STAGES) {
    const origins = siteOrigins(stage, s.zoneName);
    const data = new DataStack(app, stackName(stage, 'Data'), { env, stage, origins });
    const auth = new AuthStack(app, stackName(stage, 'Auth'), {
      env,
      stage,
      origins,
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
      origins,
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
