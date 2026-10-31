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
   If the run stops at *Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity*, the repository may have **immutable subjects**: its tokens say
   `repo:owner@ownerId/name@repoId:ref:...` instead of `repo:owner/name:ref:...`. `gh api repos/<owner>/<name>/actions/oidc/customization/sub` shows the prefix (`sub_claim_prefix`, which is
   `repo:` and then what to give); deploy the Ops stack again with `-c githubSubjectPrefix=owner@ownerId/name@repoId`, and the role trusts both forms (still only `main`).
6. **Dev deploys itself** whenever a change is merged into `main` (tests first; a change that only touches documents is skipped). **Production is run by hand**: Actions > Deploy > Run workflow, stage `prod`, with the word `prod` typed in the box. The workflow deploys the stacks and then puts the game in the bucket; the main screen shows which build it is (`src/version.ts`).

Settings that can be given with `-c name=value` (or as `PUZZLEVIDIO_NAME` in the environment): `hostedZoneId` (required), `zoneName` (default `puzzlevid.io`), `alertEmail`, `budgetUsd` (default 25),
`githubRepo` (default this one), `githubSubjectPrefix` (see below), `githubProviderArn`, `googleClientId` and `googleSecretName`, `pexelsSecretName` (the stock library, below), and `limits` (a JSON object that changes the service's limits, like `{"hostingPaused":1}` to switch the making of puzzles off: `docs/runbook.md`). **The runbook (`docs/runbook.md`) says how to run it: alarms, logs, limits, reports, bans, deploys.**

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

## The admin page

`https://<the game's address>/admin` lists the accounts, the puzzles, the reports and the logs for the people in the Cognito group `admins` (the Auth stack makes the group; nobody is in it). Its routes are `/admin/*` of the API (a function of its own, `AdminWeb`, behind the gateway's JWT check; it reads the user pool's accounts and the log groups named `PuzzleVidio-<stage>-*`). Put an account in the group with `aws cognito-idp admin-add-user-to-group` (`docs/runbook.md`, *The admin page*). CloudFront sends `/admin/` to `/admin`, because the page finds its files by relative addresses.

## Google sign-in

The sign-in and sign-up pop-ups of the game show a **Sign in with Google** button when the build says the user pool has Google (the deploy sets `VITE_GOOGLE_SIGNIN` when both repository variables below are set). The button takes the page to Google through Cognito's authorize address (`identity_provider=Google`, the same code flow with PKCE as before) and the player comes back to the game signed in. The Android app does not show it (Google refuses its sign-in page inside an app's web view; see the plan).

1. In the Google Cloud console make a project, and set up the consent screen (the "Google Auth Platform" pages): app name PuzzleVidio, a support address, **External**, scopes `openid`, `email`, `profile` (none of them needs Google's review). While the app is in *Testing* only the accounts listed as test users can sign in; *Publish app* opens it to everybody (the privacy and terms pages should be up first: Google asks for their addresses).
2. Make an OAuth client of the type "web application". Authorised JavaScript origins: none. Authorised redirect URIs, both of these (one client serves both stages):
   `https://puzzlevidio-dev.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` and `https://puzzlevidio-prod.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`.
3. Keep the client secret in Secrets Manager, not in a file of the repository: `aws secretsmanager create-secret --name puzzlevidio/google --secret-string <secret>` (with the secret put in from a file or a variable, so that it does not stay in the shell's history).
4. Set the repository variables `GOOGLE_CLIENT_ID` (the client id; it is not secret) and `GOOGLE_SECRET_NAME` (`puzzlevidio/google`), or deploy by hand with `-c googleClientId=<id> -c googleSecretName=puzzlevidio/google`. The next deploy of the Auth stack adds the provider to the user pool and lists it on the app client; the build after it shows the button.

An account made with Google is a **separate account** from one made with an e-mail address and password for the same address: Cognito does not join them by itself (see the plan: linking them is the next step).

## The stock library (Pixabay and Pexels)

The **Stock Files** tab of the game's photo panel searches Pixabay and Pexels for pictures and videos. The API only does the searching (so the keys stay secret, and answers are kept: ten minutes for Pexels, a day for Pixabay, which asks for that); a picture or video is downloaded by the browser straight from the site's own servers when someone presses Play, with no referrer (Pixabay's image server turns away a picture asked for by another site's page). The tab is there when the build has an API (`VITE_ONLINE_URL`); a deployment with no key at all answers `stock-off` and the tab says the library is not available; with keys for both sites the tab offers a choice between them. Each site is optional.

**Pixabay** (photos and videos; the safe search is always on):
1. Make a free account at pixabay.com and copy the API key from the API documentation page (pixabay.com/api/docs) while logged in. Its terms ask that results say where they are from (the game does that), that answers are kept for 24 hours (the server does that), and that its pictures are downloaded rather than hotlinked for good (the game keeps what is played in the player's own library). A key may make 100 requests a minute; the server stops at 1500 an hour (`stockUpstream` in `server/src/ratelimit.ts`).
2. Keep the key in Secrets Manager: `aws secretsmanager create-secret --name puzzlevidio/pixabay --secret-string <key>` (put in from a file or a variable, so that it does not stay in the shell's history).
3. Nothing else to set: the API looks for the key in the secret `puzzlevidio/pixabay` (the repository variable `PIXABAY_SECRET_NAME`, or `-c pixabaySecretName=...`, names another secret, and `none` leaves the site out). Only the API function may read the secret, and it reads it when it starts, so a key put there later is found by the functions that start after that (a deploy starts new ones). On a developer's machine, `PIXABAY_API_KEY=<key> npm run server` turns it on for the local server.

**A site with no key is skipped:** when the secret is not there, or is empty, the API does not offer that site (and logs nothing about a secret that does not exist); the tab offers a choice of site only when more than one has a key, and says the library is not available when none has.

**Pexels** works the same way (secret `puzzlevidio/pexels`, variable `PEXELS_SECRET_NAME`, `-c pexelsSecretName=...`, `PEXELS_API_KEY` for the local server). Pexels was not giving out new API keys when this was written (a banner on pexels.com/api said issuance was paused), so there is no such secret yet and the game runs on Pixabay alone: when a key can be had, make the secret and the Pexels search appears. Its terms ask for a visible link to Pexels wherever its pictures are shown (the game does that) and give a key 200 requests an hour and 20,000 a month (the server stops at 150 an hour; ask Pexels to raise the limit when the game has players).

## What it costs with nobody playing

DynamoDB, S3, Cognito (the first 10,000 monthly users are free), Lambda and CloudFront charge by use; what remains is the hosted zone (about $0.50 a month for the domain's zone) and a few cents of storage.
Each picture that is uploaded is looked at by Amazon Rekognition (moderation labels), about $0.001 a picture; a puzzle with a thousand pieces costs the same as one with six. Sign-up and password-reset e-mails come from `no-reply@<domain>` through **Amazon SES**: the Ops stack verifies the domain (DKIM records, a `mail.<domain>` envelope sender and a DMARC record, all written into the domain's zone, so nothing is done by hand) and the Auth stacks name it as the sender. A new SES account is in the **sandbox**: 200 messages a day, and only to addresses that were verified one by one (`aws sesv2 create-email-identity --email-identity you@example.com`, then click the link). Before anyone else can sign up, ask AWS to take the account out of it: `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://<domain> --use-case-description "..." --contact-language EN` (or SES console > Account dashboard > Request production access); AWS answers within a day or so. `aws sesv2 get-account` shows `ProductionAccessEnabled`. Deploy order: Ops first (and wait until `aws sesv2 get-email-identity --email-identity <domain>` says `VerifiedForSendingStatus: true`), then the Auth stacks.
