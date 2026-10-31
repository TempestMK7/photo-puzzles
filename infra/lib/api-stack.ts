import { Arn, ArnFormat, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { ALARM_TOPIC_NAME, API_THROTTLE, BUSY_ALARMS, type Stage } from './config';
import { functionDefaults, logGroup, repo } from './lambda';

export interface ApiStackProps extends StackProps {
  stage: Stage;
  zoneName: string;
  hostedZoneId: string;
  /** The address of the API (`api.<the game's address>`). */
  domain: string;
  /** The address the game is served at (for the links that are sent to friends). */
  webDomain: string;
  /** Where browsers may call the API from. */
  origins: string[];
  table: dynamodb.ITable;
  media: s3.IBucket;
  /** The key that signs picture addresses and guest tokens (made in the Data stack). */
  signing: secretsmanager.ISecret;
  pool: cognito.IUserPool;
  client: cognito.IUserPoolClient;
  /** Changes to the service's limits (the deploy setting `limits`). */
  limits?: Record<string, number>;
}

/**
 * The API: an HTTP API on its own address in front of one Lambda function that runs the room service (server/src/aws/api.ts). API Gateway checks the Cognito ID token on every
 * route but the upload of a picture (whose address the service signed). A second function deletes a room's picture when the room's item is removed from the table.
 */
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.zoneName });
    const alarms = sns.Topic.fromTopicArn(this, 'Alarms', Arn.format({ service: 'sns', resource: ALARM_TOPIC_NAME }, this));

    const common = functionDefaults;

    // the room service, as two functions: the API (behind the gateway) and the operator's tools (no address: only someone who may invoke it can call it)
    const alarmTopicArn = Arn.format({ service: 'sns', resource: ALARM_TOPIC_NAME }, this);
    const serviceFunction = (name: string, entry: string, memorySize: number, timeout: Duration) => {
      const f = new nodejs.NodejsFunction(this, name, {
        ...common,
        entry: repo(entry),
        handler: 'handler',
        memorySize,
        timeout,
        logGroup: logGroup(this, `${name}Logs`),
        environment: {
          ...common.environment,
          TABLE_NAME: props.table.tableName,
          MEDIA_BUCKET: props.media.bucketName,
          SIGNING_SECRET_ARN: props.signing.secretArn,
          USER_POOL_ID: props.pool.userPoolId,
          CLIENT_ID: props.client.userPoolClientId,
          API_BASE: `https://${props.domain}`,
          WEB_BASE: `https://${props.webDomain}`,
          ALERT_TOPIC_ARN: alarmTopicArn,
          STAGE: props.stage,
          ...(props.limits ? { LIMITS: JSON.stringify(props.limits) } : {}),
        },
      });
      props.table.grantReadWriteData(f);
      props.media.grantReadWrite(f);
      props.signing.grantRead(f);
      // what the service publishes goes to the topics of the rooms, and the address of the broker is asked for when the function starts
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['iot:Publish'], resources: [this.formatArn({ service: 'iot', resource: 'topic', resourceName: 'puzzle/*' })] }));
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['iot:DescribeEndpoint'], resources: ['*'] }));
      // a report of a puzzle is sent to the alarm topic, which e-mails the operator
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['sns:Publish'], resources: [alarmTopicArn] }));
      return f;
    };
    const fn = serviceFunction('Api', 'server/src/aws/api.ts', 512, Duration.seconds(20));
    // deleting an account (the player asked for it) is the one thing the function does to the user pool
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminDeleteUser'], resources: [props.pool.userPoolArn] }));
    // the picture of every puzzle is looked at (for explicit, violent, disturbing or hateful content) before anyone else can see it
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['rekognition:DetectModerationLabels', 'rekognition:StartContentModeration', 'rekognition:GetContentModeration'], resources: ['*'] }));
    const admin = serviceFunction('Admin', 'server/src/aws/admin.ts', 512, Duration.seconds(30));
    // the operator can delete an account for someone who cannot sign in (the same one thing to the user pool)
    admin.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminDeleteUser'], resources: [props.pool.userPoolArn] }));
    // the admin page's function (https://<the game's address>/admin): the routes under /admin of the API, which the gateway only lets through with a Cognito token, and which check for
    // the admin group again. It lists the accounts of the user pool and reads the logs of this stage's functions, and does no more than that besides what the function above may do.
    const adminWeb = serviceFunction('AdminWeb', 'server/src/aws/adminweb.ts', 512, Duration.seconds(30));
    adminWeb.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:ListUsers'], resources: [props.pool.userPoolArn] }));
    adminWeb.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: ['*'] }));                    // (this one cannot be limited to a group)
    adminWeb.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['logs:FilterLogEvents'], resources: [Arn.format({ service: 'logs', resource: 'log-group', resourceName: `PuzzleVidio-${props.stage}-*:*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME }, this)] }),
    );
    new CfnOutput(this, 'AdminFunction', { value: admin.functionName, description: 'Invoke it to read reports, end a puzzle, ban a player or delete an account (docs/runbook.md)' });

    const cleanup = new nodejs.NodejsFunction(this, 'Cleanup', {
      ...common,
      entry: repo('server/src/aws/cleanup.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(30),
      logGroup: logGroup(this, 'CleanupLogs'),
      environment: { ...common.environment, MEDIA_BUCKET: props.media.bucketName },
    });
    props.media.grantDelete(cleanup);
    // only the removal of a room's own item matters; the function looks at which item it was (a membership or a code is removed too)
    cleanup.addEventSource(
      new sources.DynamoEventSource(props.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        retryAttempts: 5,
        bisectBatchOnError: true,
        maxRecordAge: Duration.hours(6),
        filters: [lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('REMOVE') })],
      }),
    );

    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${props.pool.userPoolId}`;
    const jwt = new authorizers.HttpJwtAuthorizer('Cognito', issuer, { jwtAudience: [props.client.userPoolClientId] });
    // Only the address of our own domain works (see below): the default execute-api address would be a way around anything put in front of it later (a firewall).
    this.api = new apigw.HttpApi(this, 'Http', {
      disableExecuteApiEndpoint: true,
      corsPreflight: {
        allowOrigins: props.origins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: Duration.hours(1),
      },
    });
    const throttle = API_THROTTLE[props.stage];
    (this.api.defaultStage!.node.defaultChild as apigw.CfnStage).defaultRouteSettings = { throttlingRateLimit: throttle.rate, throttlingBurstLimit: throttle.burst };

    const integration = new integrations.HttpLambdaIntegration('Service', fn);
    const { GET, POST, PUT } = apigw.HttpMethod;
    // Making a puzzle needs an account: the gateway turns away anything but a Cognito ID token there (and a guest's token is not one). Joining and playing are open to guests as well, so the
    // other routes are not checked by the gateway: the function checks the token it is shown, a Cognito one or a guest's (server/src/aws/api.ts). `/guest` gives a guest their token, to
    // whoever asks. The upload of a picture has no sign-in: its address is signed.
    this.api.addRoutes({ path: '/rooms', methods: [POST], integration, authorizer: jwt });
    for (const [path, methods] of [['/guest', [POST]], ['/me', [GET, PUT]], ['/me/delete', [POST]], ['/join', [POST]], ['/rooms', [GET]], ['/rooms/{proxy+}', [GET, POST]]] as const) {
      this.api.addRoutes({ path, methods: [...methods], integration });
    }
    this.api.addRoutes({ path: '/media/{id}', methods: [PUT], integration });
    // the admin page: nothing without a Cognito ID token (the function looks for the admin group besides)
    this.api.addRoutes({ path: '/admin/{proxy+}', methods: [GET, POST], integration: new integrations.HttpLambdaIntegration('AdminWebService', adminWeb), authorizer: jwt });

    // the API's own name, with a certificate
    const certificate = new acm.Certificate(this, 'Certificate', { domainName: props.domain, validation: acm.CertificateValidation.fromDns(zone) });
    const domain = new apigw.DomainName(this, 'Domain', { domainName: props.domain, certificate });
    new apigw.ApiMapping(this, 'Mapping', { api: this.api, domainName: domain, stage: this.api.defaultStage });
    new route53.ARecord(this, 'A', {
      zone,
      recordName: props.domain,
      target: route53.RecordTarget.fromAlias(new targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId)),
    });

    // Someone is told when the functions fail or are throttled, or when the gateway answers with an error of ours.
    const alarm = (name: string, metric: cloudwatch.IMetric, threshold: number, description: string) => {
      const a = new cloudwatch.Alarm(this, name, { metric, threshold, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: description });
      a.addAlarmAction(new actions.SnsAction(alarms));
    };
    const five = Duration.minutes(5);
    alarm('ApiErrors', fn.metricErrors({ period: five, statistic: 'Sum' }), 1, 'The API function threw an error');
    alarm('ApiThrottles', fn.metricThrottles({ period: five, statistic: 'Sum' }), 1, 'The API function was throttled (its concurrency ran out)');
    alarm('CleanupErrors', cleanup.metricErrors({ period: five, statistic: 'Sum' }), 1, 'Deleting the pictures of ended rooms failed');
    alarm('ApiBusy', this.api.metricCount({ period: five, statistic: 'Sum' }), BUSY_ALARMS[props.stage].api, 'The API is being asked for much more than usual (a script? a launch?)');
    alarm('Gateway5xx', this.api.metricServerError({ period: five, statistic: 'Sum' }), 5, 'The API answered with server errors');

    new CfnOutput(this, 'Address', { value: `https://${props.domain}` });
    new CfnOutput(this, 'ApiFunction', { value: fn.functionName });
  }
}
