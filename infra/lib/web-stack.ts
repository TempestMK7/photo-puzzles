import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { DEPLOY_ROLE_NAME, type Stage } from './config';

export interface WebStackProps extends StackProps {
  stage: Stage;
  zoneName: string;
  hostedZoneId: string;
  /** The address the game is served at. */
  domain: string;
}

/** The game's files: a private bucket behind CloudFront, with a certificate and a name in the hosted zone. Idle, this costs a few cents a month. */
export class WebStack extends Stack {
  readonly site: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const prod = props.stage === 'prod';
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.zoneName });

    this.site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !prod,
    });

    const certificate = new acm.Certificate(this, 'Certificate', { domainName: props.domain, validation: acm.CertificateValidation.fromDns(zone) });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });

    // The admin page is at /admin, and the page's files are found by addresses relative to where it is: /admin/ (with the slash) would look for them under /admin/, so it goes to /admin. The
    // privacy policy and the terms are the files privacy.html and terms.html, shown at /privacy and /terms (and the same with a slash goes to the one without).
    const adminSlash = new cloudfront.Function(this, 'AdminSlash', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline("function handler(event) { var r = event.request; var u = r.uri; var m = /^\\/(admin|privacy|terms)\\/$/.exec(u); if (m) return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: '/' + m[1] } } }; if (u === '/privacy' || u === '/terms') r.uri = u + '.html'; return r; }"),
    });

    // The game is one page with hash addresses (#/join/...), so a missing file is not an address: it gets the page.
    const page = { responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(1) };
    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [{ function: adminSlash, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      defaultRootObject: 'index.html',
      domainNames: [props.domain],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      errorResponses: [
        { httpStatus: 403, ...page },
        { httpStatus: 404, ...page },
      ],
    });

    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
    const recordName = props.domain === props.zoneName ? undefined : props.domain;
    new route53.ARecord(this, 'A', { zone, recordName, target });
    new route53.AaaaRecord(this, 'Aaaa', { zone, recordName, target });

    // What GitHub's deploy role (see ops-stack.ts) needs to put a new build of the game in place: write the files and clear the cache.
    const deployer = iam.Role.fromRoleName(this, 'Deployer', DEPLOY_ROLE_NAME);
    deployer.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:DeleteObject'], resources: [this.site.arnForObjects('*')] }));
    deployer.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [this.site.bucketArn] }));
    deployer.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation'], resources: [this.distributionArn()] }));

    new CfnOutput(this, 'SiteBucket', { value: this.site.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'Address', { value: `https://${props.domain}` });
  }

  private distributionArn(): string {
    return `arn:aws:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`;
  }
}
