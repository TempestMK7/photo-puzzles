import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { ALARM_TOPIC_NAME, DEPLOY_ROLE_NAME } from './config';

export interface OpsStackProps extends StackProps {
  budgetUsd: number;
  alertEmail?: string;
  githubRepo: string;
  githubProviderArn?: string;
}

/**
 * What belongs to the account and not to a stage: a budget that writes when the bill grows, a topic for alarms, and the role that GitHub Actions deploys with
 * (an OIDC role: no AWS keys are stored in GitHub). It is deployed first, by hand, with the owner's own credentials.
 */
export class OpsStack extends Stack {
  readonly alarms: sns.Topic;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    this.alarms = new sns.Topic(this, 'Alarms', { topicName: ALARM_TOPIC_NAME, displayName: 'PuzzleVidio alarms' });
    if (props.alertEmail) this.alarms.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));

    if (props.alertEmail) {
      const notify = (type: 'ACTUAL' | 'FORECASTED', threshold: number): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
        notification: { notificationType: type, comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail! }],
      });
      new budgets.CfnBudget(this, 'Monthly', {
        budget: { budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: props.budgetUsd, unit: 'USD' } },
        notificationsWithSubscribers: [notify('ACTUAL', 50), notify('ACTUAL', 80), notify('ACTUAL', 100), notify('FORECASTED', 100)],
      });
    }

    const provider = props.githubProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHub', props.githubProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHub', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });

    // Only the main branch of this repository can take the role, and all it can do by itself is to use the roles that `cdk bootstrap` made: they hold the real permissions.
    this.deployRole = new iam.Role(this, 'Deploy', {
      roleName: DEPLOY_ROLE_NAME,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:ref:refs/heads/main` },
      }),
    });
    this.deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [`arn:aws:iam::${this.account}:role/cdk-*`] }));
    // To read what a stack made (its outputs) and to find the bucket and distribution to put the game in.
    this.deployRole.addToPolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources: ['*'] }));
  }
}
