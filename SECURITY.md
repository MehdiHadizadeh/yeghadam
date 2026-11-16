# Security policy

Yeghadam runs inside the Snapp and Tapsi web apps with the rider's own session, so a bug here can touch a real account. Please report security problems privately.

## Reporting a vulnerability

Use GitHub's private reporting: [Report a vulnerability](../../security/advisories/new). Please do not open a public issue for it.

Include what you found, how to reproduce it, and which version (Android app or extension) you tested. You will get an answer within a week.

## What counts

- Anything that makes the script send a rider's token, cookie, route or prices somewhere other than the service it runs on.
- Anything that lets a web page or another extension request, confirm or cancel a ride through Yeghadam.
- A way to make the script exceed its request limits on the rider's account.
- A flaw in how the Android app, its bridge or its signing is set up.

Changes in how Snapp or Tapsi behave (an API that moved, a stricter limit) are bugs, not vulnerabilities. Open a normal issue for those.

## Supported versions

Only the latest release gets fixes.

## Verifying a download

Every release ships `SHA256SUMS.txt`. Compare the checksum before installing:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

The APK is signed with the project's release key. The signature stays the same across releases, so an update that asks to replace the app with a different signature is not ours.
