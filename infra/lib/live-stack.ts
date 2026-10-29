import { Arn, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { ALARM_TOPIC_NAME, liveAuthorizerName, type Stage } from './config';
import { functionDefaults, logGroup, repo } from './lambda';

export interface LiveStackProps extends StackProps {
  stage: Stage;
  table: dynamodb.ITable;
  pool: cognito.IUserPool;
  client: cognito.IUserPoolClient;
}

/**
 * The live side of a room, on AWS IoT Core (MQTT over WebSocket, see `docs/online-realtime.md`). The broker itself needs nothing made for it; this stack has the two things around it:
 *   - the custom authorizer: the game connects to the broker with its Cognito token and a room, and the function (server/src/aws/authorizer.ts) lets it in only if the player is a
 *     member of that room, with a policy for that room alone;
 *   - the presence function (server/src/aws/presence.ts), which a rule hands the broker's connect and disconnect events to, so that the room knows who is online.
 */
export class LiveStack extends Stack {
  constructor(scope: Construct, id: string, props: LiveStackProps) {
    super(scope, id, props);
    const alarms = sns.Topic.fromTopicArn(this, 'Alarms', Arn.format({ service: 'sns', resource: ALARM_TOPIC_NAME }, this));
    const common = functionDefaults;

    const authorizer = new nodejs.NodejsFunction(this, 'Authorizer', {
      ...common,
      entry: repo('server/src/aws/authorizer.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: logGroup(this, 'AuthorizerLogs'),
      environment: { ...common.environment, USER_POOL_ID: props.pool.userPoolId, CLIENT_ID: props.client.userPoolClientId, TABLE_NAME: props.table.tableName },
    });
    // it reads one item (who is in the room) and nothing else
    authorizer.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [props.table.tableArn] }));

    // Signing is off because a browser cannot sign a WebSocket address; the function checks the Cognito token itself, so a call with no good token gets nothing.
    const registered = new iot.CfnAuthorizer(this, 'Registered', { authorizerName: liveAuthorizerName(props.stage), authorizerFunctionArn: authorizer.functionArn, signingDisabled: true, status: 'ACTIVE' });
    authorizer.addPermission('FromIot', { principal: new iam.ServicePrincipal('iot.amazonaws.com'), sourceArn: registered.attrArn });

    const presence = new nodejs.NodejsFunction(this, 'Presence', {
      ...common,
      entry: repo('server/src/aws/presence.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(20),
      logGroup: logGroup(this, 'PresenceLogs'),
      environment: { ...common.environment, TABLE_NAME: props.table.tableName },
    });
    presence.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query'], resources: [props.table.tableArn] }));
    // what it says about a room goes to the room's topic, and the address of the broker is asked for when the function starts
    presence.addToRolePolicy(new iam.PolicyStatement({ actions: ['iot:Publish'], resources: [this.formatArn({ service: 'iot', resource: 'topic', resourceName: 'puzzle/*' })] }));
    presence.addToRolePolicy(new iam.PolicyStatement({ actions: ['iot:DescribeEndpoint'], resources: ['*'] }));

    // The broker publishes these events for every connection of the account: the function ignores the ones that are not of a room here (see presence.ts).
    const rule = new iot.CfnTopicRule(this, 'Lifecycle', {
      ruleName: `puzzlevidio_${props.stage}_presence`,
      topicRulePayload: {
        sql: "SELECT clientId, eventType FROM '$aws/events/presence/+/+'",
        awsIotSqlVersion: '2016-03-23',
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: presence.functionArn } }],
      },
    });
    presence.addPermission('FromRule', { principal: new iam.ServicePrincipal('iot.amazonaws.com'), sourceArn: rule.attrArn, sourceAccount: this.account });

    const alarm = (name: string, fn: nodejs.NodejsFunction, description: string) => {
      const a = new cloudwatch.Alarm(this, name, {
        metric: fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      a.addAlarmAction(new actions.SnsAction(alarms));
    };
    alarm('AuthorizerErrors', authorizer, 'The broker authorizer threw an error: players cannot join the live side of a room');
    alarm('PresenceErrors', presence, 'The presence function threw an error: who is online may be wrong');

    new CfnOutput(this, 'AuthorizerName', { value: liveAuthorizerName(props.stage) });
    new CfnOutput(this, 'AuthorizerFunction', { value: authorizer.functionName });
    new CfnOutput(this, 'PresenceFunction', { value: presence.functionName });
  }
}
