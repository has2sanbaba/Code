import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor project for سیمرغ‌کد.
 *
 * The WebView loads the *same* bundle the browser installs as a PWA
 * (apps/mobile/dist), so there is exactly one implementation of the symbology in
 * the product and no native duplicate to keep in sync. Everything cryptographic
 * runs inside that bundle: no key material ever crosses the JS/native bridge.
 *
 * Building an APK needs the Android SDK, which is not part of this repository:
 *
 *     npm install                     # at the repo root
 *     npm run build -w @simurgh/mobile
 *     cd apps/android && npx cap sync android
 *     ./android/gradlew assembleDebug # -> android/app/build/outputs/apk/debug
 */
const config: CapacitorConfig = {
  appId: 'code.simurgh.scanner',
  appName: 'سیمرغ‌کد',
  webDir: '../mobile/dist',
  backgroundColor: '#070f1e',
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    backgroundColor: '#070f1e',
  },
  server: {
    // Everything is local: the app must work in airplane mode.
    androidScheme: 'https',
    cleartext: false,
  },
};

export default config;
