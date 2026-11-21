package app.yeghadam;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.animation.DecelerateInterpolator;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Hosts the Snapp and Tapsi passenger web apps (app.snapp.taxi, app.tapsi.cab), one WebView each behind a
 * two-tab switch, and injects the Yeghadam script. The last used service opens first; the other WebView is
 * only created when the rider switches to it. Everything runs on the device with the rider's own session. The script only
 * requests price quotes; it never creates a ride.
 */
public class MainActivity extends Activity {

    private static final String SERVICE_SNAPP = "snapp";
    private static final String SERVICE_TAPSI = "tapsi";
    private static final String HOME_SNAPP = "https://app.snapp.taxi/";
    private static final String HOME_TAPSI = "https://app.tapsi.cab/";
    private static final int REQ_LOCATION = 41;
    private static final int NOTICE_VERSION = 1; // keep equal to NOTICE_V in src/ui.js
    private static final int NAVY = 0xFF15192E;
    private static final int LIME = 0xFFC5F04A;
    // The splash stays at least this long, so it never flickers, and at most this long, if the page hangs.
    private static final long SPLASH_MIN_MS = 900;
    private static final long SPLASH_MAX_MS = 10000;

    // One WebView per service behind a two-tab switch. A service's WebView is created the first time it is shown.
    private final WebView[] webs = new WebView[2];
    private final TextView[] tabs = new TextView[2];
    private FrameLayout root;
    private FrameLayout host;
    private View switchBox; // the tab bar and its hairline, hidden while the first-run intro is open
    private Bundle savedState;
    private String pendingRoute; // sanitized route JSON waiting for Snapp's start page to load
    private WebView web; // the visible one
    private String script;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private View splash;
    private View splashFill;
    private long splashShownAt;
    private volatile boolean introOpen;
    // Which service the rider picked (null until the first choice), and the picker while it is on screen.
    private String service;
    private WebView startView; // the first-run page while it is on screen

    private static int indexOf(String id) {
        return SERVICE_TAPSI.equals(id) ? 1 : 0;
    }

    private static String homeUrl(int index) {
        return index == 1 ? HOME_TAPSI : HOME_SNAPP;
    }

    /** Whether url is an https address on the same host as home. */
    private static boolean onHost(String url, String home) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        return "https".equals(u.getScheme()) && Uri.parse(home).getHost().equals(u.getHost());
    }

    private static boolean isServiceOrigin(String url) {
        return onHost(url, HOME_SNAPP) || onHost(url, HOME_TAPSI);
    }

    /**
     * Whether a service's WebView is on that service's own site. A link can take the WebView to another site, which then
     * sees the same bridge, so the calls that reach the other service check this first. Call on the UI thread.
     */
    private boolean onServicePage(int index) {
        WebView w = webs[index];
        return w != null && onHost(w.getUrl(), homeUrl(index));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        service = getSharedPreferences("yeghadam", MODE_PRIVATE).getString("service", null);

        script = readAsset("yeghadam.js");
        // Remote inspection exposes the whole Snapp session over USB: debug builds only.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        savedState = savedInstanceState;
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackgroundColor(Color.WHITE);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.addView(buildSwitchBar(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        View hairline = new View(this);
        hairline.setBackgroundColor(0xFFEEF0F5);
        box.addView(hairline, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(1))));
        switchBox = box;
        content.addView(box, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        host = new FrameLayout(this);
        content.addView(host, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        FrameLayout frame = new FrameLayout(this);
        frame.addView(content, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root = frame;
        setContentView(frame);
        if (savedInstanceState == null) showSplash(frame);
        else styleSystemBars();

        if (savedInstanceState != null) service = savedInstanceState.getString("service", service);
        if (service == null) {
            showStart();
        } else {
            showService(indexOf(service));
        }
    }

    /**
     * The service switch: a soft segmented control like the panel's own, with the active service in navy. A second
     * lime-tinted outline next to the panel's chips looked like another widget; this reads as the same family.
     */
    private View buildSwitchBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        bar.setPadding(dp(12), dp(8), dp(12), dp(8));

        LinearLayout seg = new LinearLayout(this);
        seg.setOrientation(LinearLayout.HORIZONTAL);
        seg.setPadding(dp(3), dp(3), dp(3), dp(3));
        GradientDrawable track = new GradientDrawable();
        track.setColor(0xFFF2F3F7);
        track.setCornerRadius(dp(14));
        seg.setBackground(track);

        int[] labels = {R.string.service_snapp, R.string.service_tapsi};
        final String[] ids = {SERVICE_SNAPP, SERVICE_TAPSI};
        for (int i = 0; i < 2; i++) {
            final String id = ids[i];
            TextView t = new TextView(this);
            t.setText(labels[i]);
            t.setGravity(Gravity.CENTER);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setClickable(true);
            t.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    selectService(id);
                }
            });
            seg.addView(t, new LinearLayout.LayoutParams(0, dp(36), 1f));
            tabs[i] = t;
        }
        bar.addView(seg, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        // Settings, reachable at any time: opens the same settings view the panel's gear shows, in the open service.
        ImageView gear = new ImageView(this);
        gear.setImageResource(R.drawable.ic_settings);
        gear.setScaleType(ImageView.ScaleType.CENTER);
        gear.setContentDescription(getString(R.string.settings));
        gear.setClickable(true);
        GradientDrawable gearBg = new GradientDrawable();
        gearBg.setColor(0xFFF2F3F7);
        gearBg.setCornerRadius(dp(14));
        gear.setBackground(gearBg);
        gear.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (web != null) web.evaluateJavascript("window.__yeghadamPrefs&&window.__yeghadamPrefs()", null);
            }
        });
        LinearLayout.LayoutParams gearLp = new LinearLayout.LayoutParams(dp(42), dp(42));
        gearLp.setMarginStart(dp(8));
        bar.addView(gear, gearLp);
        styleTabs(-1);
        return bar;
    }

    private void styleTabs(int activeIndex) {
        for (int i = 0; i < 2; i++) {
            boolean on = i == activeIndex;
            GradientDrawable bg = new GradientDrawable();
            bg.setCornerRadius(dp(11));
            bg.setColor(on ? NAVY : Color.TRANSPARENT);
            tabs[i].setBackground(bg);
            tabs[i].setTextColor(on ? Color.WHITE : 0xFF3A4058);
            tabs[i].setSelected(on);
        }
    }

    /** Show one service. Its WebView is created on first use; the hidden one stays paused. */
    private void showService(int index) {
        if (webs[index] == null) createWeb(index);
        for (int i = 0; i < 2; i++) {
            WebView w = webs[i];
            if (w == null) continue;
            w.setVisibility(i == index ? View.VISIBLE : View.GONE);
            if (i == index) w.onResume(); else w.onPause();
        }
        web = webs[index];
        styleTabs(index);
        web.requestFocus();
        // a page that was hidden may have a stale or missing price of the other service
        web.evaluateJavascript("window.__yeghadamFocus&&window.__yeghadamFocus()", null);
    }

    private void createWeb(int index) {
        WebView web = new WebView(this);
        web.setTag(index);
        web.setBackgroundColor(Color.WHITE);
        host.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webs[index] = web;

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // Look like regular mobile Chrome (drop the WebView markers).
        String ua = s.getUserAgentString();
        if (ua != null) {
            ua = ua.replace("; wv)", ")").replaceAll("Version/\\d+(\\.\\d+)* ", "");
            s.setUserAgentString(ua);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(index), "YeghadamNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        Bundle st = savedState == null ? null : savedState.getBundle("web" + index);
        if (st != null && web.restoreState(st) != null) return;
        web.loadUrl(homeUrl(index));
    }

    /**
     * First-run screens (intro, notice with consent, choice of service) in one local page, shown before any service
     * loads so the rider reads and accepts the notice first. With consent already given it opens on the choice.
     */
    private void showStart() {
        if (startView != null || root == null) return;
        WebView v = new WebView(this);
        v.setBackgroundColor(NAVY);
        WebSettings st = v.getSettings();
        st.setJavaScriptEnabled(true);
        st.setAllowFileAccess(false); // the asset folder stays readable; nothing else on the device does
        st.setAllowContentAccess(false);
        v.addJavascriptInterface(new StartBridge(), "StartNative");
        v.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // the page never navigates away
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                return rendererGone();
            }
        });
        root.addView(v, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        startView = v;
        Window w = getWindow();
        w.setStatusBarColor(NAVY);
        if (Build.VERSION.SDK_INT >= 27) w.setNavigationBarColor(NAVY);
        w.getDecorView().setSystemUiVisibility(0);
        v.loadUrl("file:///android_asset/start.html");
    }

    private void hideStart() {
        WebView v = startView;
        if (v == null) return;
        startView = null;
        ViewGroup parent = (ViewGroup) v.getParent();
        if (parent != null) parent.removeView(v);
        v.destroy();
        if (splash == null && !introOpen) styleSystemBars();
    }

    private int consentGiven() {
        return getSharedPreferences("yeghadam", MODE_PRIVATE).getInt("consent", 0);
    }

    /** What the start page can ask of the app. It is local and loads nothing from the network. */
    private class StartBridge {
        @JavascriptInterface
        public String step() {
            return consentGiven() >= NOTICE_VERSION ? "choose" : "intro";
        }

        @JavascriptInterface
        public void accept() {
            getSharedPreferences("yeghadam", MODE_PRIVATE).edit().putInt("consent", NOTICE_VERSION).putString("flag_seenIntro", "1").apply();
        }

        /** Declined: close without remembering, so the notice is asked again next time. */
        @JavascriptInterface
        public void decline() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finishAndRemoveTask();
                }
            });
        }

        @JavascriptInterface
        public void choose(final String id) {
            if (!SERVICE_SNAPP.equals(id) && !SERVICE_TAPSI.equals(id)) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    selectService(id);
                }
            });
        }

        /** The page has painted: the splash can go. */
        @JavascriptInterface
        public void ready() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    hideSplash();
                }
            });
        }
    }


    private static boolean isSharedFlag(String name) {
        return "seenIntro".equals(name) || "seenGuide".equals(name) || "peer".equals(name)
                || "auto".equals(name) || "depth".equals(name) || "budgets".equals(name);
    }

    /** Only the values the page script writes for each shared flag; "" clears it. */
    private static boolean validFlag(String name, String value) {
        if (value.isEmpty()) return true;
        if ("peer".equals(name)) return "on".equals(value) || "off".equals(value);
        if ("depth".equals(name)) return "quick".equals(value) || "full".equals(value);
        if ("budgets".equals(name)) return value.matches("(0|100|200|300):(0|100|200|300)");
        return "1".equals(value);
    }

    /** Accepts only 2 to 6 numeric lat/lng pairs and rebuilds them, so no page text is ever run as a script. */
    private static String cleanPoints(String json) {
        try {
            JSONArray in = new JSONArray(json);
            if (in.length() < 2 || in.length() > 6) return null;
            JSONArray out = new JSONArray();
            for (int i = 0; i < in.length(); i++) {
                JSONObject p = in.getJSONObject(i);
                double lat = p.getDouble("lat"), lng = p.getDouble("lng");
                if (Double.isNaN(lat) || Double.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
                out.put(new JSONObject().put("lat", lat).put("lng", lng));
            }
            return out.toString();
        } catch (Exception e) {
            return null;
        }
    }

    /** Keeps only a known status and a positive price from an answer. */
    private static String cleanAnswer(String json) {
        try {
            JSONObject in = new JSONObject(json);
            String status = in.optString("status", "none");
            if (!status.equals("ok") && !status.equals("auth") && !status.equals("closed")) status = "none";
            JSONObject out = new JSONObject().put("status", status);
            double price = in.optDouble("price", 0);
            if (status.equals("ok") && price > 0 && price < 1e10) out.put("price", price);
            else if (status.equals("ok")) out.put("status", "none");
            return out.toString();
        } catch (Exception e) {
            return "{\"status\":\"none\"}";
        }
    }

    /**
     * Ask the other service's page for its price of the route. If the rider has not opened that service yet, its WebView
     * does not exist and the answer is "closed". Otherwise the page gets up to 20 seconds for its script to be ready.
     */
    private void askPeer(final int asker, final int id, String points) {
        final int other = 1 - asker;
        // The other service is never loaded just to ask its price: until the rider has opened it (and signed in), the
        // answer is "not open", and the card offers to open it.
        // A tab that is on another site is treated as closed: the route must not reach a page that is not the service.
        if (webs[other] == null || !onServicePage(other)) {
            deliverPeer(asker, id, "{\"status\":\"closed\"}");
            return;
        }
        final WebView target = webs[other];
        target.onResume();
        // peerResult pauses it again; if no answer comes (the page navigated away), pause it anyway after a minute
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (target != web && webs[other] == target) target.onPause();
            }
        }, 60000);
        String js = "(async function(){var n=0;while(!window.__yeghadamPeerQuote&&n<40){await new Promise(function(r){setTimeout(r,500)});n++}"
                + "var a={status:'closed'};"
                + "if(window.__yeghadamPeerQuote){try{a=await window.__yeghadamPeerQuote(" + points + ")}catch(e){a={status:'none'}}}"
                + "YeghadamNative.peerResult(" + id + ",JSON.stringify(a))})()";
        target.evaluateJavascript(js, null);
    }

    /**
     * Show the other service, carrying the route. Tapsi takes it in its URL. Snapp has none: its start page is loaded and
     * the page script places the route once it is ready (see onPageFinished).
     */
    private void openPeer(int from, String points) {
        int to = 1 - from;
        selectService(to == 1 ? SERVICE_TAPSI : SERVICE_SNAPP);
        if (points == null) return;
        try {
            if (to == 1) {
                JSONArray in = new JSONArray(points);
                JSONArray dests = new JSONArray();
                for (int i = 1; i < in.length(); i++) {
                    dests.put(new JSONArray().put(in.getJSONObject(i).getDouble("lng")).put(in.getJSONObject(i).getDouble("lat")));
                }
                JSONObject o = in.getJSONObject(0);
                String url = HOME_TAPSI + "preview?origin=" + Uri.encode(new JSONArray().put(o.getDouble("lng")).put(o.getDouble("lat")).toString())
                        + "&destinations=" + Uri.encode(dests.toString());
                webs[1].loadUrl(url);
            } else {
                pendingRoute = points;
                webs[0].loadUrl(HOME_SNAPP + "pre-ride");
            }
        } catch (Exception e) {
            // keep the page the rider is already on
        }
    }

    private void deliverPeer(int asker, int id, String cleanJson) {
        WebView w = webs[asker];
        if (w == null || !onServicePage(asker)) return;
        w.evaluateJavascript("window.__yeghadamPeerDone&&window.__yeghadamPeerDone(" + id + "," + JSONObject.quote(cleanJson) + ")", null);
    }

    private void selectService(int index) {
        selectService(index == 1 ? SERVICE_TAPSI : SERVICE_SNAPP);
    }

    /** Remember the service and show it. Each service keeps its own page and history. */
    private void selectService(String id) {
        service = id;
        getSharedPreferences("yeghadam", MODE_PRIVATE).edit().putString("service", id).apply();
        hideStart();
        showService(indexOf(id));
    }

    private void styleSystemBars() {
        Window w = getWindow();
        w.setStatusBarColor(Color.WHITE);
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 27) {
            w.setNavigationBarColor(Color.WHITE);
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        w.getDecorView().setSystemUiVisibility(flags);
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    /**
     * Brand screen over the WebView while Snapp's page loads. The mark sits where the Android 12+ launch splash
     * draws it (a 288 dp box in the centre of the screen), so the system splash hands over without a jump.
     */
    private void showSplash(FrameLayout frame) {
        Window w = getWindow();
        w.setStatusBarColor(NAVY);
        if (Build.VERSION.SDK_INT >= 27) w.setNavigationBarColor(NAVY);
        w.getDecorView().setSystemUiVisibility(0);

        FrameLayout s = new FrameLayout(this);
        s.setBackgroundColor(NAVY);
        s.setClickable(true);

        // spacer, mark, text: the text overlaps the mark's empty margin by as much as the spacer is short of it,
        // so the mark stays exactly centred
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.addView(new View(this), new LinearLayout.LayoutParams(1, dp(48)));
        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.splash_mark);
        column.addView(mark, new LinearLayout.LayoutParams(dp(288), dp(288)));

        LinearLayout text = new LinearLayout(this);
        text.setOrientation(LinearLayout.VERTICAL);
        text.setGravity(Gravity.CENTER_HORIZONTAL);
        TextView name = new TextView(this);
        name.setText(R.string.app_name);
        name.setTextColor(Color.WHITE);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        text.addView(name);
        TextView tagline = new TextView(this);
        tagline.setText(R.string.splash_tagline);
        tagline.setTextColor(0xFFB8BDD0);
        tagline.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        text.addView(tagline);
        // loading line, filled with the page's progress from the right (the reading direction)
        FrameLayout track = new FrameLayout(this);
        GradientDrawable trackBg = new GradientDrawable();
        trackBg.setColor(0xFF2A3050);
        trackBg.setCornerRadius(dp(2));
        track.setBackground(trackBg);
        View fill = new View(this);
        GradientDrawable fillBg = new GradientDrawable();
        fillBg.setColor(LIME);
        fillBg.setCornerRadius(dp(2));
        fill.setBackground(fillBg);
        fill.setPivotX(dp(96));
        fill.setScaleX(0.06f);
        track.addView(fill, new FrameLayout.LayoutParams(dp(96), dp(3)));
        LinearLayout.LayoutParams trackLp = new LinearLayout.LayoutParams(dp(96), dp(3));
        trackLp.topMargin = dp(22);
        text.addView(track, trackLp);
        LinearLayout.LayoutParams textLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(96));
        textLp.topMargin = -dp(48);
        column.addView(text, textLp);
        s.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        TextView unofficial = new TextView(this);
        unofficial.setText(R.string.splash_unofficial);
        unofficial.setTextColor(0x8CFFFFFF);
        unofficial.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        FrameLayout.LayoutParams noteLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        noteLp.bottomMargin = dp(36);
        s.addView(unofficial, noteLp);

        frame.addView(s, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splash = s;
        splashFill = fill;
        splashShownAt = SystemClock.uptimeMillis();

        // one entrance: the name and tagline settle under the mark
        text.setAlpha(0f);
        text.setTranslationY(dp(10));
        text.animate().alpha(1f).translationY(0).setStartDelay(120).setDuration(450).setInterpolator(new DecelerateInterpolator(2f)).start();
        unofficial.setAlpha(0f);
        unofficial.animate().alpha(1f).setStartDelay(300).setDuration(450).start();

        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                hideSplash();
            }
        }, SPLASH_MAX_MS);
    }

    private void setSplashProgress(int progress) {
        if (splash == null || splashFill == null) return;
        float to = Math.max(0.06f, Math.min(1f, progress / 100f));
        if (to > splashFill.getScaleX()) splashFill.animate().scaleX(to).setDuration(200).start();
    }

    private void hideSplash() {
        final View s = splash;
        if (s == null) return;
        long wait = SPLASH_MIN_MS - (SystemClock.uptimeMillis() - splashShownAt);
        if (wait > 0) {
            ui.postDelayed(new Runnable() {
                @Override
                public void run() {
                    hideSplash();
                }
            }, wait);
            return;
        }
        splash = null;
        splashFill = null;
        // the first-run intro and the first-run page are navy too: keep the bars until they close (hideStart restyles)
        if (!introOpen && startView == null) styleSystemBars();
        s.animate().alpha(0f).setDuration(260).withEndAction(new Runnable() {
            @Override
            public void run() {
                ViewGroup parent = (ViewGroup) s.getParent();
                if (parent != null) parent.removeView(s);
            }
        }).start();
    }

    private void inject(WebView v) {
        if (script != null && v != null) {
            v.evaluateJavascript(script, null);
        }
    }

    private String readAsset(String name) {
        try {
            InputStream in = getAssets().open(name);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return out.toString("UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    /** Links that should leave the app (maps, stores, phone, etc.). */
    private boolean openExternally(WebView view, Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (scheme.equals("http") || scheme.equals("https")) {
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
            String path = uri.getPath() == null ? "" : uri.getPath();
            boolean external =
                    (host.contains("google.") && path.startsWith("/maps"))
                    || host.equals("maps.app.goo.gl")
                    || host.equals("play.google.com")
                    || host.endsWith("cafebazaar.ir")
                    || host.endsWith("myket.ir")
                    || host.equals("t.me")
                    || host.endsWith("instagram.com");
            if (!external) return false;
            launch(browsable(new Intent(Intent.ACTION_VIEW, uri)));
            return true;
        }
        if (scheme.equals("intent")) {
            try {
                Intent i = browsable(Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME));
                if (!launch(i)) {
                    // Only a web page may stand in for a missing app. A javascript:, data: or file: fallback would run in
                    // the page that is open now (the rider's Snapp or Tapsi session), so it is never loaded.
                    String fallback = i.getStringExtra("browser_fallback_url");
                    if (fallback != null) {
                        String s = Uri.parse(fallback).getScheme();
                        if ("https".equalsIgnoreCase(s) || "http".equalsIgnoreCase(s)) view.loadUrl(fallback);
                    }
                }
            } catch (Exception e) {
                // ignore malformed intent URIs
            }
            return true;
        }
        if (scheme.equals("about") || scheme.equals("data") || scheme.equals("blob") || scheme.equals("javascript")) {
            return false;
        }
        // tel:, sms:, mailto:, geo:, market:, snapp:, ...
        launch(browsable(new Intent(Intent.ACTION_VIEW, uri)));
        return true;
    }

    /** Like a browser: only apps that accept links from the web, never a named component. */
    private static Intent browsable(Intent i) {
        i.addCategory(Intent.CATEGORY_BROWSABLE);
        i.setComponent(null);
        i.setSelector(null);
        return i;
    }

    private boolean launch(Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            return true;
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "برنامه‌ای برای باز کردن این لینک پیدا نشد", Toast.LENGTH_SHORT).show();
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // A frame inside the page (an ad, a widget) may not open other apps or replace the page unless the rider
            // tapped it. Web links in frames load in the frame as usual.
            if (!request.isForMainFrame() && !request.hasGesture()) {
                String scheme = request.getUrl().getScheme();
                if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return true;
            }
            return openExternally(view, request.getUrl());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return openExternally(view, Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            inject(view);
            String route = pendingRoute;
            if (route != null && Integer.valueOf(0).equals(view.getTag()) && onHost(url, HOME_SNAPP)) {
                pendingRoute = null;
                view.evaluateJavascript("(async function(){var n=0;while(!window.__yeghadamStartRoute&&n<40){await new Promise(function(r){setTimeout(r,500)});n++}"
                        + "if(window.__yeghadamStartRoute)window.__yeghadamStartRoute(" + route + ")})()", null);
            }
            hideSplash();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                Object tag = view.getTag();
                String home = homeUrl(tag instanceof Integer ? (Integer) tag : 0);
                String html = "<!doctype html><html dir='rtl'><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                        + "<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;margin:0;color:#15192e;text-align:center;padding:0 24px;line-height:1.7}"
                        + "h3{margin:0 0 4px}div{color:#3a4058}"
                        + "a{margin-top:20px;background:#15192e;color:#fff;padding:12px 28px;border-radius:14px;text-decoration:none;font-weight:bold}</style></head>"
                        + "<body><h3>اتصال برقرار نشد</h3><div>اینترنت یا فیلترشکنت رو بررسی کن و دوباره امتحان کن.</div>"
                        + "<a href='" + home + "'>تلاش دوباره</a></body></html>";
                view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
                hideSplash();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            return rendererGone();
        }
    }

    private long lastRendererGone;

    /** The page's renderer died (often low memory). Start over once; if it dies again right away, close instead of looping. */
    private boolean rendererGone() {
        long now = SystemClock.uptimeMillis();
        boolean again = lastRendererGone != 0 && now - lastRendererGone < 30000;
        lastRendererGone = now;
        if (again) finish();
        else recreate();
        return true;
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (newProgress >= 70) inject(view);
            setSplashProgress(newProgress);
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            // The location is for the two services' own pages, never for another site that ends up in the WebView.
            if (!isServiceOrigin(origin)) {
                callback.invoke(origin, false, false);
                return;
            }
            if (hasLocationPermission()) {
                callback.invoke(origin, true, false);
                return;
            }
            // one system dialog at a time: the other tab is answered no instead of silently dropping the first callback
            if (pendingGeoCallback != null) {
                callback.invoke(origin, false, false);
                return;
            }
            pendingGeoOrigin = origin;
            pendingGeoCallback = callback;
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_LOCATION && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    /**
     * Helpers exposed to the page as window.YeghadamNative. Every script on the page can call these, including
     * third-party ones the site loads, so the bridge stays limited to harmless calls.
     */
    private class Bridge {
        private final int index; // which service's WebView this bridge belongs to

        Bridge(int index) {
            this.index = index;
        }

        /**
         * The page asks for the other service's price of a route. Nothing from the page reaches a script: the points
         * are parsed and rebuilt here, and the other WebView answers with its own session.
         */
        @JavascriptInterface
        public void peerQuote(final int id, final String pointsJson) {
            final String points = cleanPoints(pointsJson);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!onServicePage(index)) return;
                    if (points == null) deliverPeer(index, id, "{\"status\":\"none\"}");
                    else askPeer(index, id, points);
                }
            });
        }

        /** The rider asks to open the other service with this route (an empty list: just switch to it). */
        @JavascriptInterface
        public void peerOpen(final String pointsJson) {
            final String points = cleanPoints(pointsJson);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (onServicePage(index)) openPeer(index, points);
                }
            });
        }

        /** The other WebView's answer. Only a status and a price are forwarded. */
        @JavascriptInterface
        public void peerResult(final int id, final String json) {
            final String clean = cleanAnswer(json);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    // the answering WebView is this one; the asker is the other service
                    if (webs[index] != null && webs[index] != web) webs[index].onPause();
                    if (onServicePage(index)) deliverPeer(1 - index, id, clean);
                }
            });
        }

        /** A rider-level flag (first-run intro seen, guide seen, the answer about the other service's price), shared by both services. */
        @JavascriptInterface
        public String getFlag(String name) {
            if (!isSharedFlag(name)) return "";
            return getSharedPreferences("yeghadam", MODE_PRIVATE).getString("flag_" + name, "");
        }

        @JavascriptInterface
        public void setFlag(String name, String value) {
            if (!isSharedFlag(name) || value == null || !validFlag(name, value)) return;
            getSharedPreferences("yeghadam", MODE_PRIVATE).edit().putString("flag_" + name, value).apply();
        }

        /** Version of the "unofficial app" notice the rider accepted, 0 if none. Kept outside the page's storage. */
        @JavascriptInterface
        public int consentVersion() {
            return getSharedPreferences("yeghadam", MODE_PRIVATE).getInt("consent", 0);
        }

        @JavascriptInterface
        public void setConsent(int version) {
            if (version != NOTICE_VERSION) return; // only the notice this build shows can be accepted
            getSharedPreferences("yeghadam", MODE_PRIVATE).edit().putInt("consent", version).apply();
        }

        /** The rider declined the notice: close without remembering it, so it is asked again next time. */
        @JavascriptInterface
        public void decline() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (onServicePage(index)) finishAndRemoveTask();
                }
            });
        }

        /** The first-run intro is full-screen navy: match the system bars while it is open. */
        @JavascriptInterface
        public void introOpen(final boolean open) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!onServicePage(index)) return;
                    introOpen = open;
                    if (switchBox != null) switchBox.setVisibility(open ? View.GONE : View.VISIBLE);
                    if (splash != null) return; // the splash keeps navy bars and restyles them when it hides
                    if (open) {
                        Window w = getWindow();
                        w.setStatusBarColor(NAVY);
                        if (Build.VERSION.SDK_INT >= 27) w.setNavigationBarColor(NAVY);
                        w.getDecorView().setSystemUiVisibility(0);
                    } else {
                        styleSystemBars();
                    }
                }
            });
        }

        @JavascriptInterface
        public void toast(final String text) {
            if (text == null || text.isEmpty() || text.length() > 200) return; // a null text crashes Toast.show() on Android 11+
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!onServicePage(index)) return;
                    Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (startView != null) { // first-run screens: back goes to the previous one, else leaves the app
            startView.evaluateJavascript("(window.startBack && window.startBack()) ? 1 : 0", new android.webkit.ValueCallback<String>() {
                @Override
                public void onReceiveValue(String handled) {
                    if (!"1".equals(handled)) finish();
                }
            });
            return;
        }
        if (web == null) {
            finish();
            return;
        }
        final WebView current = web;
        // the offline page (about:blank) has nothing behind it but the failed load: leave instead of retrying it
        String url = current.getUrl();
        if (url == null || url.startsWith("about:")) {
            finish();
            return;
        }
        current.evaluateJavascript("(window.__yeghadamBack && window.__yeghadamBack()) ? 1 : 0", new android.webkit.ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if ("1".equals(handled)) return;
                if (current.canGoBack()) current.goBack();
                else finish();
            }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (service != null) outState.putString("service", service);
        for (int i = 0; i < 2; i++) {
            if (webs[i] == null) continue;
            Bundle b = new Bundle();
            webs[i].saveState(b);
            outState.putBundle("web" + i, b);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (startView != null) {
            startView.destroy();
            startView = null;
        }
        for (int i = 0; i < 2; i++) {
            if (webs[i] != null) {
                webs[i].destroy();
                webs[i] = null;
            }
        }
        web = null;
        super.onDestroy();
    }
}
