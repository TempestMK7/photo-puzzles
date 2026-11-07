# The Android app

A thin shell around the game: one `WebView` that shows the web build packed in `app/src/main/assets/www` (served to it under `https://appassets.androidplatform.net`, so IndexedDB, WebGL and video behave as on a normal site). Playing alone needs no network at all. The page uses the network (over https only) to play with friends, for the stock library and for a picture from a link; the app adds file picking, "Share > PuzzleVidio", touch feedback, and **rewarded ads** (AdMob).

| file | what it does |
|---|---|
| `app/src/main/java/com/tempest/photopuzzles/MainActivity.java` | the WebView, the file picker, what other apps share, haptics, and `window.PhotoPuzzlesNative` (what the page can ask of the app) |
| `app/src/main/java/com/tempest/photopuzzles/Ads.java` | AdMob rewarded ads and Google's consent form (UMP) |
| `app/src/main/java/com/tempest/photopuzzles/Billing.java` | the subscription (Google Play Billing): the price, the purchase sheet, the purchases that Play still has, Play's page for managing it. It only hands purchase tokens to the page: the server decides who has paid |
| `app/src/main/java/com/tempest/photopuzzles/Games.java` | Google Play Games achievements: maps our achievement ids to the Console's (`res/values/games-ids.xml`, which holds Google's ids; they are not secret) |
| `app/build.gradle` | the ids of AdMob, release signing, the guard against a release with test ads |

`app/src/main/assets/www` is **not kept in the repository** (it is the web build, copied in).

## Building

1. The web build goes into the app (this runs `vite build` into `app/src/main/assets/www`):
   ```
   node scripts/android-web.mjs dev        # the app talks to the dev stage's server
   node scripts/android-web.mjs prod       # ... to the real one
   node scripts/android-web.mjs offline    # no online play
   ```
   `dev` and `prod` read where the stage's server, broker and sign-in are from its CloudFormation stacks, as the Deploy workflow does: the AWS CLI with credentials that may describe them (`AWS_PROFILE`; on a machine whose HTTPS is intercepted also `AWS_CA_BUNDLE`).
2. The app (JDK 17 or later, the Android SDK with platform 35 and build-tools 35; `sdk.dir` is in `android/local.properties`, which Android Studio writes and is not kept):
   ```
   cd android
   ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
   ./gradlew assembleRelease      # app/build/outputs/apk/release/app-release.apk (bundleRelease: the .aab for the Play Console)
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
   On a machine whose HTTPS is intercepted by a root certificate that only the operating system knows (so that Gradle cannot download), run Gradle with `JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT` (Windows) in its environment, or put the same flag in `org.gradle.jvmargs` in `~/.gradle/gradle.properties`. It is not in the project's `gradle.properties` because the JVM refuses it on other systems.

**Dev and real app side by side.** The app is built for the stage whose web build is in it (`web-stage.txt`, see *Ads*): a **dev** build is **`com.tempest.photopuzzles.dev`**, named **Dev PuzzleVidio**, and any other build is **`com.tempest.photopuzzles`**, **PuzzleVidio**. Different package ids are different apps, so both can be installed at once, each with its own storage (library, saved puzzles, sign-in), and a release build never replaces a dev one. The sign-in return address follows the package id (`<package id>://signed-in`: the page asks the shell for it with `PhotoPuzzlesNative.signInRedirect()`), so the two do not both answer to one address; the dev stage's user pool lists the dev app's (`DEV_APP_SIGN_IN_REDIRECTS` in `infra/lib/config.ts`) and the prod stage's the real one's. (A debug build is signed with `android/dev.keystore` and a release with the upload key, so those two could never be installed over each other anyway.)

## Building in GitHub Actions

**Actions > Android > Run workflow** (from `main`; `.github/workflows/android.yml`) builds the apps and leaves them as artifacts of the run (kept 14 days): `dev-app` (the debug APK of Dev PuzzleVidio) and `prod-app` (the signed `.aab` for the Play Console, and a signed `.apk`). Choose `both`, `dev` or `prod`. Nothing is published: install the APK, or upload the bundle in the Play Console by hand. From a terminal:

```
gh workflow run android.yml --ref main -f build=both
gh run watch            # then:  gh run download <run id>
```

It signs in to AWS with the Deploy workflow's role (`AWS_DEPLOY_ROLE_ARN`) to read where each stage's server is. Set these once (none of the variables is secret, but they are kept out of the repository, as on a developer's machine):

```
gh variable set ADMOB_APP_ID --body 'ca-app-pub-XXXXXXXXXXXXXXXX~NNNNNNNNNN'
gh variable set ADMOB_UNIT_DEV --body 'ca-app-pub-XXXXXXXXXXXXXXXX/NNNNNNNNNN'
gh variable set ADMOB_UNIT_PROD --body 'ca-app-pub-XXXXXXXXXXXXXXXX/NNNNNNNNNN'
gh variable set ADMOB_TEST_DEVICES --body '<id>,<id>'     # optional: your phones, which are shown test ads
gh secret set PLAY_SERVICE_ACCOUNT_JSON < path/to/service-account.json   # only to upload to the Play Console (see Uploading to the Play Console)
base64 -w0 path/to/upload.jks | gh secret set ANDROID_KEYSTORE_B64        # prod only: the upload key,
gh secret set ANDROID_KEYSTORE_PASSWORD                                    # its passwords (each asks for the value)
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD
gh variable set ANDROID_REGISTRATION < adi-registration.properties         # prod, optional: what the Play Console gave to prove the package name (it is put in the app's assets)
```

The Google sign-in button and the legal pages use the Deploy workflow's variables (`GOOGLE_CLIENT_ID`, `GOOGLE_SECRET_NAME`, `LEGAL_*`). The upload key is written to the runner for the run and deleted after it. The **version code** of every build is the run number plus 10 (the workflow passes `-PversionCode` and `-PversionName`), so each upload to the Play Console is higher than the one before; a build on your own machine is version 1 unless you pass them yourself.

## The subscription

The app sells one subscription with Google Play Billing (`Billing.java`; the page's side is `src/online/play.ts` and the profile dialog). The page asks the shell for the price (`queryProduct`), opens the purchase sheet (`buySubscription`: only a SHA-256 of the account id goes to Google, as the obfuscated account id), asks for the purchases that Play still has (`restorePurchases`, which the page does once for a signed-in account that is not paid up) and opens Play's page for it (`manageSubscription`); the shell tells the page with the window event `photopuzzles-billing`. **The app never decides who has paid:** each purchase token goes to the server (`POST /me/play/verify`), which asks Google, acknowledges the purchase and makes the account paid (`docs/online-protocol.md`, *Google Play subscription*). Nothing talks to Google Play until the page asks, which it does only for a signed-in account on a server that sells the subscription (`AccountSummary.play`).

- **Where it can be bought:** only from a build that Google Play installed (an internal, closed or open testing release, or production) and whose package id has the subscription in the Play Console: the **dev app** (`com.tempest.photopuzzles.dev`) is not in the Console, so its Subscribe button says that Google Play could not be reached. Test on an internal testing release of the real package, signed in as a licence tester (Play Console > Settings > License testing): a test purchase costs nothing and renews every few minutes. Setting the Console, Google Cloud and the server's secret up is `docs/runbook.md` > Google Play.
- The Billing Library is `com.android.billingclient:billing` (version in `app/build.gradle`); it adds the `com.android.vending.BILLING` permission by itself.
- Patreon is not offered in the app (a store wants its own way to pay): only an account that already has it joined sees it.

## Ads

- **Where they are:** only here. Steam, itch and the web page have no ad code. The page shows the "watch an ad" button only where `PhotoPuzzlesNative.showRewardedAd` exists, and (by the server's rules) only to an account that has no credits left (a free account's photo credits, a paid account's video credits), a few times a day; or, in a puzzle, for hints or a bomb (`kind` `'hint'` or `'bomb'`: 5 hints or 1 bomb, one ad every 20 to 30 minutes, the first 15 minutes after the account was made, whether or not the account has any left). The shell does not care which: it passes `kind` through.
- **How an ad goes:** the page asks the server first (`POST /credits/ad/start`), which says whether the account is owed credits and gives a one-time number. The page calls `showRewardedAd(kind, nonce)`; `Ads.java` shows the ad with the number as its custom data (**server-side verification**); AdMob then tells the server (`GET /credits/ad/callback`, signed) that the ad was watched, and the server gives the credits. The app only tells the page how the ad went (the window event `photopuzzles-ad`: `{ kind, rewarded, error }`). Nothing the page says can give credits.
- **The ids.** Until there are real ones the app uses **Google's test ids** (test ads, which earn nothing). Put the real ones in `android/local.properties` (not kept in the repository) or on the command line:
  ```
  admob.appId=ca-app-pub-XXXXXXXXXXXXXXXX~NNNNNNNNNN
  admob.rewardedUnit.dev=ca-app-pub-XXXXXXXXXXXXXXXX/NNNNNNNNNN
  admob.rewardedUnit.prod=ca-app-pub-XXXXXXXXXXXXXXXX/NNNNNNNNNN
  ```
  (`-PadmobAppId=...` and `-PadmobRewardedUnit=...` do the same.) **The ad unit follows the stage of the web build in the app:** `node scripts/android-web.mjs dev|prod` leaves the stage in `android/web-stage.txt` (not kept) and Gradle takes `admob.rewardedUnit.<stage>`, so the dev app shows the dev unit (whose callback is the dev server's) and the prod app the prod one with no change by hand. `admob.rewardedUnit` alone serves every stage (and the `offline` build, which has no server to pay anyone); with no web build yet the stage is `dev`; `-PwebStage=prod` says it on the command line. **Your own phone must be a test device**, or a debug build shows (and a tap on it counts as a click on) real ads, which AdMob can treat as invalid traffic: `admob.testDevices=<id>[,<id>]` in the same file (`-PadmobTestDevices=`). An emulator is one already. The id is what the ad SDK prints in the log the first time an ad is requested (`adb logcat -s Ads`: "Use RequestConfiguration.Builder().setTestDeviceIds(Arrays.asList(\"...\"))"); it is the MD5 of the phone's Android ID (`adb shell settings get secure android_id`), in capitals. The list goes into every build made on that machine, a release too (it only changes what those phones are shown). **A release build refuses to be made with the test ids** (`-PallowTestAds` for a private build that is only to be looked at). The ad unit must also be named in the server's deployment (`ADMOB_AD_UNITS`, `docs/runbook.md`), or the server will not believe AdMob's report.
- **Consent.** In the EEA and the UK the law asks for the player's agreement to ads. Google's consent form (UMP) is shown **the first time an ad is wanted**, not at launch; the app only learns at launch whether it is due. It needs a consent message made in the AdMob console (Privacy & messaging) for the app: without one, no ads are served in those regions. When the form says players must be able to change their mind, the credits dialog shows an "Ad privacy choices" button.
- **Ad content.** The app asks for nothing above "PG" (`Ads.java`); block the categories that do not fit the game in the AdMob console too.
- **Play Console:** "contains ads" in the app content, the advertising ID and ads in the Data safety form, and the privacy policy (`src/legal/content.ts` says what the game keeps and what the ad network gets; check it against what AdMob's own page says). The SDK adds some permissions of its own (the ads' own `ACCESS_ADSERVICES_*`, `FOREGROUND_SERVICE`); the Console may ask about them.

## Release signing

**The dev key:** every debug build (the dev app, on any machine and in the workflow) is signed with `android/dev.keystore`, which is kept in the repository on purpose (alias `dev`, password `android`; it signs nothing but the dev app): a phone only installs an update signed with the key of the version it has, so one key everywhere lets each new dev build go over the last. A phone that has a dev build signed with some other key (an older one, made with a machine's own debug key) has to remove it once.

Without a key of its own the release build is signed with the dev key (private builds, which then install on any device). For the store make a keystore **outside the repository** and describe it in `android/keystore.properties` (not kept): `storeFile`, `storePassword`, `keyAlias`, `keyPassword`. The build uses it when that file is there.

## Signing in

E-mail and password work inside the app. **Google does not let its sign-in page open in an app's web view**, so "Sign in with Google" goes through the phone's browser instead:
1. the page asks the app to open the sign-in service's address (`PhotoPuzzlesNative.openSignIn(url)`): a **Chrome Custom Tab** (only `https://*.amazoncognito.com` addresses are opened);
2. the player chooses their Google account there; Google sends them to the sign-in service, which sends them back to **`com.tempest.photopuzzles://signed-in?code=...&state=...`** (the dev app: `com.tempest.photopuzzles.dev://`): the app's own made-up address (an intent filter in the manifest, and one of the addresses the user pool's app client lists, `infra/lib/auth-stack.ts`);
3. the app keeps that address until the page takes it (`takeSignIn()`; the window event `photopuzzles-signin` says there is one, and a page that starts afterwards, because the system closed the app meanwhile, asks at start), and the page finishes the sign-in with the same code exchange as in a browser (`CognitoAccount.completeSignIn`). What the exchange needs (a random secret and a state, PKCE) is kept on the device while the player is away: an address sent to the app by another app is useless without it.
Signing out of a Google account also ends the browser's session through the same trip (the app's page is not taken away). The build has the Google button when the stage has Google (`scripts/android-web.mjs` reads the repository's variables, as the Deploy workflow does).

## What the page may reach

`MainActivity` refuses every request that is not to the app's own address, https, or a `blob:`/`data:` picture, and opens a link to another site in the browser instead of in the WebView (which has the app's bridge, and must only ever show the game's own page). The server lets the app's pages call it (`https://appassets.androidplatform.net` is one of the origins in `infra/lib/config.ts`: the API and the picture storage; it is not a return address for the sign-in page, and Google sign-in does not work inside an app's web view, so the app has e-mail and password only).

## Achievements (Google Play Games)

The page keeps the achievements and calls `PhotoPuzzlesNative.unlockAchievements(idsJson)` (a JSON array of our ids) with everything unlocked when it starts and with each new unlock; `Games.java` passes them to Play Games (the v2 SDK signs the player in by itself; unlocking twice is harmless, so one that could not be sent goes the next time). The dev app (`GAMES_ENABLED` false) does nothing, because its package id is not registered. A new achievement: add it to `src/core/achievements.ts`, create it in the Play Console, add its `achievement_*` string to `games-ids.xml` and, if the name differs from our id, a line to `NAMES` in `Games.java` (`tests/playGames.test.ts` checks that every achievement has one). In the Play Console the app needs a credential per signing certificate (upload key and Play app signing key) and, until published, testers.

## Uploading to the Play Console

Creating a release tag (`v1.2.0`, on a commit of main) starts it by itself (the **Release** workflow; `docs/runbook.md`, *Releasing*): the signed bundle built from the tag goes to the testing track named by the repository variable `PLAY_TRACK` (`alpha`, the first closed testing track, when it is not set; `gh variable set PLAY_TRACK --body <track>` for another one), where Play reviews it. By hand: Actions > Android > Run workflow with the tag and **Upload** ticked (prod). Production is promoted by hand in the Play Console, so a run can never reach real users. It needs once:

1. Google Cloud (the project that has the Google Play Android Developer API enabled): IAM & Admin > Service Accounts > create one (no project roles needed) > Keys > Add key > JSON.
2. Play Console > Users and permissions > Invite new users: the service account's e-mail, with access to this app only and the permissions to release to testing tracks (and to view app information).
3. `gh secret set PLAY_SERVICE_ACCOUNT_JSON < the-key.json`, then delete the downloaded key file. The key is a password: it is never committed.

The workflow's action (`r0adkll/upload-google-play`) is pinned to a commit. A new permission in the Play Console can take some minutes to reach the API; a "caller does not have permission" error in the first run is usually that.
