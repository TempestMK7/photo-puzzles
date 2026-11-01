import './style.css';
import { Prefs } from './core/prefs';
import { PhotoLibrary } from './store/photos';
import { OnlineApi } from './online/api';
import { CognitoAccount } from './online/cognito';
import { cloudConfig, onlineBase } from './online/config';
import { GuestAccount } from './online/guestAccount';
import { DevAccount, DevIdentity, type Account } from './online/identity';
import { IotRealtime } from './online/iotRealtime';
import { parseInvite } from './online/protocol';
import { WsRealtime, type Realtime } from './online/realtime';
import { OnlineSession } from './online/session';
import { SaveStore } from './store/saves';
import { preloadEffects, setEffectsOn } from './sounds';
import { listenForShared } from './store/shared';
import type { PhotoEntry } from './store/photos';
import { LibraryScreen } from './ui/library';
import { OnlinePanel } from './ui/online';
import { PlayScreen } from './ui/play';
import { browserSignIn, takeSignIn } from './platform';
import { CreditsUi } from './ui/credits';
import { DELETE_HASH, ProfileDialog, takeAccountDeletedNotice } from './ui/profile';
import { SignInDialog } from './ui/signin';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // the admin page (https://<the game's address>/admin) is a page of its own, loaded only for whoever goes there: the game is not started
  if (/^\/admin\/?$/.test(window.location.pathname)) {
    const { openAdmin } = await import('./admin/page');
    await openAdmin(document.getElementById('app')!);
    return;
  }
  const prefs = new Prefs(storage());
  setEffectsOn(prefs.data.sfx);
  preloadEffects();
  const saves = new SaveStore();
  const photos = new PhotoLibrary((id) => saves.removeForPhoto(id));
  await photos.init();
  for (const id of ['sample-dusk', 'sample-meadow', 'sample-ember']) void saves.removeForPhoto(id);    // the pictures that came with the game are gone: so are the puzzles that were left on them

  const root = document.getElementById('app')!;
  // Playing with friends, in a build that knows where the server is: the real thing (Cognito accounts, the API and the broker on AWS) when the build has all of that, otherwise the local
  // server of `npm run server` in development, with a made-up identity.
  const cloud = cloudConfig();
  const base = cloud?.api ?? onlineBase();
  const dev = new DevIdentity();
  // the way to sign in: Cognito in the cloud, the made-up identity (which can be signed out, to play as a guest) on a developer's machine
  // (Google does not let its sign-in page open inside an app's web view, so the Android app has no Google button until it signs in through the browser: docs/online-play-plan.md)
  // (an app whose shell opens the sign-in pages in the phone's browser and takes the player back can: see `browserSignIn`)
  const google = !!cloud?.google && (browserSignIn() || !('PhotoPuzzlesNative' in window));
  const accountSource: Account | null = cloud ? new CognitoAccount({ host: cloud.cognitoHost, clientId: cloud.cognitoClientId, google }, storage(), session()) : base ? new DevAccount(dev) : null;
  // the sign-in page sends the player back with a code in the address
  let signedInHash = '';
  let signInFailed = false;
  if (accountSource instanceof CognitoAccount) {
    // (in an app: the address that the sign-in service sent the player back to the app with, if it came while the page was not there: the system closed the app, say)
    const back = await accountSource.completeSignIn(takeSignIn() || window.location.href);
    if (back.handled) {
      history.replaceState(null, '', window.location.pathname + (back.ok ? back.hash : ''));        // the code does not stay in the address bar
      signedInHash = back.ok ? back.hash : '';
      signInFailed = !back.ok;
    }
  }
  // who is playing: the account, or else a guest (who may join puzzles but not make them), or nobody yet
  const player = new OnlineSession(accountSource, new GuestAccount(base, storage()), storage());
  const api = base ? new OnlineApi(base, () => player.token(), () => player.signInLost()) : null;
  if (api) player.attach(api);
  const realtime: Realtime | null =
    cloud && api
      ? new IotRealtime({ endpoint: cloud.iotEndpoint, authorizer: cloud.iotAuthorizer }, player, async (room) => {
          const res = await api.getRoom(room);
          return res.ok ? 'member' : res.error === 'offline' || res.error === 'sign-in' ? 'unknown' : 'not-member';
        })
      : base
        ? new WsRealtime(base, () => player.token())
        : null;
  const play = new PlayScreen({
    prefs,
    photos,
    saves,
    onExit: () => showLibrary(),
    otherPhoto: (id) => library.otherPhoto(id),
    online: api ? { api } : undefined,
    player,
    photoAdded: (id) => void library.photoAdded(id),
  });
  // the pop-ups for signing in (the game's own pages, in a build whose accounts have them) and for the profile, with the round badge on the main screen
  const signInDialog = player.passwords ? new SignInDialog(player.passwords, player.google, browserSignIn()) : null;
  const signIn = async (): Promise<boolean> => {
    let signedIn = true;
    if (signInDialog) signedIn = await signInDialog.ask();
    else await player.signIn();          // the local build's stand-in
    // (the page is not loaded again: the credits at the top of the screen are asked for now)
    if (signedIn) {
      void player.refreshProfile().then(() => profile?.refreshBadge());
      player.changed();
      profile?.refreshBadge();
    }
    return signedIn;
  };
  const profile: ProfileDialog | null = api
    ? new ProfileDialog({
        identity: player,
        api,
        signIn,
        changed: () => {
          profile?.refreshBadge();
          void player.refreshProfile();                     // (a new account, or none: the credits are asked for again)
          player.changed();
        },
      })
    : null;
  // the photo and video credits at the top of the main screen, and the dialog that says how they work (and, in the mobile apps, plays an ad for more)
  const credits = api ? new CreditsUi({ identity: player, api, signIn }) : null;
  const panel: OnlinePanel | null =
    api && realtime
      ? new OnlinePanel({
          prefs,
          photos,
          api,
          realtime,
          identity: player,
          chosen: (): PhotoEntry | undefined => library.chosenPhoto,
          openProfile: () => profile?.open(),
          openCredits: (kind) => credits?.show(kind),
          signIn,
          onPlay: (room, invite) => {
            library.hide();
            library.el.hidden = true;
            play.el.hidden = false;
            void play.startOnline(room, invite);
          },
        })
      : null;
  const library: LibraryScreen = new LibraryScreen({
    prefs,
    photos,
    saves,
    onOnline: panel ? () => panel.open() : undefined,
    badge: profile?.badge,
    credits: credits?.el,
    stockBase: base || undefined,
    onPlay: (entry) => {
      library.hide();
      library.el.hidden = true;
      play.el.hidden = false;
      void play.start(entry);
    },
  });
  play.el.hidden = true;
  root.append(library.el, play.el);
  if (panel) root.append(panel.el);
  if (credits) root.append(credits.dialog);
  if (profile) root.append(profile.el);
  if (signInDialog) root.append(signInDialog.el);
  // in an app that signs in through the phone's browser, the player comes back to the app (the sign-in service sent them to the app's own address, with the answer): the shell says so
  window.addEventListener('photopuzzles-signin', () => {
    const back = takeSignIn();
    if (!back || !(accountSource instanceof CognitoAccount)) return;
    void accountSource.completeSignIn(back).then((done) => {
      if (!done.handled) return;                                 // (coming back from signing out, say: nothing to finish)
      signInDialog?.externalDone(done.ok);
      if (done.ok) {
        void player.refreshProfile().then(() => profile?.refreshBadge());
        player.changed();
        profile?.refreshBadge();
      }
    });
  });
  // the badge shows the account's name: ask the server for it once (the name that is kept on this device is used until it answers)
  if (profile && player.kind() === 'account') void player.refreshProfile().then(() => profile.refreshBadge());

  function showLibrary(): void {
    play.el.hidden = true;
    library.el.hidden = false;
    library.show();
  }

  // pictures dropped anywhere on the main screen are added to the list
  window.addEventListener('dragover', (e) => {
    if (library.el.hidden) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (library.el.hidden || !e.dataTransfer) return;
    if (e.dataTransfer.files.length) void library.addFiles([...e.dataTransfer.files]);
    else {
      const link = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) ?? e.dataTransfer.getData('text/plain');        // a picture dragged from another web page
      if (link) void library.addLink(link);
    }
  });
  // a link (or a picture) pasted on the main screen, but not into a box that wants text
  window.addEventListener('paste', (e) => {
    const into = e.target instanceof HTMLElement && (e.target.closest('input, textarea') || e.target.isContentEditable);
    if (!library.el.hidden && !into && e.clipboardData) {
      e.preventDefault();
      library.pasted(e.clipboardData);
    }
  });

  if (import.meta.env.DEV) Object.assign(window, { __play: play, __library: library });        // for poking at the game from the console while developing
  await library.load();
  listenForShared((files) => library.addFiles(files));        // what other apps share with the Android app lands in the library
  // a link to a puzzle (https://.../#/join/12345~secret) joins it
  const link = signedInHash || window.location.hash;
  if (panel && player.kind() === 'account' && parseInvite(link)) await player.refreshProfile();        // to know whether the account has a name before deciding to ask
  if (panel && parseInvite(link)) {
    history.replaceState(null, '', window.location.pathname + window.location.search);        // the secret does not stay in the address bar
    // someone who has not chosen a name is asked before they show up in a puzzle; anyone else (an account, or a guest who has) goes straight in
    if (player.nameChosen()) void panel.join(link);
    else panel.confirmJoin(link);
  } else if (profile && link === DELETE_HASH && !signInFailed) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    void profile.openDeletion();
  } else if (panel && signInFailed) {
    panel.notice('Signing in did not work. Please try again.');
  } else {
    const deleted = takeAccountDeletedNotice();
    if (profile && deleted) profile.notice(deleted);
  }
}

void main();
