# Changelog

Notable changes per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added
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

[2.3.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.3.0
[2.2.1]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.2.1
[2.2.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.2.0
[2.1.1]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.1.1
[2.1.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.1.0
[2.0.3]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.0.3
[2.0.2]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.0.2
[2.0.1]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.0.1
[2.0.0]: https://github.com/MehdiHadizadeh/yeghadam/releases/tag/v2.0.0
