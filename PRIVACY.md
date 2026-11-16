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

Nothing is sent anywhere else. Your token and session never leave your device.

## What it stores on your device

In the page's local storage: your last walking-distance choice, your preferred service per category, and the times of recent searches (used only to keep the number of quotes low). The Android app also keeps which service you picked and the version of the notice you accepted in its own private preferences. Nothing is synced.

## What it never does

It never requests, confirms or cancels a ride. Applying a suggestion only moves the pin on Snapp's map (you confirm it yourself) or opens Tapsi's price page with the new point; you request the ride yourself.
