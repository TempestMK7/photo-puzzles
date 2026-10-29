import { fileURLToPath } from 'node:url';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/** A path in the repository (the functions are built from `server/`, outside `infra/`). */
export const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** What all of our functions have in common. */
export const functionDefaults = {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  projectRoot: repo(''),
  depsLockFilePath: repo('package-lock.json'),
  // the AWS SDK is bundled with the code, so that what runs is what was tested and not whatever version the runtime has
  bundling: { minify: true, sourceMap: true, target: 'node22', externalModules: [] as string[] },
  environment: { NODE_OPTIONS: '--enable-source-maps' },
};

/** Logs are kept for a month and go with the stack. */
export const logGroup = (scope: Construct, name: string) => new logs.LogGroup(scope, name, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
