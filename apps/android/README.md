# سیمرغ‌کد برای اندروید — Android build

This folder wraps the mobile PWA (`apps/mobile`) in a Capacitor shell, so the
*same* TypeScript implementation ships both as an installable web app and as a
native APK. There is no second implementation of the symbology anywhere: the
WebView loads `apps/mobile/dist`, and every byte of cryptography runs inside it.

## What is here

| Path                          | What it is |
| ----------------------------- | ---------- |
| `capacitor.config.ts`         | App id `code.simurgh.scanner`, webDir `../mobile/dist`, HTTPS scheme, no cleartext |
| `android/`                    | The Gradle project (`cap add android`), with SiMurgh launcher icons and splash |
| `scripts/make-android-icons.mjs` | Regenerates every density bucket from a real, scannable v3 symbol |
| `app/src/main/AndroidManifest.xml` | CAMERA + VIBRATE permissions; camera declared *not required* |

The launcher icon is not a drawing of a code, it **is** a code: version 3 carrying
`https://simurgh.code`, gold on lapis (10.6:1 contrast). `make-android-icons.mjs`
decodes the icon it just wrote and fails the run if the reader cannot open it.

## Building an APK (needs the Android SDK)

The Android SDK, Gradle and Maven are not available in this repository's build
environment, so no binary is committed. On a machine with the SDK:

```bash
npm install                        # repo root: installs Capacitor too
npm run build -w @simurgh/mobile   # the web bundle the WebView loads
cd apps/android
npx cap sync android               # copies ../mobile/dist into assets/public
./android/gradlew assembleDebug    # -> android/app/build/outputs/apk/debug/app-debug.apk
```

For a release:

```bash
./android/gradlew bundleRelease    # signed with your own keystore
```

## Without the SDK: install as a PWA

The identical app installs straight from a browser (Chrome on Android:
*Add to Home screen*). It is fully offline after first load — the service worker
caches the shell — and requests camera access exactly like the APK does.

## Permissions, honestly

- **CAMERA** — the scanner. Frames are decoded on-device in a Web Worker and are
  never uploaded; the app performs no network requests at all.
- **VIBRATE** — a 28 ms buzz on a successful scan.
- Nothing else: no storage permission (payloads stay in memory; preferences use
  the WebView's own localStorage), no location, no contacts.
