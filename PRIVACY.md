# Privacy

Yeghadam has no server and collects no data.

## What it reads

- Snapp: the access token that the Snapp web app keeps in the page's local storage, so price quotes are made with your own account.
- Tapsi: one flag from the page's local storage (whether you are signed in). Quotes use the session cookie the Tapsi web app already holds, which the browser attaches itself.
- The route you confirm (origin, destination and any stops), taken from the page's own price requests or address in the same page.

## Where it sends requests

- `https://app.snapp.taxi/api/v3/price`: price quotes for points near your origin and destination. These requests carry your token exactly like the Snapp web app does.
- `https://api.tapsi.cab/api/v3.1/ride/preview`: the same quotes on Tapsi. These requests carry your Tapsi session exactly like the Tapsi web app does.
- `https://tile.snappmaps.ir` and the map tile host named in Tapsi's own map style (`tap30.services`): public map tiles, without any credentials.

Nothing is sent anywhere else. Your token and session go only to the service they belong to, in the same requests its own web app makes; Yeghadam has no server, so they never reach anyone else.

## The other service's price

If you say yes, once, the page also gets the price of the same route from the other service. A page never calls the other service itself. It hands the route points (latitude and longitude only) to the page of the other service, in the other browser tab or the other tab of the Android app, which asks its own API with its own session and hands back one price. The extension's background script and the Android bridge only pass these messages along; they make no network request. If the other service is not open, nothing is loaded and nothing is sent for this: it just says so. The iPhone userscript has no way to reach another tab, so it never asks the other service. The route points do reach the other service, which is your own account there. Your answer is remembered in the page's local storage and can be changed in the panel.

## What it stores on your device

In the page's local storage: your last walking-distance choice, your preferred service per category, whether you allowed the other service's price, and the times of recent searches, single-point quotes and quotes made for the other service's page (used only to keep the number of quotes low). For the last 60 Snapp searches it also keeps how the price and the trip's expected minutes changed at each checked point, with the walk in meters, the hour and the weekday, but no places or coordinates; it stays on the device and is never sent. The Android app also keeps, in its own private preferences, which service you picked, the version of the notice you accepted, and whether you have seen the intro and the guide and what you answered about the other service's price (one answer for both services). Its first-run screens are a local page inside the app and load nothing from the network. When the extension opens Snapp with a route from Tapsi, it keeps those route points for up to two minutes in the browser's session storage, which is never written to disk and is cleared when the browser closes. The Android app excludes all of its data, including the web sessions, from backups and from moving to a new phone. Nothing is synced.

## What it never does

It never requests, confirms or cancels a ride. Applying a suggestion only moves the pin on Snapp's map and presses Snapp's own confirm button for the point, or opens Tapsi's price page with the new point. Opening the other service with your route does the same on that service. You request the ride yourself.
