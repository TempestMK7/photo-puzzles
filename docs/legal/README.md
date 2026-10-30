# The privacy policy and the terms

**Where the text is:** `src/legal/content.ts`. It is built into two plain pages, `privacy.html` and `terms.html`, by `vite.config.ts` (no script runs on them), and the site shows them at
`/privacy` and `/terms` (a CloudFront function in `infra/lib/web-stack.ts` maps the addresses; the main screen links to both from its footer). Change the text in `content.ts` and bump `LEGAL_UPDATED`.

**What is not in the repository:** who runs the game, where to write, and the law the terms go by. The deploy takes them from repository variables (Settings > Secrets and variables > Actions >
Variables): `LEGAL_OPERATOR`, `LEGAL_CONTACT` (an e-mail address; **a prod deploy stops without it**) and `LEGAL_LAW` (optional, like `the laws of Ohio, USA`; the terms say nothing about law without it).
Without them a dev build says "the operator of PuzzleVidio" and "the contact address is not set in this build".

**Not legal advice, and not reviewed by a lawyer.** The facts in the text were written from the code and the AWS setup. A lawyer should check the wording, and the law of the places the game is
used, against what the game does. Choices made in the text that the owner or the lawyer may want to change:

- minimum age **13** (older where the law says so; GDPR-K sets 16 in some countries, and Google Play's families rules may apply);
- a ban or the end of a puzzle may come "with or without warning", and the answer to an appeal is to write to the contact address;
- no number for a repeat infringer ("again and again"), and **no designated agent is registered** with the US Copyright Office: that is the owner's step if the DMCA safe harbour is wanted;
- the data is kept in the United States (AWS us-east-1) and the text says so, without naming a legal basis for transfers;
- the picture check by Amazon Rekognition: the text says AWS's own terms apply to it. AWS may keep and use content processed by some of its AI services to improve them unless an AI services
  **opt-out policy** is set in AWS Organizations; whether to set one is the owner's decision (it is not set).

## Where each fact in the text comes from (keep the text in step with these)

- Limits and times: `DEFAULT_LIMITS` in `src/online/protocol.ts` (24 hours idle, one hour after solving, 30 days at most, three puzzles a week, eight players), `GUEST_LIFE_MS` (`server/src/guest.ts`, 90
  days), `GUEST_NAME_KEEP_MS` (`server/src/service.ts`, 100 days). `tests/legal.test.ts` checks the numbers it can against these.
- What is stored and for how long: the layout comment in `server/src/aws/dynamo.ts` (`CREATION_KEEP_MS` 8 days, `REPORT_KEEP_MS` 90 days, `DynamoRates` windows) and `infra/lib/data-stack.ts` (the
  35-day storage rule, point-in-time recovery for the live stage only).
- Logs: `infra/lib/lambda.ts` (a month).
- The picture check: `server/src/aws/rekognition.ts`. Deleting an account: `RoomService.deleteAccount`. What the operator can do: `RoomService.adminRoom`, `adminRemoveRoom`, `adminBan`,
  `adminUnban`, the Admin function and the admin page (`infra/README.md`). A report is kept 90 days; a removed puzzle's picture is deleted at once (`cleanup`), so if a takedown needs the evidence
  kept, there is no way to do that yet.
- The game keeps no analytics and shows no advertising. If either is added, the text must say so first.

## Where the pages are used

- The Google sign-in consent screen asks for the addresses of both pages: `https://puzzlevid.io/privacy` and `https://puzzlevid.io/terms`.
- Google Play's data-safety form and the store listing need the privacy address too (the owner's).
