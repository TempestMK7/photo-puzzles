# Runbook: running PuzzleVidio's online side

For the person who runs it. Each section says what to do, with the commands. `infra/README.md` says how it is built and deployed, `docs/online-play-plan.md` why. Nothing here needs
anything but the AWS command line and the GitHub command line (`gh`).

Commands marked *(run)* were run against dev while this was written; those marked *(not run)* were not (they would have cut dev off for whoever was using it) and should be tried once
on dev before they are needed in earnest.

## Before anything: which account, which stage

- The game has **its own AWS account**. Use the profile made for it (`--profile puzzlevidio`, region `us-east-1`), never the default profile (another game's account).
  On a machine with a virus scanner that looks into HTTPS, the AWS command line may need `AWS_CA_BUNDLE=<a file with the scanner's certificate>`.
- There are two stages, `dev` (`dev.puzzlevid.io`, `api.dev.puzzlevid.io`) and `prod` (`puzzlevid.io`, `api.puzzlevid.io`), each of five stacks `PuzzleVidio-<stage>-Data | Auth | Web | Api | Live`, and one shared `PuzzleVidio-shared-Ops` (budget, alarm topic, deploy role, the e-mail domain). **`prod` is not deployed yet.**
- The names of the things you invoke are in the stacks' outputs (the log groups have a random part in their names, so look them up):

```
aws cloudformation describe-stacks --stack-name PuzzleVidio-<stage>-Api --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output text
aws cloudformation describe-stacks --stack-name PuzzleVidio-<stage>-Live --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output text
aws logs describe-log-groups --log-group-name-prefix PuzzleVidio-<stage> --query "logGroups[].logGroupName" --output text
```

*(run)* The outputs that matter: `ApiFunction`, `AdminFunction` (Api stack); `PresenceFunction`, `AuthorizerFunction` (Live stack).

## The admin page

`https://<the game's address>/admin` (`https://dev.puzzlevid.io/admin`, later `https://puzzlevid.io/admin`) is a page for the operator: sign in with an account that is in the **admin group** and look at

- **Players**: every account of the user pool (name chosen, e-mail, when it was made, its state, its id), with **Ban** and **Unban**, and the account's **type** (free, paid, family or admin) and **photo and video credits**, which can be changed and saved (there is no payment yet: this is how an account is made a paid one, the family's or an admin);
- **Puzzles**: every puzzle that exists (who made it, who is in it and who is connected right now, the pieces, how long it has been played, when it ends), with **Look** (the picture, in the page) and **End this puzzle**;
- **Files**: every picture and video the server keeps for making another puzzle (below), newest first, as a **wall of thumbnails** to run an eye over (a page of 60 at a time, the next page loads as you scroll; a video shows its first picture and its length). Click one to see it in full, who sent it, when, and when it goes, with **Delete this file** (the file goes at once, and so does every puzzle made from it) or **Delete it and ban the player** (which also deletes everything else they sent). Both ask a second time;
- **Reports**: the last 30 days, with **Look** at the puzzle a report names (a puzzle that has ended cannot be looked at: the report keeps the ids);
- **Logs**: the logs of the functions of that stage, a function at a time, for the last 15 minutes to a day, with a filter (`ERROR`, or any text); the newest 200 lines.

Ending a puzzle and banning a player ask a second time. **Deleting an account is not in the page** (it is `delete-account` of the operator's function, below).

**Who may use it:** an account is an administrator when it is in the Cognito group `admins`. Nobody is at first; put an account in by hand (the account has to exist: sign up in the game first), and take it out the same way:

```
aws cognito-idp admin-add-user-to-group --user-pool-id <the stage's pool> --username <the e-mail address of the account> --group-name admins
aws cognito-idp admin-remove-user-from-group --user-pool-id <the stage's pool> --username <the e-mail address of the account> --group-name admins
aws cognito-idp list-users-in-group --user-pool-id <the stage's pool> --group-name admins
```

The pool's id is the Auth stack's output `UserPoolId`. The group is on the account's token, so a change reaches the page at the next sign-in (the token lasts an hour). Two things check it: the gateway lets only a signed-in account through to `/admin/*`, and the function looks for the group again; an account that is not in it gets "Not an administrator".

**Privacy:** the page shows e-mail addresses and the logs (which hold ids and never e-mail addresses or pictures). Keep the group small; the privacy policy draft names the operator as someone who can see them.

The page needs the stage's own pool: an administrator of dev is not one of prod.

## Is it up?

1. The game: `https://<domain>/` answers 200. The API: `https://api.<domain>/me` answers `401` without a token (the gateway is up and wants a sign-in). *(run)*
2. The alarms: `aws cloudwatch describe-alarms --alarm-name-prefix PuzzleVidio-<stage> --query "MetricAlarms[].[AlarmName,StateValue]" --output text`: everything `OK`. *(run)*
3. The alarms also e-mail the address given as `alertEmail` when they go off (the topic is `puzzlevidio-alarms`), and so does the monthly budget.

## When an alarm goes off

| Alarm (name starts `PuzzleVidio-<stage>-`) | It means | First thing to do |
|---|---|---|
| `Api-ApiErrors…` | the API function threw errors | read its log (below); a bad deploy is the usual cause: see *Going back* |
| `Api-ApiThrottles…` | the function ran out of concurrent runs (the account allows only a few until the quota request is granted) | check *Quotas*; if it is an attack, see *Stopping things* |
| `Api-ApiBusy…` | the API was asked for more than `BUSY_ALARMS.api` times in five minutes (`infra/lib/config.ts`) | look at the log for one address or one player asking over and over; a real crowd is good news |
| `Api-Gateway5xx…` | the gateway answered with an error of its own | the function's log, and the gateway's |
| `Api-CleanupErrors…` | pictures of ended puzzles are not being deleted | read the Cleanup function's log; the S3 rule deletes anything missed after 35 days, so nothing stays for ever |
| `Live-AuthorizerErrors…` | the broker's sign-in check fails: **nobody gets live updates** | the Authorizer function's log; the Cognito pool and the signing secret are what it reads |
| `Live-AuthorizerBusy…` | the broker asked the authorizer more than `BUSY_ALARMS.authorizer` times in five minutes | one player's game reconnecting in a loop, or an attack; the log says who |
| `Live-PresenceErrors…` | "who is online" and the time-played count may be wrong | the Presence function's log; it recovers by itself at the next connect |
| a puzzle was reported (an e-mail, not an alarm) | a player pressed Report | see *A report, or a takedown notice* |

## Looking at logs

Every function has a log group that keeps a month. The newest lines, following:

```
aws logs tail <log group> --since 1h --follow --format short
aws logs tail <log group> --since 6h --filter-pattern ERROR
```
*(run)*

For a question that spans a lot of lines (CloudWatch Logs Insights; the console has a nicer screen for it, or `aws logs start-query` then `aws logs get-query-results`):

```
fields @timestamp, @message | filter @message like /Error/ | sort @timestamp desc | limit 50
```
*(run: the query starts)*

What the logs hold: errors with ids, never pictures and never e-mail addresses. A player is named by their id (an account's is the `sub` of their token; a guest's starts with `g`).

## Pictures the server keeps (for another puzzle)

A picture or video that has passed the automatic check is kept as a **file**, so that its owner, and the players who joined a puzzle made from it, can make another puzzle from it without sending it again (and without paying for another check: a video costs about ten cents a minute to check). It lives apart from the puzzle: a puzzle ends and deletes its own copy as before, the file stays.

- **How long:** `fileKeepMs` (a week) after it was last used to make a puzzle, and there is no longest (a picture that keeps being used is kept, and is not checked again). It is a limit (below); `fileKeepMs` = `0` switches keeping off (nothing new is kept; files that are there are used until they run out). The table's expiry removes the record and a stream function removes the storage's copy, which can be up to two days late; the service itself never uses or lists a file after its time. The bucket's rules are backstops only: `rooms/` after 35 days, and `files/` after a year (a file used for longer than that is simply sent again).
- **Who may use a file:** its owner, and any signed-in player who joined a puzzle made from it (the server keeps who). Anyone else is refused (`unauthorized`). A guest cannot make puzzles.
- **What it costs:** one more copy of each picture and video for a week (a 250 MB video is about a cent a month of storage), and a puzzle made from a file still costs the player's credits like any other.
- **Looking, deleting:** the **Files** tab of the admin page (above). Ending a puzzle from the page, or with `remove-room`, deletes the file that puzzle's picture was kept as, and ends the other puzzles made from it; **a puzzle's owner closing it does not**. A ban or a deleted account deletes everything the player sent.
- **Privacy:** the privacy policy and the terms say that a copy is kept for a week after the last puzzle made from it, and the box a player ticks says so too (it also says that sexual and adult content is not allowed, and links to the terms).

## Ads

Rewarded ads are AdMob's, shown by the Android app (`android/README.md`); nothing else has any ad code. **The credits come from AdMob's report to the server** (server-side verification), not from the game's word: `docs/online-protocol.md`, *Ads for credits*.

**Setting it up:**
1. In AdMob: an account, the app (Android; iOS later), and **one rewarded ad unit**. Make the **consent message** (Privacy & messaging: GDPR, for the EEA and the UK; without it no ads are served there), and in the app's blocking controls the ad categories that do not fit the game (sexual content and the like): the app asks for nothing above "PG" as well.
2. In the Ad unit's settings, turn on **server-side verification** and give it the callback address: `https://api.dev.puzzlevid.io/credits/ad/callback` for dev, `https://api.puzzlevid.io/credits/ad/callback` for prod (the address of the stage's API; the Api stack's output `Address`). Leave the reward at 1 and the item "credits": the server decides what an ad is worth. AdMob's own tester (**Verify URL**: it asks for a user id and custom data, which are only for the test; any value will do, like `test`, and the custom data can stay empty) sends a call that is answered 200 when AdMob signed it. If it is answered 403 the Api function's log (the admin page's Logs tab, or `aws logs`; filter `callback`) says why: `callback-refused` with `bad-signature`, `unknown-key` or `unsigned`, and the query string as it came.
3. Tell the server which units to believe: the repository variable **`ADMOB_AD_UNITS`** (`gh variable set ADMOB_AD_UNITS --body 'ca-app-pub-XXXXXXXXXXXXXXXX/NNNNNNNNNN'`; several with commas), then **Actions > Deploy** for the stage. Without it a call from AdMob is never believed, whatever it says.
4. In the app: the ids go in `android/local.properties` (`admob.appId`, `admob.rewardedUnit`). The app uses Google's **test ids** until then, and a release build refuses to be made with them.
5. `app-ads.txt`: AdMob wants the file `https://puzzlevid.io/app-ads.txt` (the website that the store listing names) with the line `google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0` (your publisher id, from the AdMob console). Put it in `public/app-ads.txt` of the repository and deploy (not done: it needs the id).

**What an ad pays:** the AdMob console says it all: *Reports* by ad unit and by country shows the estimated earnings, the number of impressions and the **eCPM** (what 1,000 of them pay). The server writes a log line for each ad it rewarded (`{"ad":"rewarded","kind":"photo","given":true,...}`, in the Api function's log; `ad: reward-unclaimed` for one it did not): compare the two to see what one rewarded ad is worth. Expect it to vary a great deal by country, by time of day and by ad format.

**Cost to set against it:** a picture costs a fraction of a cent to check; a video costs about **ten cents a minute** to check (Rekognition Video), so a video credit for one ad can lose money on anything but a short clip. That is the reason for `videoAdsPerDay` (and for deciding what a video credit is worth before more are given).

**Trying it on dev:** with the test ids the app shows test ads; AdMob sends the callback for them too (the console's tester will, at least). `adsTrusted` (a limit) believes the game instead of AdMob and is only for trying the page without any ad network.

## Changing the limits, and switching creation off

The limits of the service are numbers with defaults (`DEFAULT_LIMITS` in `src/online/protocol.ts`): `jigsawPieces` (1000), `playersPerRoom` (8), `activeRoomsPerPlayer` (5), `idleMs` (a day), `solvedKeepMs` (an hour), `maxAgeMs` (30 days), `pictureBytes` (4 MB in the cloud), `fileKeepMs` (a week: how long a picture is kept after it was last used for a puzzle), and the ones about credits and ads, below. A deployment may change any of them with the deploy setting `limits`, a JSON object:

- By hand: `cd infra && npx cdk deploy PuzzleVidio-<stage>-Api --exclusively -c hostedZoneId=<id> -c alertEmail=<address> -c limits="{\"freePhotoCredits\":10}"`.
- Through GitHub (what the deploy workflow reads): `gh variable set LIMITS --body '{"freePhotoCredits":10}'`, then **Actions > Deploy** for the stage (about two minutes). To go back to the defaults, `gh variable delete LIMITS` and deploy.
- A name that is not a limit, or a value that is not a number of 0 or more, stops the deployment with a message (a misspelt limit would otherwise do nothing). (`freeRoomsPerWeek` and `videoRoomsPerWeek` are gone, replaced by credits: a setting that still names them is accepted and they are left out.)

**Account types and credits.** Everybody, guests too, plays alone and joins any puzzle without limit; *starting* a puzzle costs credits (`docs/online-protocol.md`, *Accounts and credits*). A **free** account starts with `freePhotoCredits` (5) photo credits and pays one for each puzzle from a picture; a **paid** one starts pictures for nothing and pays a video credit for each video (`paidVideoCredits`, 20, are for each payment period: nothing gives them yet, because payment is not built: set the credits by hand on the admin page); **family** and **admin** pay nothing, and **what they send is not looked at by Rekognition** (it is yours to look at: the **Files** tab lists what is kept, and every file of such an account is marked as not looked at). Only these two can use a file that was not looked at, so the family cannot pass an unchecked picture to a free account. A new account is made free the first time it is asked about, so the way to make one the family's or an admin is the **Type** box on the Players tab (an account that is in the Cognito group `admins` is an admin whatever its record says, and an account whose record says admin can use the admin page without being in the group). **Ads:** only in the Android and iOS apps, when an account has none of that kind left (`adsPerDay` 5 for a free account's photo credits, `videoAdsPerDay` 5 for a paid account's video credits; 5 and 1 credits: `adPhotoCredits`, `adVideoCredits`); see *Ads*, below. `hostingPaused` = `1` stops the starting of new puzzles (below).

**Puzzles made from a video** are for paid accounts (and the family and admins): a free account is refused (`plan-required`). `videoBytes` (250 MB) and `videoMs` (2 minutes) are the largest and longest video; MP4 and MOV only. **Each one costs about ten cents a minute of video to check** (Amazon Rekognition Video looks at all of it: a two-minute video is about 20 cents, once, when it is made), and storage and bandwidth (each player downloads the whole file once: about 2 GB of transfer, some 18 cents, for a 250 MB video and eight players). The check takes a minute or two; a video it turns down ends the puzzle and e-mails you what it found (the same categories as for pictures); one it cannot read (not H.264) ends the puzzle with a message to the maker. A puzzle whose maker walks away while the check runs stays unjoinable and ends by itself (a day idle). The admin page plays a video puzzle's video.

**Adult content in the stock library.** Pixabay allows some nudity, and its `safesearch` still lets such pictures through (found by testing: with it on, "nude" returns pictures tagged "nude woman"; its site keeps them behind a cover that its API does not offer). So the game's server (`server/src/stockFilter.ts`) answers a search that uses a word of its list (nude, lingerie, erotic, sexy, ...) with nothing, and leaves out any result whose tags, description or page address use one, for both sites. It is a list of words, so it misses some; add to `TERMS` when something slips through. A puzzle made online from a stock picture or video also gets a **stricter automatic look** (`strict` on the room): besides what a family's own pictures are turned down for, it turns down the labels for nudity that is not explicit (`STRICT_ALSO`: implied nudity, partly bare buttocks or breast, intimate parts hidden only by an object). A kiss, a bare back or chest, swimwear and underwear are allowed. The game says that it is a stock item when it makes the puzzle, so this is a courtesy of the game's own page and not a lock (anyone can send their own file, which gets the usual look); an administrator's video is not looked at.

**Administrators' videos are not checked, and neither is anything of the family's.** An admin account (the `admins` group, or a record that says admin) may make a video puzzle of any length and up to 5 GB, and **the automatic check is skipped for it and for the family's accounts, for pictures and videos** (the file must still be the size and kind that the game said). Whoever such an account lets in sees the file unchecked, so only the family should be given the type. The sign-in must carry the group: sign out and in again after being added.

**To stop the making of new puzzles** (joining and playing the ones that exist go on): `hostingPaused` = `1`. Players who try are told "Making new online puzzles is switched off for a while", and nothing is counted against them. Put it back when it is over. *(tested in the service's tests; not run on dev)*

The limits per address (new guests, puzzles made, tries at a code, reports) are `DEFAULT_RATES` in `server/src/ratelimit.ts`; they are not a deploy setting yet, so changing them is a change to the code (a pull request and a deploy).

## Stopping things at once

These act in seconds, without a deployment. They are blunt: players see errors until they are undone. *(not run)*

- **Everything the API does** (an attack, or a bug that is costing money): reserve no concurrency for the API function.
  `aws lambda put-function-concurrency --function-name <ApiFunction> --reserved-concurrent-executions 0`
  and when it is over `aws lambda delete-function-concurrency --function-name <ApiFunction>`. The game's pages still load, and the pieces another player is holding keep moving on screens that are open (those messages do not pass through the function), but nothing can be joined, made, dropped or saved.
- **Only the busiest route:** lower the gateway's throttle. The normal numbers are `API_THROTTLE` in `infra/lib/config.ts` (a deployment sets them again).
- **One player:** ban them (below). **One puzzle:** end it (below).
- **The whole broker** (live updates): the Authorizer function the same way (`put-function-concurrency` 0): nobody can connect.
- **Spending:** the budget alarms e-mail at 50, 80 and 100 % of the month, and when 100 % is *forecast*. They tell; they do not stop anything.

## A report, or a takedown notice

A player's **Report** e-mails the alarm address with the puzzle's id. The operator's tools are a function with no address, which only someone with permission to invoke it can call:

```
echo {"cmd":"reports"} > cmd.json
aws lambda invoke --function-name <AdminFunction> --cli-binary-format raw-in-base64-out --payload file://cmd.json out.json
type out.json
```
*(run: `reports` and `bans`)* (On a machine that is not Windows: `cat out.json`. Putting the payload in a file avoids the quoting of the shell.)

| `cmd` | what it does |
|---|---|
| `reports` (`days`, up to 90, default 30) | the reports, newest first: puzzle, who made it, who was in it, who reported, the reason, the note |
| `room` (`id`) | the puzzle: owner, members, when it ends, and a **short-lived address of its picture** (open it in a browser to look) |
| `remove-room` (`id`) | ends the puzzle now: the picture and codes are deleted, the players are told it was closed; **the kept copy of the picture goes too**, with any other puzzle made from it |
| `ban` (`id`, `reason`) / `unban` (`id`) / `bans` | stops a player from playing online (they leave every puzzle, the ones they made end, and every request but their own account is refused); lifts it; lists them |
| `delete-account` (`id`) | deletes an account the way its owner can in the game (the puzzles it made end, it leaves the others, its name and records go, then the account itself). If it answers that part could not be done, run it again |

The steps for a notice of copyright infringement (the published procedure is the last section of the terms, `src/legal/content.ts`, at `/terms`; **not reviewed by a lawyer, not legal advice**):

1. Find the puzzle: the notice should name its code or link; a code only works for a day, so be quick. A code maps to a puzzle only while it lives; the reports and the notice's own ids are what is left afterwards.
2. `room` to look at it; decide.
3. `remove-room`: the picture is deleted at once (and the copy the server keeps for another puzzle, if there is one) and **no copy is kept for you** (a lawyer may want one: nothing keeps it yet).
4. Write back to the sender. If the same player is named again and again, `ban` them (the drafts say a number: it is the owner's to decide).
5. A counter-notice: the puzzle cannot be put back (it is gone); the maker can make a new one.

## Banning, and asking to be forgotten

- A ban is an id and a short reason, kept until it is lifted, **also when the account is deleted** (a new account has a new id, so a ban stops a player only as far as they do not sign up again; a guest who clears their browser is a new guest).
- A player who asks to be forgotten uses **Profile > Delete account** in the game, or `https://<game>/#/delete-account`. For someone who cannot sign in: `delete-account` above, with the id (ask them for the e-mail they signed up with; find the id in the Cognito user pool: `aws cognito-idp list-users --user-pool-id <id> --filter 'email = "<address>"'`, the `sub` attribute). Safety copies of the table expire within 35 days (prod only has them).

## Sign-up e-mail

- The codes come from `no-reply@<domain>` through Amazon SES. **While the SES account is in the sandbox** (`aws sesv2 get-account` says `ProductionAccessEnabled: false`) only addresses verified one by one receive anything: `aws sesv2 create-email-identity --email-identity <address>`, then they click the link. A request to leave the sandbox was filed by the owner on 2026-10-30 (it can take up to 96 hours).
- If sign-ups say they got no code once the sandbox is gone: `aws sesv2 get-account` (sending enabled? a pause for bounces or complaints shows there), the domain `aws sesv2 get-email-identity --email-identity <domain>` (`VerifiedForSendingStatus`, DKIM `SUCCESS`), and the spam folder.
- A player who forgot the password uses **Forgot your password?** in the sign-in window (a code by e-mail). The operator can also set one: `aws cognito-idp admin-set-user-password --user-pool-id <id> --username <address> --password <new> --permanent` (then tell them to change it; do not send it in clear).

## Deploying, and going back

- **Dev deploys itself:** every change merged into `main` is tested (the game's tests and the type check) and then deployed to dev, unless it only touches documents (`docs/`, `*.md`). Watch it under Actions > Deploy, or `gh run list --workflow deploy.yml`. A failing test stops it before anything is deployed.
- **Production is deployed by hand:** Actions > Deploy > Run workflow, stage `prod`, and the word `prod` typed in the box (without it the run stops at once), or `gh workflow run deploy.yml --ref main -f stage=prod -f confirm=prod`. Dev by hand is the same with `-f stage=dev`. Both run from `main` only. **`prod` has not been deployed yet** (it needs the Google client if Google sign-in is wanted, and SES out of the sandbox).
- **What a deploy does:** the five stacks of the stage, then the game is built against what they said (addresses, pool, client) and put in the bucket, and the cache is emptied. One deployment of a stage at a time: a second waits. `gh run watch <id>` follows one.
- **Which version is running:** the main screen shows it at the bottom right (`v0.0.1 · build 57 · a1b2c3d · dev`): `package.json`'s version (change it by hand for a release), the number of the deploy run, the commit it was built from, and the stage (not shown for prod). The page says when it was built if the pointer rests on it.
- **The Ops stack** (budget, deploy role, e-mail domain) is not in that workflow: it is deployed by hand with the owner's own credentials, and **needs `-c githubSubjectPrefix=...` every time** (see `infra/README.md`, step 5) or the deploy role stops trusting the repository.
- **Going back:** `git revert` the pull request on a branch, merge, deploy. A stack that fails half way rolls itself back (CloudFormation). The data (the table, the picture bucket) is not touched by a deploy of the code.
- **`dev` and `prod` share the broker's account** and its lifecycle events: each ignores the other's rooms.

## Quotas

- **Lambda concurrent runs** was 10 in this new account. A request for **1000** was filed on 2026-10-30 (Service Quotas, id `6a89f90ccea24e4580c19914eb919aa4gACcheB3`); `aws service-quotas list-requested-service-quota-change-history-by-quota --service-code lambda --quota-code L-B99A9384` says how it stands. Once it is granted: reserve some for the API function so that a bug elsewhere cannot starve it (not done yet; a reservation is a deploy setting that does not exist yet).
- **Pixabay** (the stock library) lets one key make 100 requests a minute; the server stops at 1500 an hour and keeps each answer for a day, so it is unlikely to be the limit. If its key is missing or wrong the tab says the library is not available (the API function logs the failed read of the secret).
- **Pexels** (the stock library, when it has a key) lets one key make 200 requests an hour and 20,000 a month. The server stops at 150 an hour (`stockUpstream`) and keeps each answer for ten minutes, so a busy day shows as players being told the library is busy: ask Pexels (pexels.com/api) to lift the limit, which they do for free for credited use.
- Still to ask for before a launch: IoT Core connection and message rates, the API's throttle, DynamoDB (it is pay per request and rarely the limit).

## Not covered yet

- No dashboard: the alarms and the logs are what there is.
- No way to switch off sign-ups; the Cognito user pool takes them (the SES sandbox is what limits them now).
- No evidence copy of a puzzle that was reported or taken down.
- `prod` does not exist yet, so none of this has run there.
