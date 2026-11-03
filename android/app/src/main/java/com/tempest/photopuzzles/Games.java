package com.tempest.photopuzzles;

import android.app.Activity;
import android.util.Log;

import com.google.android.gms.games.PlayGames;
import com.google.android.gms.games.PlayGamesSdk;

import java.util.HashMap;
import java.util.Map;

/**
 * Achievements in Google Play Games Services. The page keeps the achievements (src/core/achievements.ts) and tells the app which are unlocked; this only passes them on. The page's ids
 * never change, and each is mapped here to the id that the Play Console gave its achievement (res/values/games-ids.xml, resource names achievement_*). Unlocking is idempotent, so the page
 * tells the app everything that is unlocked each time it starts, and an unlock that could not be sent (no connection, not signed in to Play Games) goes the next time.
 * The dev app is not registered in the Play Console, so it does nothing.
 */
class Games {
    private static final String TAG = "Games";

    /** The page's id -> the name of the Play Console's achievement (the ones that are the same are not listed). */
    private static final Map<String, String> NAMES = new HashMap<>();

    static {
        NAMES.put("first_solve", "first_puzzle");
        NAMES.put("solved_10", "puzzle_adept");
        NAMES.put("solved_50", "puzzle_master");
        NAMES.put("solved_100", "puzzle_legend");
        NAMES.put("solve_video", "first_video");
        NAMES.put("solve_online", "solve_with_friends");
        NAMES.put("use_hint", "use_a_hint");
        NAMES.put("use_bomb", "use_a_bomb");
        NAMES.put("hints_50", "light_up_the_sky");
        NAMES.put("bombs_10", "carpet_bomber");
        NAMES.put("first_focus", "first_tile_swap");
        NAMES.put("first_sliding", "first_slide");
        NAMES.put("large_focus", "large_tile_swap");
        NAMES.put("large_sliding", "large_slide");
    }

    private final Activity activity;
    private final boolean enabled;

    Games(Activity activity, boolean enabled) {
        this.activity = activity;
        this.enabled = enabled;
        if (enabled) {
            try {
                // signs the player in to Play Games by itself (the first time, Google asks); nothing here needs the player to
                PlayGamesSdk.initialize(activity.getApplicationContext());
            } catch (RuntimeException e) {
                Log.w(TAG, "Play Games could not start", e);
            }
        }
    }

    /** Unlocks the achievements with these page ids (ones this app does not know are left). */
    void unlock(Iterable<String> ids) {
        if (!enabled) return;
        for (String id : ids) {
            String name = NAMES.containsKey(id) ? NAMES.get(id) : id;
            int res = activity.getResources().getIdentifier("achievement_" + name, "string", activity.getPackageName());
            if (res == 0) continue;
            try {
                PlayGames.getAchievementsClient(activity).unlock(activity.getString(res));
            } catch (RuntimeException e) {
                Log.w(TAG, "could not unlock " + id, e);
            }
        }
    }
}
