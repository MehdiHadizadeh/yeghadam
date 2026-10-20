# Privacy

Yeghadam has no server and collects no data.

## What it reads

- The Snapp access token that the Snapp web app keeps in the page's local storage, so price quotes are made with your own account.
- The route you confirm in Snapp (origin, destination and any stops), taken from Snapp's own price requests in the same page.

## Where it sends requests

- `https://app.snapp.taxi/api/v3/price`: price quotes for points near your origin and destination. These requests carry your token exactly like the Snapp web app does.
- `https://tile.snappmaps.ir`: public map tiles, without any credentials.

Nothing is sent anywhere else. The token never leaves your device.

## What it stores on your device

In the page's local storage: your last walking-distance choice, your preferred service per category, and the times of recent searches (used only to keep the number of quotes low). Nothing is synced.

## What it never does

It never requests, confirms or cancels a ride. Applying a suggestion only moves the pin on the map; you confirm it yourself in Snapp.
