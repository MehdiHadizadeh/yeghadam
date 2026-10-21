<p align="center">
  <img src="docs/images/banner.png" alt="یه‌قدم: یه قدم اون‌ورتر، ارزون‌تر" width="760">
</p>

<div dir="rtl">

# یه‌قدم

**یه قدم اون‌ورتر، ارزون‌تر.**

قیمت اسنپ فقط به مسیر بستگی ندارد؛ نقطه‌ی دقیق سوار و پیاده شدن هم مهم است. اون‌ور خیابان، سر کوچه‌ی بعدی یا چند ده متر جلوتر، گاهی همان سفر چند ده هزار تومان ارزان‌تر است.
یه‌قدم داخل خود وب‌اپ اسنپ کار می‌کند: نقاط نزدیکی را که واقعاً می‌شود پیاده تا آن‌ها رفت قیمت می‌گیرد و چند پیشنهاد کوتاه نشانت می‌دهد.

> یه‌قدم برنامه‌ای غیررسمی است و هیچ ارتباطی با اسنپ ندارد. فقط قیمت می‌پرسد و هرگز سفری ثبت نمی‌کند.

<p align="center">
  <img src="docs/images/screen-guide.png" width="170" alt="راهنمای اول کار">
  <img src="docs/images/screen-setup.png" width="170" alt="انتخاب فاصله‌ی پیاده‌روی">
  <img src="docs/images/screen-results.png" width="170" alt="پیشنهادها">
  <img src="docs/images/screen-pill.png" width="170" alt="نمایش روی نقشه">
  <img src="docs/images/screen-apply.png" width="170" alt="اعمال در اسنپ">
</p>
<p align="center"><sub>تصاویر نمونه‌اند؛ قیمت و خیابان‌ها برای نمایش انتخاب شده‌اند.</sub></p>

## چطور کار می‌کند

1. در اسنپ مبدا و مقصد را انتخاب کن تا قیمت بیاید، بعد روی **«ارزون‌ترش کن»** بزن.
2. بگو امروز تا کجا حاضری پیاده بروی: ۱۰۰، ۲۰۰ یا ۳۰۰ متر. ماشین یا موتور.
3. چند ثانیه بعد، حداکثر سه پیشنهاد می‌بینی: چقدر ارزان‌تر، چند متر پیاده، کجا.
4. روی **«اعمال در اسنپ»** بزن؛ پین به همان نقطه می‌رود و فقط تأییدش می‌کنی. بعد پیاده تا نقطه‌ی جدید برو.

بار اول یک راهنمای شش‌قدمی همین‌ها را با تصویر نشان می‌دهد و هر وقت خواستی با دکمه‌ی **؟** بالای پنل دوباره باز می‌شود.

<p align="center"><img src="docs/images/tutorial.gif" width="300" alt="راهنمای شش‌قدمی"></p>

## امکانات

- **فقط جاهایی که می‌شود رفت.** نقاط روی خیابان‌هایی انتخاب می‌شوند که ماشین می‌تواند آنجا بایستد؛ نه وسط بزرگراه، نه داخل تونل، نه روی رمپ.
- **فاصله‌ی پیاده‌روی واقعی** روی شبکه‌ی خیابان‌ها، با عبور از عرض بلوار؛ نه خط هوایی.
- **اون‌ور خیابان** روی بلوارهای دوطرفه همیشه بررسی می‌شود؛ معمولاً مسیر راننده را عوض می‌کند.
- **ماشین یا موتور،** هر جا اسنپ آن را برای مسیرت ارائه کند.
- **«تا چند حاضری بدی؟»:** کمترین پیاده‌روی برای رسیدن به زیر قیمتی که می‌خواهی.
- **قیمت یک نقطه‌ی دلخواه:** انگشتت را روی نقشه نگه دار (در کامپیوتر: کلیک راست).
- **قفل قیمت:** اسنپ هر قیمت را چند دقیقه ثابت نگه می‌دارد. یه‌قدم این را تشخیص می‌دهد و می‌گوید جابه‌جا شدن به نفعت هست یا نه.

## نصب

**اندروید:** فایل `yeghadam-x.y.z.apk` را از بخش [Releases](../../releases) دانلود و نصب کن، بعد با حساب اسنپ خودت وارد شو.

**کروم، اج و مرورگرهای کرومیوم:**
1. فایل `yeghadam-extension-x.y.z.zip` را از [Releases](../../releases) دانلود و از حالت فشرده خارج کن.
2. به `chrome://extensions` برو و **Developer mode** را روشن کن.
3. **Load unpacked** را بزن و پوشه‌ی باز شده را انتخاب کن.
4. در [app.snapp.taxi](https://app.snapp.taxi) مبدا و مقصد را انتخاب کن و روی «ارزون‌ترش کن» بزن.

**فایرفاکس ۱۲۸ به بعد:** در `about:debugging#/runtime/this-firefox` روی **Load Temporary Add-on** بزن و `manifest.json` داخل همان پوشه را انتخاب کن.

## حریم خصوصی و امنیت حساب

یه‌قدم سرور ندارد و هیچ داده‌ای جمع نمی‌کند. با همان حسابی کار می‌کند که در اسنپ وارد شده‌ای و فقط با دو آدرس حرف می‌زند:

- `app.snapp.taxi/api/v3/price` برای استعلام قیمت، با توکن خودت که از دستگاهت بیرون نمی‌رود؛
- `tile.snappmaps.ir` برای نقشه‌ی عمومی خیابان‌ها.

هر جستجو حداکثر ۲۵ استعلام است و تعداد جستجوها محدود است (۵ بار در ۱۰ دقیقه و ۱۵ بار در ساعت) تا حسابت به خاطر استعلام زیاد حساس نشود. جزئیات در [PRIVACY.md](PRIVACY.md).

</div>

---

## Development

Yeghadam is a script injected into the Snapp passenger web app, shipped two ways: a Manifest V3 browser extension and a small Android app that hosts the web app in a WebView.

```
src/core.js        search engine, no DOM: vector tiles, walking graph, candidates, ranking (runs in Node for tests)
src/ui.js          page layer: route tracking, map overlay, panel, guided apply
scripts/build.js   bundles both into dist/extension/ and the Android assets
extension/         extension manifest and icons
android/           Android app (Java, no AndroidX)
test/              unit tests for the core
brand/             logo source image (drawn by scripts/make-icons.py)
docs/images/       README images
```

### Requirements

- Node.js 22 or later
- For the Android app: JDK 17, the Android SDK (platform 34) and Gradle 8.7 or later
- To redraw icons: Python 3 with Pillow

### Commands

```bash
npm test                         # unit tests
npm run build                    # dist/extension/ and android/app/src/main/assets/yeghadam.js
gradle -p android assembleDebug  # debug APK (runs the script build first)
npm run icons                    # redraw every icon size
```

Load `dist/extension/` with **Load unpacked** to try local changes.

### How the search works

1. Road data comes from the public vector tiles the Snapp map already uses. Roads become a walking graph; the one-way carriageway pairs of divided roads get crossing links with a small penalty, and loose road ends left by tile simplification are joined to the road they meet.
2. Candidates are points a car can stop at (no motorways, ramps, tunnels or bridges), spread over rings of walking distance from the origin and from the destination.
3. A search spends at most 25 quotes: a spread phase on both ends, then the remaining budget steps around the best point found so far.
4. Snapp locks a quote for a few minutes per route. When the base price is older than the search, one extra quote on the same street shows the current price.
5. Results are the Pareto front of walking distance against price, limited to three options.

The route is taken from Snapp's own price requests, and only once its first and last points sit on the origin and destination markers, so previews made while dragging a pin are ignored.

### Releasing

The version lives in `package.json` only; the extension manifest and the Android version are derived from it.

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v2.1.0 && git push origin v2.1.0`.
3. The [Release workflow](.github/workflows/release.yml) tests, builds and signs the APK, zips the extension and publishes both with checksums.

The release keystore is never committed. It is stored as repository secrets: `KEYSTORE_BASE64` (`base64 -w0 release.p12`), `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`.

## License

[MIT](LICENSE). Not affiliated with, endorsed by or connected to Snapp. "Snapp" is a trademark of its owner.
