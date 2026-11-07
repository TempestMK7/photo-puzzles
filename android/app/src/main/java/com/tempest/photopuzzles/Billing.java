package com.tempest.photopuzzles;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The subscription (Google Play Billing), the only place in the app that sells anything. The page asks with {@code queryProduct}, {@code buySubscription} and {@code restorePurchases} and is told what
 * happened with the window event {@code photopuzzles-billing}; <b>the app never decides that the player has paid</b>: it only hands the purchase token to the page, which gives it to the server, which
 * asks Google and makes the account paid (and acknowledges the purchase). Nothing here talks to Google Play until the page asks, and the page asks only for a signed-in account of a server that
 * sells the subscription.
 */
final class Billing {
    /** Tells the page something: {@code kind} is {@code product} (the price), {@code purchase} (a token to give to the server) or {@code error}. */
    interface Listener {
        void event(JSONObject detail);
    }

    private final Activity activity;
    private final Listener listener;
    private BillingClient client;
    /** What is waiting for the connection to Google Play. */
    private final List<Runnable> waiting = new ArrayList<>();
    private boolean connecting;

    Billing(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
    }

    /** Runs {@code then} (on the main thread) when there is a connection to Google Play; tells the page {@code unavailable} when there cannot be one (the app was not installed from Google Play, say). */
    private void connected(Runnable then) {
        if (client == null) {
            client = BillingClient.newBuilder(activity)
                .setListener((result, purchases) -> updated(result, purchases))
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                .enableAutoServiceReconnection()
                .build();
        }
        if (client.isReady()) {
            then.run();
            return;
        }
        waiting.add(then);
        if (connecting) return;
        connecting = true;
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                connecting = false;
                List<Runnable> go = new ArrayList<>(waiting);
                waiting.clear();
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    for (Runnable r : go) r.run();
                } else {
                    for (int i = 0; i < go.size(); i++) tell("error", "unavailable", null);
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                connecting = false;                    // (the next ask connects again)
            }
        });
    }

    private void tell(String kind, String error, JSONObject more) {
        try {
            JSONObject detail = more == null ? new JSONObject() : more;
            detail.put("kind", kind);
            if (error != null) detail.put("error", error);
            listener.event(detail);
        } catch (JSONException e) {
            /* (strings only: this cannot happen) */
        }
    }

    /** Asks Google Play for the subscription's price (the page shows it on the button): {@code kind: 'product', productId, price}. */
    void queryProduct(String productId) {
        activity.runOnUiThread(() -> connected(() -> details(productId, d -> {
            try {
                tell("product", null, new JSONObject().put("productId", productId).put("price", priceOf(d)));
            } catch (JSONException e) {
                /* (strings only) */
            }
        })));
    }

    private interface WithDetails {
        void got(ProductDetails details);
    }

    private void details(String productId, WithDetails then) {
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
            .setProductList(Collections.singletonList(QueryProductDetailsParams.Product.newBuilder().setProductId(productId).setProductType(BillingClient.ProductType.SUBS).build()))
            .build();
        client.queryProductDetailsAsync(params, (result, found) -> {
            List<ProductDetails> list = found.getProductDetailsList();
            if (result.getResponseCode() == BillingClient.BillingResponseCode.OK && !list.isEmpty() && list.get(0).getSubscriptionOfferDetails() != null && !list.get(0).getSubscriptionOfferDetails().isEmpty()) {
                then.got(list.get(0));
            } else {
                tell("error", "unavailable", null);
            }
        });
    }

    /** The price that is charged each period (the last phase of the offer: a free trial, if there is one, comes first): Google's own text, in the player's currency. */
    private static String priceOf(ProductDetails d) {
        List<ProductDetails.PricingPhase> phases = d.getSubscriptionOfferDetails().get(0).getPricingPhases().getPricingPhaseList();
        return phases.get(phases.size() - 1).getFormattedPrice();
    }

    /**
     * Opens Google Play's purchase sheet. {@code accountId} (the game account's id) goes to Google only as a hash, as the purchase's obfuscated account id (Google asks for one so that it can tell
     * accounts apart when it looks for fraud); the page is told how it went with a {@code purchase} event (or {@code error}: {@code canceled}, {@code unavailable} or {@code error}).
     */
    void buy(String productId, String accountId) {
        activity.runOnUiThread(() -> connected(() -> details(productId, d -> {
            BillingFlowParams.ProductDetailsParams one = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d).setOfferToken(d.getSubscriptionOfferDetails().get(0).getOfferToken()).build();
            BillingFlowParams flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(Collections.singletonList(one)).setObfuscatedAccountId(hash(accountId)).build();
            BillingResult started = client.launchBillingFlow(activity, flow);
            if (started.getResponseCode() != BillingClient.BillingResponseCode.OK) tell("error", "error", null);
        })));
    }

    /** The purchases that Google Play still has for the player (after a new phone or a reinstall, or one that was pending): each is told to the page as a {@code purchase}, which the server checks. */
    void restore() {
        activity.runOnUiThread(() -> connected(() -> client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(), (result, purchases) -> {
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) return;
            for (Purchase p : purchases) purchase(p);
        })));
    }

    /** Google Play says that a purchase has happened (or is pending, or the player gave up). */
    private void updated(BillingResult result, List<Purchase> purchases) {
        int code = result.getResponseCode();
        if (code == BillingClient.BillingResponseCode.OK && purchases != null) {
            for (Purchase p : purchases) purchase(p);
        } else if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            tell("error", "canceled", null);
        } else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            restore();                                 // (it is the player's already: the server is given it)
        } else {
            tell("error", "error", null);
        }
    }

    private void purchase(Purchase p) {
        boolean pending = p.getPurchaseState() == Purchase.PurchaseState.PENDING;
        if (p.getPurchaseState() == Purchase.PurchaseState.UNSPECIFIED_STATE) return;
        try {
            tell("purchase", null, new JSONObject().put("token", p.getPurchaseToken()).put("pending", pending));
        } catch (JSONException e) {
            /* (a string and a boolean) */
        }
    }

    /** Google Play's page for managing (and cancelling) the subscription. */
    void manage(String productId) {
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/account/subscriptions?sku=" + Uri.encode(productId) + "&package=" + activity.getPackageName())));
            } catch (Exception e) {
                /* no browser or Play Store to open it: nothing happens */
            }
        });
    }

    /** SHA-256 of the account's id as 64 hex digits (the most that Google takes, and nothing that says who the player is). */
    private static String hash(String id) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte b : d) out.append(String.format("%02x", b));
            return out.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);        // (every Android has SHA-256)
        }
    }
}
