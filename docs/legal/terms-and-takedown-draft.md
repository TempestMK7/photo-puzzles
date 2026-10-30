# PuzzleVidio terms of service and copyright notice procedure — DRAFT

> **Not legal advice and not reviewed.** A starting point that says what the game and the operator's tools actually do, for a lawyer to turn into terms that fit the owner and the places the game is used.
> `[square brackets]` are blanks or decisions. The rules below match what the code can do (report, remove a puzzle, ban a player, delete an account); a rule that the code cannot carry out should not be promised.
> Nothing here is published by the game yet.

Last changed: `[date]` · Operator: `[name or company, address]` · Contact: `[e-mail address]` · Governing law and courts: `[ ]`

## 1. What this covers

PuzzleVidio (the game) turns your own pictures and videos into puzzles. **Playing alone** happens on your device and needs no account and no agreement beyond these terms. **Playing with friends**
(online puzzles) uses our server, and the rest of these terms are mostly about that.

## 2. Accounts and guests

- You may join an online puzzle as a **guest**, with a name you choose. You need an **account** (Google, or e-mail and password) to make one.
- You are responsible for what happens under your account. Keep your sign-in to yourself.
- `[minimum age, and what applies to children]`
- You can delete your account at any time (in the game, or at `[the game's address]/#/delete-account`). See the privacy policy for what that deletes.

## 3. Pictures you put in an online puzzle

When you make an online puzzle you send its picture to our server, and the people you give the code or link to can see it. You say, by ticking the box, that you agree to that.

You promise that:

- you made the picture, or you have the right to use it this way (and to let the people you invite see it), and it does not infringe anyone's copyright or other rights;
- it is not **illegal**, and does not contain **sexual or explicit content, graphic violence, content that is meant to shock or disturb, or hateful symbols or content**, or anything that **harasses or threatens**
  a person; it does not show a person who has not agreed, in a way that harms them;
- it contains no personal information of other people that they have not agreed to share.

A picture is looked at by an **automatic check** when it arrives. A picture that the check turns down is not used, and the puzzle you made for it ends. The check can be wrong in both directions: it does not mean
a picture that passed is allowed.

You keep your rights in the picture. You give us permission only to store it, copy it, and show it to the people of the puzzle, for as long as the puzzle exists (a puzzle ends when it is solved, when nobody
has touched it for a day, or 30 days after it was made at the latest), and to let our automatic check and our operator look at it as described here.

## 4. How you behave

Do not use online puzzles to harass anyone, to cheat or disturb other players, to try to break or overload the service (including guessing codes or making many guests), to get around a limit or a ban, or in any
way that is against the law. Be decent in the names you choose: no one else's name, no name that insults.

## 5. Reports, removal and bans

- Any player of a puzzle can **report** it from inside the puzzle. The operator is told, looks at the report and, if needed, the picture, and decides.
- The operator may **end a puzzle** (the picture and the codes are deleted and the players are told it was closed) and may **stop an account or a guest** from playing online, for breaking these terms or the law,
  with or without warning `[decide: warning first? appeal?]`. A stopped player is taken out of every puzzle, and the puzzles they made end.
- A puzzle owner can send a player out of their puzzle. That is not a ban: the player can come back with the old link or code unless the owner makes a new one.

## 6. Limits, and the service as it is

The service has limits (for example three new online puzzles a week for a free account, eight players in a puzzle, a size for the picture) that can change. Online puzzles are **temporary**: they end by themselves
and are not backed up for you. `[Paid tiers, if any, are not covered yet.]` The service is provided **as it is**, without a promise that it will always be there or free of faults. `[liability and warranty wording,
as the law of the operator's country allows]`

## 7. Changes and ending

We may change these terms or the service; `[how we say so, and from when]`. You may stop using it at any time. We may stop or change the service, or stop it for you, as described above.

## 8. Contact

`[e-mail address, and a postal address if the law needs one]`

---

# Notice of copyright infringement and counter-notice (draft)

> `[A lawyer decides what this must say for the countries the game is used in. The text below follows the common US form (DMCA §512), and the European rules (notice-and-action) may need more. In the US the
> operator must register a **designated agent** with the Copyright Office to have the protection; that is the owner's step to take.]`

If you believe a picture in an online puzzle infringes your copyright, send a notice to **`[designated agent: name, address, e-mail]`** with:

1. a description of the work you say is infringed, and your signature (typed is enough) as the owner or as the person who may act for the owner;
2. where the picture is: **the puzzle's code, or the link, or the ids in the report** (a puzzle ends by itself within 30 days, so say what you know quickly);
3. your name, address, e-mail and phone number;
4. a statement that you believe in good faith that the use is not allowed by the owner, their agent or the law;
5. a statement, under penalty of perjury, that the notice is accurate and that you are the owner or may act for the owner.

**What we do:** we look at the notice and, if it is in order, end the puzzle (which deletes the picture and the codes), tell the person who made it that and why, and stop the account of someone who does this
again and again `[repeat-infringer policy: decide the number]`.

**Counter-notice:** the person who made the puzzle may answer with a statement, under penalty of perjury, that they believe the picture was removed by mistake, with their name, address and agreement to the
courts' reach `[from the law]`. `[We then pass it to the sender and, if they do not go to court within 10–14 business days, may put it back: a puzzle cannot really be put back (it ended and the picture
was deleted), so the answer is that the maker can make a new one.]`

**Other things that are not copyright** (privacy, harassment, illegal content): use the **Report** button in the puzzle, or write to `[contact]`.

---

### What the operator can do, in the code (delete this section from the published text)

`RoomService.adminRoom`, `adminRemoveRoom`, `adminBan`, `adminUnban` and the **Admin** function of the Api stack (see `infra/README.md`). A report is kept 90 days (`REPORT_KEEP_MS`). A removed puzzle's
picture is deleted at once (`cleanup`); the report keeps only ids and the reporter's note, not the picture. If a takedown needs the evidence kept, there is no way to do that yet.
