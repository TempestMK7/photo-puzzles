import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { Stage } from './config';

export interface DataStackProps extends StackProps {
  stage: Stage;
  /** The origins that may fetch and upload pictures from a browser. */
  origins: string[];
}

/**
 * What must outlive a deployment: the table (rooms, codes, members, creations) and the bucket of pictures. Nothing costs anything while nobody plays: the table bills per request
 * and the bucket per byte.
 */
export class DataStack extends Stack {
  readonly table: dynamodb.Table;
  readonly media: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const prod = props.stage === 'prod';
    const removal = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // One table for everything (see docs/online-play-plan.md, "Data"):
    //   ROOM#<id>     / META            the room, with its board
    //   CODE#<digits> / CODE            a code and the room it opens
    //   PLAYER#<id>   / ROOM#<id>       a player's membership (the list "my online puzzles")
    //   PLAYER#<id>   / CREATION#<t>    a puzzle that was made, for the quota
    // `ttl` (seconds) is when DynamoDB may delete an item. The service also checks expiry itself, because deletion can come up to two days late.
    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.OLD_IMAGE,          // the picture of a room that expired is deleted from what the stream says
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: prod },
      deletionProtection: prod,
      removalPolicy: removal,
    });

    this.media = new s3.Bucket(this, 'Media', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
          allowedOrigins: props.origins,
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      // A backstop: a room ends within a day (or at most about a month) and its picture is deleted then; this removes anything that was missed.
      lifecycleRules: [{ expiration: Duration.days(35), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: removal,
      autoDeleteObjects: !prod,
    });

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'MediaBucket', { value: this.media.bucketName });
  }
}
