# PuzzleVidio privacy policy — DRAFT

> **Not legal advice and not reviewed.** This is a technical draft: the facts in it (what is sent, where it is kept, for how long) were written from the code and the AWS setup in this repository, so that a lawyer
> can check the wording and the law against what the game really does. Everything in `[square brackets]` is for the owner or the lawyer to fill in or decide. Keep this in step with the code: if a
> retention time or a service changes, the text must change with it (the places in the code are named at the end).
>
> Nothing here is published by the game yet (no page links to it).

Last changed: `[date]` · Who is responsible: `[name or company, address]` · Contact: `[e-mail address for privacy questions]`

## The short version

- **Playing alone sends nothing anywhere.** Your pictures and videos, your puzzles in progress and your best times stay on your device.
- **Playing with friends** sends the picture of the puzzle to our server, so that the others can see it, and keeps a name and an id for you for as long as the puzzle lasts. A puzzle and its picture are deleted when it is
  solved, when nobody has touched it for a day, or after 30 days at the latest.
- **Making a puzzle needs an account** (Google or e-mail). **Joining one does not**: you are a guest with a name you choose.
- You can delete your account, in the game or at `[the game's address]/#/delete-account`.

## What we have, and why

| What | When | Why | How long it is kept |
|---|---|---|---|
| The picture of a puzzle (and nothing else of your library) | when you make a puzzle for friends, after you tick the box that says it is sent | so that the players of the puzzle can see it | until the puzzle ends: solved (an hour after, so that the others can look), idle for a day, or 30 days after it was made; deleted files may stay in a safety copy of the storage for up to 35 days `[check: S3 lifecycle 35 days]` |
| What the picture shows is looked at by an automatic service (Amazon Rekognition) for explicit, violent, disturbing or hateful content | when the picture arrives | to keep such pictures out | the service does not keep the picture `[confirm against AWS's terms]` |
| The state of the puzzle (where the pieces are, who holds one) | while you play | so that everyone sees the same board | until the puzzle ends (as above) |
| Your **display name** and a colour | when you join or make a puzzle | so that the others know who is who | an account's name: until you delete the account. A guest's name: 100 days after you last set it |
| Your **account**: e-mail address, and the name that Google gives us if you sign in with Google | when you create an account | to sign you in and to count the puzzles you may make | until you delete the account. Held by our sign-in service (Amazon Cognito) |
| A **guest id** (a random id, signed by us; kept on your device) | the first time you join a puzzle without an account | so that the server knows you are the same guest when you come back | the token lasts 90 days and is renewed when you come back |
| **Which puzzles you are in**, and when you made puzzles (for the limit of three a week) | while you play | to show your list, and to keep the limit | your memberships: until the puzzle ends or you leave. The record of puzzles made: 8 days |
| Your **network address (IP address)** | every request to our server | to stop a script from guessing codes or making thousands of guests: counters per address, not a log | a few hours (counters of one hour or fifteen minutes; the database deletes them within two days) |
| **Reports** about a puzzle, if someone sends one: the reason, a note, who made the puzzle, who was in it, who reported | when a player reports a puzzle | so that the operator can look at it and decide | 90 days |
| A **ban** (an id and a short reason), if the operator stops a player | when it is done | so that the player cannot come back with the same id | until the operator lifts it; it stays if the account is deleted `[decide: is this acceptable, or should it also expire?]` |
| **Technical logs** of our server functions (errors, with ids, never pictures) | always | to find faults | 30 days |
| **Safety copies** of the database (the real, live one only) | continuously | to restore it if it is damaged | up to 35 days `[check: point-in-time recovery]` |

Other players of a puzzle can see: your display name, your colour, that you are in the puzzle and whether you are connected, which piece you hold, and the picture. They cannot see your e-mail address or your id.

## What we do not do

- We do not sell data, show advertisements, or use your pictures for anything but the puzzle. `[confirm]`
- We do not look at pictures ourselves unless a player reports a puzzle or the automatic check turns it down.
- We do not keep your library, your saved puzzles or your times: they are on your device.

## Where it is kept

At Amazon Web Services in the United States (region us-east-1). `[add the legal basis for this transfer if the law of the readers' countries needs one]`

## On your device

The game keeps on your device: your pictures and puzzles (browser storage), your settings, a sign-in (tokens from the sign-in service) if you have an account, and a guest token if you joined as a guest. There is no
analytics and no advertising. `[confirm there is none when the game is published; if a cookie notice is needed, say so]`

## Your choices

- **Delete your account:** in the game (Play with friends → Delete account…) or at `[the game's address]/#/delete-account`. The puzzles you made end and their pictures are deleted, you leave the puzzles you joined,
  your name and the record of puzzles made are deleted, and the account is deleted from the sign-in service. Safety copies run out within 35 days.
- **A guest** can delete nothing by an account, but a guest's data goes by itself (above), and `[how a guest asks us to remove their name earlier: contact address]`.
- **Ask what we have, or ask us to correct or delete something:** `[contact address]`. `[add the rights that the law of the readers' countries gives and how they are exercised]`

## Children

`[decide the minimum age, and what is said about children: the game is for everyone, but an account and a picture sent to strangers need thought. Google Play's rules for families and COPPA / GDPR-K may apply.]`

## Changes

`[how changes are announced]`

---

### Where in the code the facts above come from (delete this section from the published text)

- Limits and times: `DEFAULT_LIMITS` in `src/online/protocol.ts` (24 hours idle, one hour after solving, 30 days at most, three puzzles a week), `GUEST_LIFE_MS` (`server/src/guest.ts`),
  `GUEST_NAME_KEEP_MS` (`server/src/service.ts`).
- What is stored and for how long: the layout comment in `server/src/aws/dynamo.ts` (`CREATION_KEEP_MS` 8 days, `REPORT_KEEP_MS` 90 days, `DynamoRates` windows) and `infra/lib/data-stack.ts` (the 35-day storage rule, point-in-time recovery for the live stage).
- Logs: `infra/lib/lambda.ts` (a month).
- The picture check: `server/src/aws/rekognition.ts`. Deleting an account: `RoomService.deleteAccount`.
