package com.tempest.photopuzzles;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;

import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.RequestConfiguration;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
import com.google.android.gms.ads.rewarded.ServerSideVerificationOptions;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

/**
 * Rewarded ads (AdMob), the only place in the app that has an ad in it. The page asks for one with {@code showRewardedAd(kind, nonce)} when a player with no credits left presses the button,
 * and is told how it went with an event; the credits themselves are given by the server when AdMob tells it that the ad was watched (the {@code nonce} goes to AdMob with the ad, as its
 * custom data, and comes back to the server in that report: server-side verification).
 *
 * <p><b>Nothing here talks to Google until the player looks at the credits dialog</b> ({@code prepareAds}) or asks for an ad: playing alone, and everything else in the app, sends nothing
 * anywhere, and the privacy policy says so. Then the app finds out whether Google's consent form (UMP: the law asks for the player's agreement to ads in the EEA and the UK) is
 * due, starts the ad SDK if ads may be asked for, and loads an ad in advance so that the button does not make the player wait. The form itself is shown the first time an ad is wanted.
 */
final class Ads {
    /** Tells the page how an ad went. {@code error}: nothing, or {@code no-ad} (there was none to show) or {@code consent} (the player has not agreed to ads). */
    interface Listener {
        void result(String kind, boolean rewarded, String error);

        /** The consent information is known now (the page may ask whether the player has choices to make). */
        void ready();
    }

    /** How long an ad that has to be loaded first is waited for, in ms. */
    private static final long LOAD_WAIT_MS = 10_000;

    private final Activity activity;
    private final String unitId;
    private final Listener listener;
    private final ConsentInformation consent;
    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean prepared;                // the consent information has been asked for
    private boolean started;                 // the SDK has been started
    private boolean loading;
    private RewardedAd ready;
    /** The ad that the page has asked for and that is waited for (or is being shown): one at a time. */
    private boolean busy;
    private String wantedKind;
    private String wantedNonce;
    private Runnable giveUp;

    /** The devices that are shown test ads even with the real ad unit (BuildConfig.ADMOB_TEST_DEVICES: android/local.properties, not kept in the repository), and the emulator. */
    private static java.util.List<String> testDevices() {
        java.util.List<String> ids = new java.util.ArrayList<>();
        ids.add(AdRequest.DEVICE_ID_EMULATOR);
        for (String id : BuildConfig.ADMOB_TEST_DEVICES.split(",")) {
            if (!id.trim().isEmpty()) ids.add(id.trim());
        }
        return ids;
    }

    Ads(Activity activity, String unitId, Listener listener) {
        this.activity = activity;
        this.unitId = unitId;
        this.listener = listener;
        this.consent = UserMessagingPlatform.getConsentInformation(activity);
    }

    /** The player is looking at the credits: finds out whether the consent form is needed (nothing is shown), and, if ads may be asked for already, gets one ready. Once. */
    void prepare() {
        activity.runOnUiThread(() -> prepareThen(null));
    }

    /** Asks for the consent information if that has not been done, and then goes on (on the main thread). */
    private void prepareThen(Runnable next) {
        if (prepared) {
            listener.ready();
            if (next != null) next.run();
            return;
        }
        prepared = true;
        consent.requestConsentInfoUpdate(activity, new ConsentRequestParameters.Builder().build(), () -> {
            if (consent.canRequestAds()) begin();
            listener.ready();
            if (next != null) next.run();
        }, error -> {
            if (consent.canRequestAds()) begin();            // (an answer from an earlier time may stand)
            listener.ready();
            if (next != null) next.run();
        });
    }

    /** True when the player has to be able to change their mind about ads (the form says so): the page shows a button for it. */
    boolean privacyOptionsRequired() {
        return consent.getPrivacyOptionsRequirementStatus() == ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED;
    }

    /** Shows the form with the player's choices about ads. */
    void showPrivacyOptions() {
        activity.runOnUiThread(() -> UserMessagingPlatform.showPrivacyOptionsForm(activity, error -> {
            if (consent.canRequestAds()) begin();
        }));
    }

    /** The page wants an ad to be shown for these credits: the form first, if it is due; then the ad. */
    void show(String kind, String nonce) {
        activity.runOnUiThread(() -> {
            if (busy) {
                listener.result(kind, false, "no-ad");
                return;
            }
            busy = true;
            wantedKind = kind;
            wantedNonce = nonce;
            prepareThen(() -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity, formError -> {
                if (!consent.canRequestAds()) {
                    finish(false, "consent");
                    return;
                }
                begin();
                if (ready != null) showReady();
                else waitForLoad();
            }));
        });
    }

    /** Ads may be asked for: the SDK is started (once) and an ad is loaded if there is none. */
    private void begin() {
        if (!started) {
            started = true;
            MobileAds.setRequestConfiguration(new RequestConfiguration.Builder()
                // the game's terms keep adult content out of it, and the ads should not bring it in: nothing above "PG" is asked for (the categories blocked in the AdMob console come on top)
                .setMaxAdContentRating(RequestConfiguration.MAX_AD_CONTENT_RATING_PG)
                .setTestDeviceIds(testDevices())
                .build());
            // (the documentation asks for the start to be off the main thread)
            new Thread(() -> MobileAds.initialize(activity, status -> main.post(this::load))).start();
        } else {
            load();
        }
    }

    private void load() {
        if (loading || ready != null) return;
        loading = true;
        RewardedAd.load(activity, unitId, new AdRequest.Builder().build(), new RewardedAdLoadCallback() {
            @Override
            public void onAdLoaded(RewardedAd ad) {
                loading = false;
                ready = ad;
                if (busy && wantedKind != null) {
                    main.removeCallbacks(giveUp);
                    showReady();
                }
            }

            @Override
            public void onAdFailedToLoad(LoadAdError error) {
                loading = false;
                ready = null;
                // (nothing is retried at once: that would be asking again and again when AdMob has nothing to give; the next press tries again)
                if (busy && wantedKind != null) {
                    main.removeCallbacks(giveUp);
                    finish(false, "no-ad");
                }
            }
        });
    }

    private void waitForLoad() {
        giveUp = () -> {
            if (busy && ready == null) finish(false, "no-ad");
        };
        main.postDelayed(giveUp, LOAD_WAIT_MS);
        load();
    }

    private void showReady() {
        final RewardedAd ad = ready;
        final String kind = wantedKind;
        ready = null;
        if (ad == null || kind == null) {
            finish(false, "no-ad");
            return;
        }
        ad.setServerSideVerificationOptions(new ServerSideVerificationOptions.Builder().setCustomData(wantedNonce).build());
        final boolean[] earned = {false};
        ad.setFullScreenContentCallback(new FullScreenContentCallback() {
            @Override
            public void onAdDismissedFullScreenContent() {
                finish(earned[0], null);
                load();                                        // the next one, for the next time
            }

            @Override
            public void onAdFailedToShowFullScreenContent(AdError error) {
                finish(false, "no-ad");
                load();
            }
        });
        ad.show(activity, reward -> earned[0] = true);
    }

    private void finish(boolean rewarded, String error) {
        final String kind = wantedKind;
        busy = false;
        wantedKind = null;
        wantedNonce = null;
        if (kind != null) listener.result(kind, rewarded, error);
    }
}
