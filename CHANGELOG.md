# Changelog

Notable changes per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [2.6.0] - 2026-11-21

### Added
- A settings view behind the gear button in the panel header: walking distance per end, search depth (quick: up to 15 quotes, full: up to 25), automatic search when a route is confirmed, and the other service's price on or off. Automatic search waits until the route holds still and stays within the per-account limits. Settings open at any time, also before a route is set: from the panel's gear, from a gear next to the service switch in the Android app, or by holding (right-clicking) the pill. In the Android app the settings are shared by Snapp and Tapsi. Automatic searches leave room for two searches started by hand under the limits.

### Security
- The Android app never loads a `javascript:`, `data:` or `file:` fallback address from an `intent:` link. Only a web page can stand in for a missing app, so a link can no longer run code inside the open Snapp or Tapsi page.
- The Android app shares the device location only with the Snapp and Tapsi pages, not with another site opened inside it.
- In the Android app, the price comparison and "open the other service" work only while each tab is on its own service's site. A page reached through a link can no longer use them or receive the route.
- A page answers the other service's price question at most 20 times in 10 minutes and 60 times an hour, so the comparison cannot be used to send unlimited quotes from the rider's account.
- The extension's background script hands back only a known status and a price from the other tab, as the Android app already did, and rejects empty or non-numeric route points.
- The automatic tap that confirms Snapp's pin is skipped when the map's centre is under Snapp's ride sheet or on a control that requests, cancels or pays for a ride. The rider is asked to tap the pin instead.
- The notice can only be accepted for the version the app shows, the shared flags only take the values the script writes, and closing the app, hiding the tab bar or showing a toast only work from the service's own site.
- A frame inside the page can no longer open other apps or replace the page through an `intent:` link unless the rider tapped it, and links only open apps that accept links from the web.
- On Android 12 and later, no app data (including the Snapp and Tapsi sessions) is included in backups or moved to a new phone.
- The release workflow fails unless the APK is signed with the release key, the keystore file is removed even when the build fails, and every GitHub Action is pinned to a commit.

### Fixed
- A price request that gets no answer gives up after 15 seconds instead of hanging the search (also in old Android WebViews), and the stop button no longer waits for it.
- No connection or repeated server errors are reported as a connection problem. Before, they read as the service limiting the account and blocked new searches for five minutes.
- Applying a suggestion for the last destination of a route with a stop presses Snapp's own confirm button for the second destination when the page shows it.
- A damaged map tile can no longer make the street decoder build a line of millions of points.
- Android first run: accepting or declining the notice on the first-run page now reaches the app. Before, the answer was lost, so the notice was shown again inside the service and "no, thanks" did nothing.
- Android: the system bars stay navy while the first-run page is open, and the app no longer crashes when a page asks for an empty toast.
- A long press on a touch screen asks for one price, not two.
- The numbered badges on Snapp's map come back after Snapp rebuilds its map.
- On Android, a late answer from the other service after a page reload can no longer be shown for a different route.
- The stop button no longer waits out a retry pause after a failed request.
- In the extension, a route carried from Tapsi to a Snapp tab that loads slowly is no longer lost when the browser stops the idle background script.
- Carrying a route with a stop to Snapp presses the "second destination" control itself, not a box around it.
- The automatic pin tap is no longer skipped on screens where Snapp's ride sheet could not be found.
- Android: Back on the offline page closes the app instead of retrying the failed page, a crashing page renderer no longer reloads in a loop, and a second location request while the system dialog is open no longer leaves the first page waiting.

### Changed
- The pill's accessible name is the status it shows (for example the saving), not a fixed "open" label.
- The apply and dismiss buttons on the result cards are taller and easier to hit.
- A result card is no longer a button holding other buttons: its first row is the button that shows the point on the map, so screen readers reach show, dismiss and apply separately.
- The project page tells Firefox users where to get their build.
- The guide opens the first time the service's map is up and the rider is signed in, before the first search, instead of only after "ارزون‌ترش کن" is pressed. Leaving the price page no longer closes it.
- The guide's picture of the price comparison card reads in the right order and no longer overlaps.
- Clearer wording for a lost connection, a route with no price, a long press too far from the route and how long a search takes.

## [2.5.0] - 2026-11-19

### Added
- A userscript build (`yeghadam-x.y.z.user.js`) for Safari on iPhone through the Userscripts app, no App Store listing needed. It runs the same page script; the two-service price comparison is off because a single page cannot reach the other service's tab.

## [2.4.0] - 2026-11-18

### Added
- A separate Firefox build of the extension (`yeghadam-extension-firefox-x.y.z.zip`) in each release. It uses an event page instead of a service worker.
- The Android app has a two-tab switch between Snapp and Tapsi. Each service keeps its own page and history, so switching does not reload anything. The second service is only loaded the first time it is opened.
- The panel shows the other service's price for the same route (Snapp next to Tapsi and the other way round) and how much cheaper or dearer it is. The other service's page quotes it with its own session, so no token or cookie leaves its page.
- An "open Tapsi" / "open Snapp" link in that line opens the other service with the same route, in the extension (another tab) and in the Android app (the other tab of the switch). Tapsi takes the route in its URL. For Snapp the script moves the map to the origin and the destination and presses Snapp's own confirm buttons.
- The other service's price is only asked for after the rider says yes, once. The answer is remembered and can be changed from the panel.
- The README and site screenshots, the banner and the guide GIF show the current panel: price comparison, the seven-step guide and the automatic confirm.
- The first-run notice, the in-app guide (now seven steps), the README, the privacy notes and the site describe the two-service comparison, the tab switch and the automatic confirm.
- Applying a suggestion in Snapp now confirms the moved pin on its own, using Snapp's confirm button or a tap on the pin. The manual "tap the pin" guide stays as the fallback.

### Fixed
- On narrow phones the "cheaper/dearer" pill of the price comparison card was cut off; it now wraps under the price.
- Routes with a stop between the ends (Snapp's "second destination"): applying a suggestion in Snapp now edits the pin of the last destination, "مقصد دوم", instead of the first one. The panel calls that end "مقصد آخر", says that only the first and last points move, and carrying such a route from Tapsi to Snapp keeps both destinations (adding the second one is best effort and falls back to a message).
- The pill no longer shows over Snapp's own loading screen. A route kept from the last visit counts as the price page only once Snapp's origin and destination labels are on screen.
- After applying a suggestion in Snapp, the panel shows the price Snapp quoted for the new route (with the "applied" note) instead of the price from before the apply, so the comparison with the other service uses the right number.
- Stepping through the guide no longer replays the sheet's entrance animation and the style sheet is no longer re-parsed on every step, which removes the lag on "next".
- The apply bar shows progress as "1 of 2", and the "tap the pin" hint and the pulsing ring only appear if the automatic confirm did not take within a few seconds.
- The Android app no longer loads the other service in the background to ask its price. Until you open that service, the card says it is not open and offers to open it.
- The tab bar is hidden during the first-run intro, and the price rows read in order: your price, the service choice, then the other service's price.

### Changed
- First run on Android: the intro, the notice with the accept button and the choice of service are one local page that comes before any service loads, in that order. Declining closes the app. The choice screen now carries three short tips.
- The intro and notice texts name both services and say that the other service's price is only asked for with the rider's permission.
- The Snapp/Tapsi switch is a soft segmented control with the active service in navy, in the same family as the panel's own chips.
- Back from the first page of a service closes the app instead of showing the service choice again.
- The price comparison is a compact card with the other service's price, how much cheaper or dearer it is, and a button that opens that service with the same route.

## [2.3.0] - 2026-11-17

### Added
- Tapsi support: quotes, suggestions and a one-tap apply that opens the same price page with the new point.
- Separate walking distance for the origin and the destination, with a "stay here" choice to leave one end alone.
- The panel shows Tapsi's live price and warns when it moves after a search.
- The Android app asks which service to open and remembers the choice. Back from a first page shows the choice again.

### Changed
- A point the service refuses is skipped instead of ending the search.
- Applying a suggestion while a search runs cancels that search.
- Tapsi quotes follow the app version Tapsi's own page reports.

### Removed
- The price limit field. It only filtered finished results.

## [2.2.1] - 2026-10-21

### Changed
- The intro is shown to riders who upgrade, and the pill stays on the price page.

## [2.2.0] - 2026-10-21

### Added
- A first-run intro and an "unofficial app" notice that has to be accepted.

## [2.1.1] - 2026-10-21

### Changed
- The panel is a bottom sheet on phones.

### Fixed
- Walking distances.

## [2.1.0] - 2026-10-21

### Changed
- Redesigned in-page UI, rewritten guide and a splash screen.

## [2.0.3] - 2026-10-21

### Added
- A first-run guide.

### Changed
- Hardened the Android app.

## [2.0.2] - 2026-10-21

### Fixed
- The full result cards are back.

## [2.0.1] - 2026-10-21

### Fixed
- The panel fits the space above the ride sheet.

## [2.0.0] - 2026-10-20

First public release.

[Unreleased]: https://github.com/MehdiHadizadeh/yeghadam/compare/v2.6.0...HEAD
[2.6.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.6.0
[2.5.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.5.0
[2.4.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.4.0
[2.3.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.3.0
[2.2.1]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.2.1
[2.2.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.2.0
[2.1.1]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.1.1
[2.1.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.1.0
[2.0.3]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.0.3
[2.0.2]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.0.2
[2.0.1]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.0.1
[2.0.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.0.0
