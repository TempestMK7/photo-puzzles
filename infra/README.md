# Infrastructure

The AWS side of PuzzleVidio (puzzlevid.io), written with the CDK in TypeScript. The plan is in `../docs/online-play-plan.md` (Phase 2); this folder holds what has been built of it.

Everything is in **us-east-1**: CloudFront only takes its certificates from there, and Cognito, DynamoDB, S3, Lambda and IoT Core are all available there. Nothing in the code names an account or a
hosted zone: the account is whatever the credentials running `cdk` belong to, and the zone id is given on the command line.

## What is here

| Stack | What it makes |
|---|---|
| `PuzzleVidio-shared-Ops` | a budget that writes to an e-mail address at 50 / 80 / 100 % of the month (and when 100 % is forecast), a topic for alarms, and the role GitHub Actions deploys with |
| `PuzzleVidio-<stage>-Data` | the DynamoDB table (rooms, codes, members, creations, display names; on-demand, with expiry), the private bucket for pictures, and the key (Secrets Manager) that signs picture-upload addresses and guests' tokens |
| `PuzzleVidio-<stage>-Auth` | the Cognito user pool: e-mail and password, and Google when configured, by the OAuth code flow without a client secret |
| `PuzzleVidio-<stage>-Api` | the HTTP API at `api.<the game's address>` (certificate, record, throttle, CORS), the Lambda function that runs the room service (the gateway wants a Cognito token only to make a puzzle; guests may do the rest, and the function checks their tokens itself; it may also delete a user from the pool, when that player asks to delete their account), the function that deletes a room's picture when its item leaves the table, a month of logs and alarms to the alarm topic; the operator's function `Admin` (below), which has no address |
| `PuzzleVidio-<stage>-Live` | the live side of a room on IoT Core: the broker's custom authorizer (checks the Cognito token and that the player is in the room; one policy per connection), the function that keeps who is online from the broker's connect / disconnect events, a month of logs and alarms |
| `PuzzleVidio-<stage>-Web` | the game's files: private bucket, CloudFront, certificate and the records in the hosted zone |

`<stage>` is `dev` (served at `dev.puzzlevid.io`, may be thrown away, its sign-in also allows `http://localhost:5173`) or `prod` (`puzzlevid.io`, its data is kept when a stack is deleted).

The code of the functions is in `../server/src/aws/` and is bundled from there (with esbuild, the AWS SDK included) when the templates are built, so the root `npm install` has to have been run before `cdk synth`.
A player sends the picture **through the API** (an address that the service signed), and the service looks at the bytes before it puts them in the bucket; Lambda takes about 6 MB in a request, so a picture is
limited to 4 MB (the game sends at most 1600 px on a side). Members read the picture straight from S3 through a signed address.

Not here yet: reserved concurrency for the functions (a new account's limit may be too low to reserve any). There is no web firewall: AWS WAF cannot be attached to an HTTP API, so the limits per address are in the
API function (`../server/src/ratelimit.ts`, counted in the table), and two alarms (`BUSY_ALARMS` in `lib/config.ts`) say when the API or the broker's authorizer is called far more than usual.

## Trying it without an account

```
cd infra
npm install
npm test                                        # the templates are built and checked
npx cdk synth --quiet -c hostedZoneId=ZEXAMPLE  # all the templates, into cdk.out/ (nothing is sent anywhere)
```

## Putting it up (once)

This needs credentials that may create IAM roles, certificates, and so on: your own, not those of a game's Lambda. Use an AWS account of its own for the game (an account can be added to an AWS Organization for nothing):
the budget, the quotas (Lambda runs 10 at a time in a new account, which is to be raised before launch) and what a mistake can touch then belong to this game alone.

1. **Bootstrap** the account for the CDK: `npx cdk bootstrap aws://<account>/us-east-1 -c hostedZoneId=<id>` (the CDK runs the app first, so it asks for the zone of step 2 here too).
2. Find the **hosted zone** of the domain: `aws route53 list-hosted-zones-by-name --dns-name puzzlevid.io` (the part after `/hostedzone/`). The domain's name servers must be the zone's: registering the domain
   in Route 53 does this by itself. If the domain was registered in another account, or the zone was made later, change them at the registration (Route 53 > Registered domains > Name servers): editing the NS
   records inside the zone changes nothing. It takes up to a day or two to reach every resolver (`nslookup -type=NS puzzlevid.io 8.8.8.8` shows what they say), and the Web stack waits for it, because its certificate is checked through DNS.
3. An account can have only one OIDC provider for GitHub. See whether yours has one: `aws iam list-open-id-connect-providers`. If it does, add `-c githubProviderArn=<its arn>` below.
4. Deploy the shared stack, which makes the budget and the deploy role:
   `npx cdk deploy PuzzleVidio-shared-Ops -c hostedZoneId=<id> -c alertEmail=<you@example.com>` (AWS sends a mail to confirm the subscription: click it).
5. In the GitHub repository, add the variables `AWS_DEPLOY_ROLE_ARN` (the stack's output `DeployRoleArn`) and `HOSTED_ZONE_ID`, and optionally `ALERT_EMAIL`. They are **repository** variables
   (Settings > Secrets and variables > Actions > Variables): the workflow does not name an environment, so it cannot see the variables of one, and a job that does name one is not the identity that the
   deploy role trusts (the main branch).
6. Run **Actions > Deploy** for `dev`, look at https://dev.puzzlevid.io, and again for `prod`. The workflow deploys the stacks and then puts the game in the bucket.

Settings that can be given with `-c name=value` (or as `PUZZLEVIDIO_NAME` in the environment): `hostedZoneId` (required), `zoneName` (default `puzzlevid.io`), `alertEmail`, `budgetUsd` (default 25),
`githubRepo` (default this one), `githubProviderArn`, `googleClientId` and `googleSecretName`.

## Reports, ending a puzzle, banning a player

A player can report a puzzle from inside it (a reason and a note). The report is kept for 90 days with who was in the puzzle, and the alarm topic e-mails the operator ("a puzzle was reported", with the ids). The puzzle is not touched: the operator looks at it and decides, with the **Admin** function of the Api stack (its name is the stack output `AdminFunction`). It has no web address: only an IAM user of this account that may invoke it can call it, for example (in a shell that has the AWS credentials for the game's account, and the `--cli-binary-format` flag so that the payload is read as JSON):

```
aws lambda invoke --function-name <AdminFunction> --cli-binary-format raw-in-base64-out --payload '{"cmd":"reports"}' out.json && cat out.json
```

| `cmd` | what it does |
|---|---|
| `reports` (`days`, up to 90, default 30) | the reports, newest first |
| `room` (`id`) | who made a puzzle, who is in it, when it ends, and a short-lived address of its picture (look at it, then decide) |
| `remove-room` (`id`) | ends the puzzle now: its picture and codes are deleted and the players are told it was closed |
| `ban` (`id`, `reason`) | the player (an account's id is the `sub` of its token, which a report names) leaves every puzzle, the ones they made end, and nothing but their own account can be reached until `unban` |
| `unban` (`id`), `bans` | lifts a ban; lists them |

A ban is a record of an id only: it stays when the account is deleted (a new account is a new id, so a ban stops a *player* only as far as they do not sign up again; stopping a person is a matter of the terms and of what can be done about a sign-in service account, which is not done here). The picture of a puzzle that has been reported is not kept past the puzzle's end: look quickly (a puzzle goes a day after the last move).

## Google sign-in

1. In the Google Cloud console make an OAuth client of the type "web application". Its authorised redirect URI is
   `https://puzzlevidio-<stage>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` (one for `dev`, one for `prod`).
2. Keep the client secret in Secrets Manager, not in a file: `aws secretsmanager create-secret --name puzzlevidio/google --secret-string <secret>`.
3. Deploy with `-c googleClientId=<id> -c googleSecretName=puzzlevidio/google` (in GitHub: the variables `GOOGLE_CLIENT_ID` and `GOOGLE_SECRET_NAME`).

## What it costs with nobody playing

DynamoDB, S3, Cognito (the first 10,000 monthly users are free), Lambda and CloudFront charge by use; what remains is the hosted zone (about $0.50 a month for the domain's zone) and a few cents of storage.
Each picture that is uploaded is looked at by Amazon Rekognition (moderation labels), about $0.001 a picture; a puzzle with a thousand pieces costs the same as one with six. Cognito's built-in e-mail is limited to 50 a day: **Amazon SES** (a verified sender in the domain) is needed before a public launch.
