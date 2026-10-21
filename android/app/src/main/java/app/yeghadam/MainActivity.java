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

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Hosts the Snapp passenger web app (app.snapp.taxi) in a WebView and injects
 * the Yeghadam script. Everything runs on the device with the user's own Snapp
 * session. The script only requests price quotes; it never creates a ride.
 */
public class MainActivity extends Activity {

    private static final String HOME = "https://app.snapp.taxi/";
    private static final int REQ_LOCATION = 41;
    private static final int NAVY = 0xFF15192E;
    private static final int LIME = 0xFFC5F04A;
    // The splash stays at least this long, so it never flickers, and at most this long, if the page hangs.
    private static final long SPLASH_MIN_MS = 900;
    private static final long SPLASH_MAX_MS = 10000;

    private WebView web;
    private String script;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private View splash;
    private View splashFill;
    private long splashShownAt;
    private volatile boolean introOpen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        script = readAsset("yeghadam.js");
        // Remote inspection exposes the whole Snapp session over USB: debug builds only.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        FrameLayout frame = new FrameLayout(this);
        frame.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(frame);
        if (savedInstanceState == null) showSplash(frame);
        else styleSystemBars();

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

        web.addJavascriptInterface(new Bridge(), "YeghadamNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(HOME);
        }
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
        if (!introOpen) styleSystemBars(); // the first-run intro is navy too: keep the bars until it closes
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
    private boolean openExternally(Uri uri) {
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
            launch(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        }
        if (scheme.equals("intent")) {
            try {
                Intent i = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.setComponent(null);
                i.setSelector(null);
                if (!launch(i)) {
                    String fallback = i.getStringExtra("browser_fallback_url");
                    if (fallback != null) web.loadUrl(fallback);
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
        launch(new Intent(Intent.ACTION_VIEW, uri));
        return true;
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
            return openExternally(request.getUrl());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return openExternally(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            inject(view);
            hideSplash();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                String html = "<!doctype html><html dir='rtl'><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                        + "<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;margin:0;color:#15192e;text-align:center;padding:0 24px;line-height:1.7}"
                        + "h3{margin:0 0 4px}div{color:#3a4058}"
                        + "a{margin-top:20px;background:#15192e;color:#fff;padding:12px 28px;border-radius:14px;text-decoration:none;font-weight:bold}</style></head>"
                        + "<body><h3>اتصال برقرار نشد</h3><div>اینترنت یا فیلترشکن را بررسی کن و دوباره امتحان کن.</div>"
                        + "<a href='" + HOME + "'>تلاش دوباره</a></body></html>";
                view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
                hideSplash();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            recreate();
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (newProgress >= 70) inject(view);
            setSplashProgress(newProgress);
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (hasLocationPermission()) {
                callback.invoke(origin, true, false);
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
        /** Version of the "unofficial app" notice the rider accepted, 0 if none. Kept outside the page's storage. */
        @JavascriptInterface
        public int consentVersion() {
            return getSharedPreferences("yeghadam", MODE_PRIVATE).getInt("consent", 0);
        }

        @JavascriptInterface
        public void setConsent(int version) {
            getSharedPreferences("yeghadam", MODE_PRIVATE).edit().putInt("consent", version).apply();
        }

        /** The rider declined the notice: close without remembering it, so it is asked again next time. */
        @JavascriptInterface
        public void decline() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finishAndRemoveTask();
                }
            });
        }

        /** The first-run intro is full-screen navy: match the system bars while it is open. */
        @JavascriptInterface
        public void introOpen(final boolean open) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    introOpen = open;
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
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
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
        web.evaluateJavascript("(window.__yeghadamBack && window.__yeghadamBack()) ? 1 : 0", new android.webkit.ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if ("1".equals(handled)) return;
                if (web.canGoBack()) web.goBack();
                else finish();
            }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
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
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
