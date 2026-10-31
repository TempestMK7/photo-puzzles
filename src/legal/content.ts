// The text of the privacy policy and the terms (published at /privacy and /terms: privacy.html and terms.html, built by vite.config.ts). The facts in it come from the code and the
// AWS setup: when one of these changes, so must the text (tests/legal.test.ts checks the numbers against the constants). No browser or Node dependencies, like protocol.ts.

/** What the text says about who runs the game; they come from the deploy (repository variables), not from this repository. */
export interface LegalValues {
  /** Who is responsible: a name, or a company and its address. */
  operator: string;
  /** Where to write: an e-mail address. */
  contact: string;
  /** The law and courts that the terms go by, like "the laws of Ohio, USA": nothing is said about it when this is empty. */
  law: string;
}

export type Block = { h: string } | { p: string } | { ul: string[] } | { table: { head: string[]; rows: string[][] } };

export interface LegalPage {
  /** What the browser's tab says, and the heading. */
  title: string;
  /** When the text last changed in a way a reader should know about. */
  updated: string;
  blocks: Block[];
}

/** Change this whenever the text of either page changes in substance. */
export const LEGAL_UPDATED = '2026-10-30';

// Inside a text: `{contact}` is a link to write to, `{operator}` the name, `{delete}` a link to the page that deletes an account, `**x**` bold.

export function privacy(): LegalPage {
  return {
    title: 'Privacy policy',
    updated: LEGAL_UPDATED,
    blocks: [
      { p: 'PuzzleVidio turns your own pictures and videos into puzzles. This page says what the game sends and keeps, and for how long. It is run by {operator}. Questions: {contact}.' },
      { h: 'The short version' },
      {
        ul: [
          '**Playing alone sends nothing anywhere.** Your pictures and videos, your puzzles in progress and your best times stay on your device.',
          '**Playing with friends** sends the picture of the puzzle to our server so that the others can see it, and keeps a name and an id for you for as long as the puzzle lasts. A puzzle and its picture are deleted when it is solved, when nobody has touched it for a day, or after 30 days at the latest.',
          '**Making a puzzle needs an account** (Google, or an e-mail address and a password). **Joining one does not**: you are a guest with a name you choose.',
          'You can delete your account in the game, or at {delete}.',
        ],
      },
      { h: 'What we have, and why' },
      {
        table: {
          head: ['What', 'When', 'Why', 'How long it is kept'],
          rows: [
            ['The **picture** of a puzzle (and nothing else of your library)', 'when you make a puzzle for friends, after you tick the box that says it is sent', 'so that the players of the puzzle can see it', 'until the puzzle ends: an hour after it is solved (so that the others can look), when nobody has touched it for a day, or 30 days after it was made. A deleted file can stay in a safety copy of the storage for up to 35 days'],
            ['A **check of the picture** by an automatic service (Amazon Rekognition) for explicit, violent, disturbing or hateful content', 'when the picture arrives', 'to keep such pictures out', 'the check is done by Amazon Web Services, whose own terms apply to it; we keep only its result for the puzzle'],
            ['The **state of the puzzle** (where the pieces are, who holds one)', 'while you play', 'so that everyone sees the same board', 'until the puzzle ends (as above)'],
            ['Your **display name** and a colour', 'when you join or make a puzzle', 'so that the others know who is who', "an account's name: until you delete the account. A guest's name: 100 days after you last set it"],
            ['Your **account**: e-mail address, and the name and the profile picture (its web address, not the image) that Google gives us if you sign in with Google', 'when you create an account', 'to sign you in and to count the puzzles you may make', 'until you delete the account. Held by our sign-in service (Amazon Cognito)'],
            ['A **guest id** (a random id, signed by us; kept on your device)', 'the first time you join a puzzle without an account', 'so that the server knows you are the same guest when you come back', 'the token lasts 90 days and is renewed when you come back'],
            ['**Which puzzles you are in**, and when you made puzzles (for the limit of three a week)', 'while you play', 'to show your list, and to keep the limit', 'your memberships: until the puzzle ends or you leave. The record of puzzles made: 8 days'],
            ['Your **network address** (IP address)', 'every request to our server', 'to stop a script from guessing codes or making thousands of guests: counters per address, not a log', 'a few hours (counters of one hour or fifteen minutes; the database deletes them within two days)'],
            ['A **report** about a puzzle, if someone sends one: the reason, a note, who made the puzzle, who was in it, who reported', 'when a player reports a puzzle', 'so that the operator can look at it and decide', '90 days'],
            ['A **ban** (an id and a short reason), if the operator stops a player', 'when it is done', 'so that the player cannot come back with the same id', 'until the operator lifts it. It stays if the account is deleted, because it is only an id'],
            ['**Technical logs** of our server functions (errors, with ids, never pictures)', 'always', 'to find faults', '30 days'],
            ['**Safety copies** of the database', 'continuously', 'to restore it if it is damaged', 'up to 35 days'],
          ],
        },
      },
      { p: 'The other players of a puzzle can see your display name, your colour, that you are in the puzzle and whether you are connected, which piece you hold, and the picture. They cannot see your e-mail address or your id. A profile picture from Google is shown only to you, in the round badge on your own screen, and your browser loads it from Google.' },
      { p: 'A puzzle can also be made from a **video**. Everything on this page that is said about the picture of a puzzle holds for its video too (the player who made it sends the whole video to our server, where the other players get it), and the automatic check (by Amazon Rekognition) looks at all of the video.' },
      { h: 'What we do not do' },
      {
        ul: [
          'We do not sell data, show advertisements, or use your pictures for anything but the puzzle.',
          'We do not look at pictures ourselves unless a player reports a puzzle or the automatic check turns it down.',
          'We do not keep your library, your saved puzzles or your times: they are on your device.',
        ],
      },
      { h: 'Where it is kept' },
      { p: 'At Amazon Web Services in the United States (the us-east-1 region). If you use the game from somewhere else, your data goes there.' },
      { h: 'On your device' },
      { p: "The game keeps on your device your pictures and puzzles (in the browser's storage), your settings, a sign-in (tokens from the sign-in service) if you have an account, and a guest token if you joined as a guest. There is no analytics, no advertising and no tracking by us." },
      { h: 'Your choices' },
      {
        ul: [
          '**Delete your account:** in the game (Play with friends, then Delete account) or at {delete}. The puzzles you made end and their pictures are deleted, you leave the puzzles you joined, your name and the record of puzzles made are deleted, and the account is deleted from the sign-in service. Safety copies run out within 35 days.',
          "**A guest** has no account to delete, but a guest's data goes by itself (see the table above). To have a guest name removed earlier, write to {contact}.",
          '**Ask what we have, or ask us to correct or delete something:** write to {contact}. Where the law gives you more rights over your data than this page does, they are yours too.',
        ],
      },
      { h: 'Children' },
      { p: 'The game is for people who are at least 13 years old (or older where the law says so). Do not make an account, or put a picture in an online puzzle, if you are younger. If you think a child has done so, write to {contact} and we will delete it.' },
      { h: 'Changes' },
      { p: 'If this page changes in a way that matters, the date at its top changes with it.' },
    ],
  };
}

export function terms(v: LegalValues): LegalPage {
  const law = v.law.trim();
  const which: Block[] = law ? [{ h: '8. Which law' }, { p: `These terms go by ${law}.` }] : [];
  return {
    title: 'Terms of service',
    updated: LEGAL_UPDATED,
    blocks: [
      { p: 'These terms are between you and {operator} ("we"). By using online puzzles you agree to them and to the privacy policy.' },
      { h: '1. What this covers' },
      { p: 'PuzzleVidio (the game) turns your own pictures and videos into puzzles. **Playing alone** happens on your device and needs no account. **Playing with friends** (online puzzles) uses our server, and most of these terms are about that.' },
      { h: '2. Accounts and guests' },
      {
        ul: [
          'You may join an online puzzle as a **guest**, with a name you choose. You need an **account** (Google, or an e-mail address and a password) to make one.',
          'You are responsible for what happens under your account. Keep your sign-in to yourself.',
          'You must be at least 13 years old (or older where the law says so) to use online puzzles.',
          'You can delete your account at any time (in the game, or at {delete}). The privacy policy says what that deletes.',
        ],
      },
      { h: '3. Pictures you put in an online puzzle' },
      { p: 'When you make an online puzzle you send its picture to our server, and the people you give the code or link to can see it. You say, by ticking the box, that you agree to that. You promise that:' },
      {
        ul: [
          "you made the picture, or you have the right to use it this way (and to let the people you invite see it), and it does not infringe anyone's copyright or other rights;",
          'it is not illegal, and does not contain sexual or explicit content, graphic violence, content that is meant to shock or disturb, or hateful symbols or content, or anything that harasses or threatens a person; it does not show a person who has not agreed, in a way that harms them;',
          'it contains no personal information of other people that they have not agreed to share.',
        ],
      },
      { p: 'This section is about a video as much as about a picture: an online puzzle may be made from a video, which is sent to our server, shown to the people of the puzzle, and ended and deleted with it in the same way. The automatic check looks at all of a video, which takes a minute or two.' },
      { p: 'A picture is looked at by an **automatic check** when it arrives. A picture that the check turns down is not used, and the puzzle you made for it ends. The check can be wrong in both directions: a picture that passed is not therefore allowed.' },
      { p: 'You keep your rights in the picture. You give us permission only to store it, copy it, and show it to the people of the puzzle, for as long as the puzzle exists (a puzzle ends when it is solved, when nobody has touched it for a day, or 30 days after it was made at the latest), and to let our automatic check and our operator look at it as described here.' },
      { h: '4. How you behave' },
      { p: "Do not use online puzzles to harass anyone, to cheat or disturb other players, to try to break or overload the service (including guessing codes or making many guests), to get around a limit or a ban, or in any way that is against the law. Be decent in the names you choose: no one else's name, and no name that insults." },
      { h: '5. Reports, removal and bans' },
      {
        ul: [
          'Any player of a puzzle can **report** it from inside the puzzle. We are told, look at the report and, if needed, the picture, and decide.',
          'We may **end a puzzle** (the picture and the codes are deleted and the players are told it was closed) and may **stop an account or a guest** from playing online, for breaking these terms or the law, with or without warning. A stopped player is taken out of every puzzle, and the puzzles they made end. If you think we were wrong, write to {contact} and we will look again.',
          'The owner of a puzzle can send a player out of it. That is not a ban: the player can come back with the old link or code unless the owner makes a new one.',
        ],
      },
      { h: '6. Limits, and the service as it is' },
      { p: 'The service has limits (for example three new online puzzles a week for a free account, eight players in a puzzle, a size for the picture) that can change. Online puzzles are **temporary**: they end by themselves and are not backed up for you. The service is provided **as it is**, without a promise that it will always be there or free of faults, and to the extent the law allows we are not liable for loss that comes from using it.' },
      { h: '7. Changes and ending' },
      { p: 'We may change these terms or the service. If a change matters, the date at the top of this page changes, and the new terms apply from the next time you use the game. You may stop using it at any time. We may stop or change the service, or stop it for you, as described above.' },
      ...which,
      { h: `${law ? '9' : '8'}. Copyright notices` },
      { p: 'If you believe a picture in an online puzzle infringes your copyright, send a notice to {contact} with:' },
      {
        ul: [
          'a description of the work you say is infringed, and your signature (typed is enough) as the owner or as the person who may act for the owner;',
          "where the picture is: the puzzle's code or link, or the ids in a report (a puzzle ends by itself within 30 days, so say what you know quickly);",
          'your name, address, e-mail address and phone number;',
          'a statement that you believe in good faith that the use is not allowed by the owner, their agent or the law;',
          'a statement, under penalty of perjury, that the notice is accurate and that you are the owner or may act for the owner.',
        ],
      },
      { p: '**What we do:** we look at the notice and, if it is in order, end the puzzle (which deletes the picture and the codes), tell the person who made it that and why, and stop the account of someone who does this again and again.' },
      { p: '**Counter-notice:** the person who made the puzzle may answer with a statement, under penalty of perjury, that they believe the picture was removed by mistake, with their name, address and agreement to the reach of the courts that the law gives. A puzzle that has ended cannot be put back (its picture is deleted), so the maker can make a new one.' },
      { p: '**Other things that are not copyright** (privacy, harassment, illegal content): use the **Report** button in the puzzle, or write to {contact}.' },
    ],
  };
}
