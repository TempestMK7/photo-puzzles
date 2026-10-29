import { fileURLToPath } from 'node:url';
import { Arn, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
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
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { ALARM_TOPIC_NAME, API_THROTTLE, type Stage } from './config';

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
  pool: cognito.IUserPool;
  client: cognito.IUserPoolClient;
}

const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/**
 * The API: an HTTP API on its own address in front of one Lambda function that runs the room service (server/src/aws/api.ts). API Gateway checks the Cognito ID token on every
 * route but the upload of a picture (whose address the service signed). A second function deletes a room's picture when the room's item is removed from the table.
 */
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const prod = props.stage === 'prod';
    const removal = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.zoneName });
    const alarms = sns.Topic.fromTopicArn(this, 'Alarms', Arn.format({ service: 'sns', resource: ALARM_TOPIC_NAME }, this));

    // the key that signs the addresses for uploading pictures; made here, read by the function when it starts, and never in a template or a log
    const signing = new secretsmanager.Secret(this, 'UploadKey', { generateSecretString: { passwordLength: 48, excludePunctuation: true }, removalPolicy: removal });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      projectRoot: repo(''),
      depsLockFilePath: repo('package-lock.json'),
      // the AWS SDK is bundled with the code, so that what runs is what was tested and not whatever version the runtime has
      bundling: { minify: true, sourceMap: true, target: 'node22', externalModules: [] as string[] },
      environment: { NODE_OPTIONS: '--enable-source-maps' },
    };
    const logGroup = (name: string) => new logs.LogGroup(this, name, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });

    const fn = new nodejs.NodejsFunction(this, 'Api', {
      ...common,
      entry: repo('server/src/aws/api.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(20),
      logGroup: logGroup('ApiLogs'),
      environment: {
        ...common.environment,
        TABLE_NAME: props.table.tableName,
        MEDIA_BUCKET: props.media.bucketName,
        SIGNING_SECRET_ARN: signing.secretArn,
        API_BASE: `https://${props.domain}`,
        WEB_BASE: `https://${props.webDomain}`,
      },
    });
    props.table.grantReadWriteData(fn);
    props.media.grantReadWrite(fn);
    signing.grantRead(fn);
    // what the service publishes goes to the topics of the rooms, and the address of the broker is asked for when the function starts
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['iot:Publish'], resources: [this.formatArn({ service: 'iot', resource: 'topic', resourceName: 'puzzle/*' })] }));
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['iot:DescribeEndpoint'], resources: ['*'] }));

    const cleanup = new nodejs.NodejsFunction(this, 'Cleanup', {
      ...common,
      entry: repo('server/src/aws/cleanup.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(30),
      logGroup: logGroup('CleanupLogs'),
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
    for (const [path, methods] of [['/join', [POST]], ['/rooms', [GET, POST]], ['/rooms/{proxy+}', [GET, POST]]] as const) {
      this.api.addRoutes({ path, methods: [...methods], integration, authorizer: jwt });
    }
    this.api.addRoutes({ path: '/media/{id}', methods: [PUT], integration });

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
    alarm('Gateway5xx', this.api.metricServerError({ period: five, statistic: 'Sum' }), 5, 'The API answered with server errors');

    new CfnOutput(this, 'Address', { value: `https://${props.domain}` });
    new CfnOutput(this, 'ApiFunction', { value: fn.functionName });
  }
}
