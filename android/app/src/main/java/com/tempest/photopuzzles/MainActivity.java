package com.tempest.photopuzzles;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import android.database.Cursor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The whole app: one WebView showing the web build that is packed in assets/www. The pages are served to the WebView from there under a made-up https address (so
 * IndexedDB, WebGL and video behave as on a normal site). The game itself needs no network (playing alone, the library, the pictures all stay on the device); the page uses it
 * only to play with friends, for the stock library and for a picture or video from a link, and only over https. The system file picker is hooked up so photos and videos can be
 * added, and rewarded ads (AdMob) are shown for credits when the player asks (see Ads).
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int PICK = 1;
    private static final int BACKGROUND = 0xFF1B1210;

    /** The most pictures and videos taken from one share: the system lets an app send a great many. */
    private static final int SHARED_MAX = 50;

    private WebView web;
    private Ads ads;
    private ValueCallback<Uri[]> chooser;

    /** What other apps shared with this one: the files by number (the page reads them from /shared/<number>/<name>), and the list the page has not taken yet. */
    private final Object sharedLock = new Object();
    private final Map<Integer, Uri> sharedUris = new HashMap<>();
    private final Map<Integer, String> sharedTypes = new HashMap<>();
    private final List<JSONObject> sharedPending = new ArrayList<>();
    private int sharedCount = 0;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        // keep clear of the status and navigation bars
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });

        // a debuggable (private test) build can be inspected from a computer over adb
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                          // localStorage and IndexedDB: photos, settings, best times, saved puzzles
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);                         // the picker hands out content:// files
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);

        web.setWebViewClient(new WebViewClient() {
            /** A link to another site (the credit under a stock picture, the terms of an ad) opens in the browser: the page of another site must not run in this WebView, which has the app's bridge. */
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                if ("https".equals(u.getScheme())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (Exception e) {
                        /* no browser to open it: nothing happens */
                    }
                }
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!HOST.equals(u.getHost())) {
                    // the page may fetch over https (the game's server, the pictures of a puzzle, the stock sites, a link the player pasted) and show blob:/data: pictures; anything else is refused
                    String scheme = u.getScheme();
                    if ("https".equals(scheme) || "blob".equals(scheme) || "data".equals(scheme)) return null;
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new HashMap<String, String>(), null);
                }
                String path = u.getPath();
                if (path != null && path.startsWith("/shared/")) return sharedFile(path);
                if (path == null || path.equals("/")) path = "/index.html";
                try {
                    InputStream in = getAssets().open("www" + path);
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-cache");
                    WebResourceResponse r = new WebResourceResponse(mime(path), "utf-8", in);
                    r.setResponseHeaders(headers);
                    return r;
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", new HashMap<String, String>(), null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = callback;
                try {
                    startActivityForResult(pickerIntent(params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE), PICK);
                } catch (Exception e) {
                    chooser = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
        ads = new Ads(this, BuildConfig.ADMOB_REWARDED_UNIT, new Ads.Listener() {
            @Override
            public void result(String kind, boolean rewarded, String error) {
                try {
                    JSONObject detail = new JSONObject().put("kind", kind).put("rewarded", rewarded);
                    if (error != null) detail.put("error", error);
                    web.evaluateJavascript("window.dispatchEvent(new CustomEvent('photopuzzles-ad',{detail:" + detail + "}))", null);
                } catch (org.json.JSONException e) {
                    /* (strings and a boolean: this cannot happen) */
                }
            }

            @Override
            public void ready() {
                web.evaluateJavascript("window.dispatchEvent(new Event('photopuzzles-ads-ready'))", null);
            }
        });
        web.addJavascriptInterface(new Bridge(), "PhotoPuzzlesNative");
        // started from "Share > PuzzleVidio": the page takes what was shared when it has started (not again when the system makes this activity anew)
        if (state == null) collectShared(getIntent());
        web.loadUrl("https://" + HOST + "/index.html");
    }

    /** Shared again while the app is open (it is a single-task app): the page is told, and takes what is new. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (collectShared(intent)) web.evaluateJavascript("window.dispatchEvent(new Event('photopuzzles-shared'))", null);
    }

    /** Notes the pictures and videos that another app sent with Share (one, or several). True if there were any. */
    @SuppressWarnings("deprecation")
    private boolean collectShared(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        List<Uri> uris = new ArrayList<>();
        android.content.ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        if (uris.isEmpty()) {
            if (Intent.ACTION_SEND.equals(action)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (many != null) uris.addAll(many);
            }
        }
        boolean any = false;
        for (Uri u : uris) {
            if (u == null || !"content".equals(u.getScheme())) continue;       // a content:// address that the sender gave this app permission to read, nothing else
            String type = getContentResolver().getType(u);
            if (type == null) type = intent.getType();
            if (type == null || !(type.startsWith("image/") || type.startsWith("video/"))) continue;
            String name = displayName(u);
            if (name == null || name.isEmpty()) {
                String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
                name = "Shared" + (ext == null ? "" : "." + ext);
            }
            try {
                synchronized (sharedLock) {
                    if (sharedPending.size() >= SHARED_MAX) break;
                    int id = ++sharedCount;
                    sharedUris.put(id, u);
                    sharedTypes.put(id, type);
                    JSONObject item = new JSONObject();
                    item.put("url", "/shared/" + id + "/" + Uri.encode(name));
                    item.put("name", name);
                    item.put("type", type);
                    sharedPending.add(item);
                    any = true;
                }
            } catch (org.json.JSONException e) {
                /* a name that cannot be written down: leave it out */
            }
        }
        return any;
    }

    private String displayName(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception e) {
            /* the sender's provider does not say: the page is given a name of its own */
        }
        return null;
    }

    /** One shared file, for the page's request to /shared/<number>/<name>: read from the sender's content address, only for a number that was handed out. */
    private WebResourceResponse sharedFile(String path) {
        String[] parts = path.split("/");                    // "", "shared", number, name
        Uri uri = null;
        String type = null;
        try {
            int id = Integer.parseInt(parts[2]);
            synchronized (sharedLock) {
                uri = sharedUris.get(id);
                type = sharedTypes.get(id);
            }
        } catch (RuntimeException e) {
            /* not a number: not found */
        }
        if (uri != null && type != null) {
            try {
                InputStream in = getContentResolver().openInputStream(uri);
                if (in != null) {
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-store");
                    WebResourceResponse r = new WebResourceResponse(type, null, in);
                    r.setResponseHeaders(headers);
                    return r;
                }
            } catch (Exception e) {
                /* the sender took it back: not found */
            }
        }
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", new HashMap<String, String>(), null);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK && chooser != null) {
            chooser.onReceiveValue(chosen(result, data));
            chooser = null;
        }
        super.onActivityResult(request, result, data);
    }

    /**
     * The system's document browser, not the Photo Picker that createIntent() would lead to on Android 13 and later: the Photo Picker hides the real file names (every
     * file it hands over is called something like 1000000027.jpg), the document browser gives the names the files have.
     */
    private static Intent pickerIntent(boolean multiple) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/*", "video/*"});
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        return i;
    }

    /**
     * The files the picker returned. WebChromeClient.FileChooserParams.parseResult is not used: with the system Photo Picker (Android 13 and later) it comes back null for a
     * result that holds several files, so nothing would reach the page.
     */
    private static Uri[] chosen(int result, Intent data) {
        if (result != RESULT_OK || data == null) return null;
        java.util.ArrayList<Uri> out = new java.util.ArrayList<>();
        android.content.ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) out.add(u);
            }
        }
        if (out.isEmpty() && data.getData() != null) out.add(data.getData());
        return out.isEmpty() ? null : out.toArray(new Uri[0]);
    }

    /**
     * What the page can ask of the app (as window.PhotoPuzzlesNative): the pictures that other apps shared, touch feedback, and ads.
     *
     * <p>Touch feedback: a web page can only ask a web view to "vibrate for 12 ms", and a pulse that short is too weak for many phones' motors to show;
     * the system's own haptic effects (the ones behind a long press or a confirmation, which respect the "touch feedback" setting) are tuned for the device and always felt.
     */
    private class Bridge {
        private final Handler later = new Handler(Looper.getMainLooper());

        /** Where the game is running (the page shows ads only in the Android and iOS apps). */
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        /** The player is looking at the credits: the app finds out about the consent for ads (nothing is shown) and gets an ad ready; the page is told with the window event photopuzzles-ads-ready. Nothing talks to Google before this. */
        @JavascriptInterface
        public void prepareAds() {
            ads.prepare();
        }

        /** Starts a rewarded ad for `kind` credits ('photo' or 'video'); the page is told how it went with the window event photopuzzles-ad. `nonce` goes to AdMob with the ad (see Ads). */
        @JavascriptInterface
        public void showRewardedAd(String kind, String nonce) {
            boolean valid = ("photo".equals(kind) || "video".equals(kind)) && nonce != null && nonce.matches("[A-Za-z0-9_-]{1,100}");
            if (valid) ads.show(kind, nonce);
        }

        /** The player has to be able to change their choices about ads (the consent form says so): the page shows a button, which calls showPrivacyOptions. */
        @JavascriptInterface
        public boolean privacyOptionsRequired() {
            return ads.privacyOptionsRequired();
        }

        @JavascriptInterface
        public void showPrivacyOptions() {
            ads.showPrivacyOptions();
        }

        /** The pictures and videos that other apps shared and the page has not taken: a JSON list of {url, name, type}. Taking empties it. */
        @JavascriptInterface
        public String takeShared() {
            synchronized (sharedLock) {
                String out = new JSONArray(sharedPending).toString();
                sharedPending.clear();
                return out;
            }
        }

        @JavascriptInterface
        public void haptic(final String kind) {
            later.post(new Runnable() {
                @Override
                public void run() {
                    play(kind);
                }
            });
        }

        private void effect(int constant, long afterMs) {
            final int c = constant;
            later.postDelayed(new Runnable() {
                @Override
                public void run() {
                    web.performHapticFeedback(c);
                }
            }, afterMs);
        }

        private void play(String kind) {
            boolean newer = Build.VERSION.SDK_INT >= 30;
            int confirm = newer ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
            switch (kind) {
                case "grab":                                   // a firm click, the same one as a long press
                    effect(HapticFeedbackConstants.LONG_PRESS, 0);
                    break;
                case "drop":                                   // a lighter click
                    effect(HapticFeedbackConstants.VIRTUAL_KEY, 0);
                    break;
                case "join":
                    effect(confirm, 0);
                    break;
                case "placed":                                 // firm, then a click: it has gone home
                    effect(HapticFeedbackConstants.LONG_PRESS, 0);
                    effect(confirm, 110);
                    break;
                case "turn":
                    effect(HapticFeedbackConstants.CLOCK_TICK, 0);
                    break;
                case "move":                                   // a piece slides (Sliding Tiles, Rotascope)
                    effect(HapticFeedbackConstants.VIRTUAL_KEY, 0);
                    break;
                case "solved":
                    effect(HapticFeedbackConstants.LONG_PRESS, 0);
                    effect(HapticFeedbackConstants.LONG_PRESS, 160);
                    effect(confirm, 320);
                    effect(HapticFeedbackConstants.LONG_PRESS, 480);
                    break;
                default:
                    break;
            }
        }
    }

    /** Back leaves a puzzle (like Escape); on the main screen it closes the app. */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
            "(function(){var p=document.querySelector('.play');if(p&&!p.hidden){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return 'play';}return 'home';})()",
            value -> {
                if (value == null || value.contains("home")) finish();
            });
    }

    @Override
    protected void onPause() {
        web.onPause();                                         // the page sees "hidden" and keeps the puzzle it is playing
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".map")) return "application/json";
        return "application/octet-stream";
    }
}
