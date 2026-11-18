# Contributing

Thanks for helping. Yeghadam is a small project, so the rules are short.

## Before you start

- Open an issue first for anything bigger than a fix, so we agree on the direction.
- The app only asks for prices. A change that requests, confirms or cancels a ride will not be merged.
- Nothing may leave the rider's device except the requests to Snapp or Tapsi that the script already makes. There is no server and no analytics.
- A page only calls its own service. Anything about the other service goes through the shell (extension relay or Android bridge; the userscript has none, so it has no comparison) to the page of that service.

## Set up

You need Node.js 22 or later. The Android app also needs JDK 17, the Android SDK (platform 34) and Gradle 8.9. See the Development section of the [README](README.md) for the layout and commands.

```bash
npm test
npm run build
```

Load `dist/extension/` as an unpacked extension to try a change in the browser.

## Making a change

- Keep the change small and focused. One topic per pull request.
- Add or update a test in `test/` when you change `src/core.js`. The core has no DOM so it runs in Node.
- Code comments are in English. User-facing text is Persian, written the way people speak, short and direct.
- No personal data in the repository: no real routes or coordinates, no emails, no keys. Use made-up points in tests and screenshots.
- Do not commit `dist/` or the generated `yeghadam.js`; `npm run build` makes them.

## Commits and pull requests

- Write the commit subject in the imperative, for example `Skip a point the service refuses`.
- Explain why in the body when it is not obvious.
- Make sure `npm test` passes. CI also builds the Android app.

## Reporting a problem

Use the issue templates. For anything that touches accounts or privacy, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
