# Infrastructure

The AWS side of PuzzleVidio (puzzlevid.io), written with the CDK in TypeScript. The plan is in `../docs/online-play-plan.md` (Phase 2); this folder holds what has been built of it.

Everything is in **us-east-1**: CloudFront only takes its certificates from there, and Cognito, DynamoDB, S3, Lambda and IoT Core are all available there. Nothing in the code names an account or a
hosted zone: the account is whatever the credentials running `cdk` belong to, and the zone id is given on the command line.

## What is here

| Stack | What it makes |
|---|---|
| `PuzzleVidio-shared-Ops` | a budget that writes to an e-mail address at 50 / 80 / 100 % of the month (and when 100 % is forecast), a topic for alarms, and the role GitHub Actions deploys with |
| `PuzzleVidio-<stage>-Data` | the DynamoDB table (rooms, codes, members, creations; on-demand, with expiry) and the private bucket for pictures |
| `PuzzleVidio-<stage>-Auth` | the Cognito user pool: e-mail and password, and Google when configured, by the OAuth code flow without a client secret |
| `PuzzleVidio-<stage>-Api` | the HTTP API at `api.<the game's address>` (certificate, record, throttle, CORS), the Lambda function that runs the room service, the key that signs picture-upload addresses (Secrets Manager), the function that deletes a room's picture when its item leaves the table, a month of logs and alarms to the alarm topic |
| `PuzzleVidio-<stage>-Web` | the game's files: private bucket, CloudFront, certificate and the records in the hosted zone |

`<stage>` is `dev` (served at `dev.puzzlevid.io`, may be thrown away, its sign-in also allows `http://localhost:5173`) or `prod` (`puzzlevid.io`, its data is kept when a stack is deleted).

The code of the functions is in `../server/src/aws/` and is bundled from there (with esbuild, the AWS SDK included) when the templates are built, so the root `npm install` has to have been run before `cdk synth`.
A player sends the picture **through the API** (an address that the service signed), and the service looks at the bytes before it puts them in the bucket; Lambda takes about 6 MB in a request, so a picture is
limited to 4 MB (the game sends at most 1600 px on a side). Members read the picture straight from S3 through a signed address.

Not here yet: the live messages' side in AWS (IoT Core, chosen in `../docs/online-realtime.md`: its authorizer and policy, and the function that records who is connected), the web firewall, and reserved
concurrency for the functions (a new account's limit may be too low to reserve any).

## Trying it without an account

```
cd infra
npm install
npm test                                        # the templates are built and checked
npx cdk synth --quiet -c hostedZoneId=ZEXAMPLE  # all the templates, into cdk.out/ (nothing is sent anywhere)
```

## Putting it up (once)

This needs credentials that may create IAM roles, certificates, and so on: your own, not those of a game's Lambda.

1. **Bootstrap** the account for the CDK: `npx cdk bootstrap aws://<account>/us-east-1`.
2. Find the **hosted zone** of the domain: `aws route53 list-hosted-zones-by-name --dns-name puzzlevid.io` (the part after `/hostedzone/`). The domain's name servers must be the zone's: registering the domain
   in Route 53 does this by itself.
3. An account can have only one OIDC provider for GitHub. See whether yours has one: `aws iam list-open-id-connect-providers`. If it does, add `-c githubProviderArn=<its arn>` below.
4. Deploy the shared stack, which makes the budget and the deploy role:
   `npx cdk deploy PuzzleVidio-shared-Ops -c hostedZoneId=<id> -c alertEmail=<you@example.com>` (AWS sends a mail to confirm the subscription: click it).
5. In the GitHub repository, add the variables `AWS_DEPLOY_ROLE_ARN` (from the stack's output) and `HOSTED_ZONE_ID`, and optionally `ALERT_EMAIL`.
6. Run **Actions > Deploy** for `dev`, look at https://dev.puzzlevid.io, and again for `prod`. The workflow deploys the stacks and then puts the game in the bucket.

Settings that can be given with `-c name=value` (or as `PUZZLEVIDIO_NAME` in the environment): `hostedZoneId` (required), `zoneName` (default `puzzlevid.io`), `alertEmail`, `budgetUsd` (default 25),
`githubRepo` (default this one), `githubProviderArn`, `googleClientId` and `googleSecretName`.

## Google sign-in

1. In the Google Cloud console make an OAuth client of the type "web application". Its authorised redirect URI is
   `https://puzzlevidio-<stage>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` (one for `dev`, one for `prod`).
2. Keep the client secret in Secrets Manager, not in a file: `aws secretsmanager create-secret --name puzzlevidio/google --secret-string <secret>`.
3. Deploy with `-c googleClientId=<id> -c googleSecretName=puzzlevidio/google` (in GitHub: the variables `GOOGLE_CLIENT_ID` and `GOOGLE_SECRET_NAME`).

## What it costs with nobody playing

DynamoDB, S3, Cognito (the first 10,000 monthly users are free), Lambda and CloudFront charge by use; what remains is the hosted zone (about $0.50 a month for the domain's zone) and a few cents of storage.
Cognito's built-in e-mail is limited to 50 a day: **Amazon SES** (a verified sender in the domain) is needed before a public launch.
