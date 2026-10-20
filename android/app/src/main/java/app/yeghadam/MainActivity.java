package app.yeghadam;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
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

    private WebView web;
    private String script;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        styleSystemBars();

        script = readAsset("yeghadam.js");
        WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        setContentView(web);

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
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                String html = "<!doctype html><html dir='rtl'><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                        + "<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;margin:0;color:#0f172a;text-align:center;padding:0 24px}"
                        + "a{margin-top:16px;background:#0f766e;color:#fff;padding:12px 28px;border-radius:12px;text-decoration:none;font-weight:bold}</style></head>"
                        + "<body><h3>اتصال برقرار نشد</h3><div>اینترنت یا فیلترشکن را بررسی کن و دوباره امتحان کن.</div>"
                        + "<a href='" + HOME + "'>تلاش دوباره</a></body></html>";
                view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
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

    /** Small helpers exposed to the injected script as window.YeghadamNative. */
    private class Bridge {
        @JavascriptInterface
        public void copy(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    ClipboardManager cb = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cb != null) cb.setPrimaryClip(ClipData.newPlainText("location", text));
                    Toast.makeText(MainActivity.this, "کپی شد", Toast.LENGTH_SHORT).show();
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
        public void open(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    launch(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
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
