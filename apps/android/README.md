# سیمرغ‌کد برای اندروید · SiMurgh Code for Android

یک **اپ بومی اندروید** — کاتلین، رابط کاربری XML/Material، دوربین CameraX،
ذخیره در MediaStore و هم‌رسانی با FileProvider. **بدون WebView، بدون HTML، بدون
اجازهٔ اینترنت**: اپ به‌طور ساختاری آفلاین است.

A **native Android app** — Kotlin, Material XML views, a CameraX viewfinder with
per-frame analysis, MediaStore saving and FileProvider sharing. **No WebView, no
HTML, and no INTERNET permission**: the app is offline by construction.

---

## تازه در ۱٫۴٫۰ · New in 1.4.0

**دوزبانه با کلید درون‌اپ.** فارسی و انگلیسی هر دو داخل خود APK هستند و یک دکمهٔ
همیشگی در نوار بالا زبان را عوض می‌کند؛ انتخاب روی دستگاه می‌ماند (روی اندروید ۱۳+
از راه تنظیم زبان هر اپ، و روی نسخه‌های قدیمی‌تر با `AppCompatLocalesService`).

**اسکن از گالری.** دکمهٔ «گالری» در صفحهٔ اسکن یک تصویر ثابت را از photo picker
می‌خواند و با نمایهٔ کامل رمزگشایی می‌کند — بدون نیاز به اجازهٔ دوربین. این مسیرِ
مطمئنِ شناخت است: یک تصویر شارپ به‌جای جریان فریم‌های لرزیده.

**ساخت نماد سریع‌تر.** خودآزمایی پس از ساخت دیگر یک رمزگشایی تصویریِ کامل نیست؛
کدواژه‌ها مستقیم (Reed–Solomon + Golay + CRC) بازخوانی می‌شوند و برای نماد قفل‌شده
از استنتاج دومِ PBKDF2 صرف‌نظر می‌شود. raster پیش‌فرض کوچک‌تر (scale 8) و VM هنگام
راه‌اندازی اپ پیش‌گرم می‌شود. دکمهٔ «خودآزمایی تصویری» همان بررسی کامل را در صورت
خواست کاربر اجرا می‌کند.

**دوربین زنده‌تر.** یک خط وضعیت زمان و دندان‌های قفل‌شدهٔ هر تلاش را نشان می‌دهد تا
پنل هرگز «یخ‌زده» به نظر نرسد؛ ضربه روی پیش‌نمایش فوکوس را به همان نقطه می‌برد.

**ظاهر تمیزتر به‌صورت پیش‌فرض.** جوهر (سیاه روی سفید) + سلول مربعی + حاشیهٔ آرامِ
۴ ماژولی — کنتراست و سادگی‌ای که بهترین اسکن را می‌دهد؛ پالت‌های تزئینی یک ضربه
فاصله دارند.

**Bilingual with an in-app switch.** Persian and English both ship in the APK and
an always-visible toolbar button flips between them; the choice persists (per-app
language on Android 13+, `AppCompatLocalesService` below).

**Scan from gallery.** The scan panel's "Gallery" button reads a still image
through the photo picker and decodes it with the full profile — no camera
permission needed. This is the reliable recognition path: one sharp image instead
of a stream of motion-blurred frames.

**Faster symbol creation.** The post-encode self-test is now bit-level
(Reed–Solomon + Golay + CRC read straight back) instead of a second full imaging
decode, and sealed symbols skip the duplicate PBKDF2 derivation. The default
raster is smaller (scale 8) and the VM is warmed at app start. A "Verify by
image" button still runs the thorough imaging read on demand.

**A livelier camera.** A status line reports each attempt's time and locked-teeth
count so the panel never looks frozen, and tapping the preview drives autofocus to
that point.

**Cleaner look by default.** Ink (black on white) + square modules + a 4-module
quiet zone — the highest-contrast, simplest scan; ornate palettes remain one tap
away.

> **صداقت دربارهٔ سرعت · Honesty about speed.** موتور همان هستهٔ TypeScript در
> QuickJS است (بدون JIT). رمزگشایی تمیز روی Node با JIT ≈ ۳۰–۴۰۰ ms است و روی
> مفسرِ گوشی چند برابر آن؛ پس «صدم ثانیه مثل QR» با این موتور شدنی نیست — رسیدن به
> آن نیازمند بازنویسی بومی (Kotlin/C++) لولهٔ رمزگشایی است که در نقشهٔ راه
> (`docs/04-ROADMAP.md`) به‌صورت صریح آمده است. آنچه ۱٫۴٫۰ تحویل می‌دهد حذف کارهای
> زائد (base64 خطی، خودآزمایی تصویریِ دوم، raster بزرگ) و مسیر مطمئن گالری است.

---

## معماری · Architecture

```
┌────────────────────────────  APK  ────────────────────────────┐
│  Kotlin (native)                                              │
│    MainActivity ── CreateController      ScanController       │
│      Material views    │                    │ CameraX         │
│      MediaStore/share  │                    │ YUV → grayscale │
│      SecureRandom ─────┤                    │ Base64 ─────────┤
│                        ▼                    ▼                 │
│    Engine.kt  ── one JNI bridge ──►  QuickJS VM (embedded)    │
│      SimurghEngine.call(requestJson) -> responseJson          │
│                        │                                      │
│    assets/engine.js    ▼                                      │
│      the TypeScript core: geometry, Format Crown, Golay(24,12),│
│      Reed–Solomon, DEFLATE, ChaCha20-Poly1305, PBKDF2, the     │
│      whole imaging pipeline — the *same* source the 161        │
│      repository test suites exercise.                          │
└────────────────────────────────────────────────────────────────┘
```

**چرا موتور در QuickJS؟** دو گزینه بود: بازنویسی ~۵۰۰۰ خط لولهٔ تصویربرداری به
کاتلین (که بدون دستگاه/امولاتور قابل‌تأیید نبود و از مرجع واگرا می‌شد)، یا اجرای
**همان هستهٔ TypeScript** در یک ماشین‌مجازی نهفته. گزینهٔ دوم انتخاب شد: کدِ روی
تلفن **بیت‌به‌بیت** همان کد مرجع است، و آزمون‌های JVM در CI همین بستهٔ ارسالی را
در یک QuickJS واقعی با بردارهای دیفرانسیل تولیدشده از هستهٔ TS مقایسه می‌کنند.
هزینهٔ صادقانهٔ آن: تفسیر JS از کد بومی کندتر است (رمزگشایی تمیز ≈ صدها
میلی‌ثانیه؛ PBKDF2 با ۲۱۰٬۰۰۰ تکرار روی تلفن چند ثانیه — به همین دلیل شمار
تکرار در رابط ساخت قابل تنظیم است).

**Why is the engine in QuickJS?** The alternative was porting ~5,000 lines of
imaging pipeline to Kotlin — unverifiable without a device and guaranteed to drift
from the reference. Instead the phone runs the *same* TypeScript core inside an
embedded VM, bit-identical to what the 161 test suites exercise, and CI proves it:
JVM unit tests execute the shipped `assets/engine.js` in a real QuickJS runtime
against differential vectors generated from the TS core. The honest cost: interpreted
JS is slower than native code (clean decodes ≈ hundreds of milliseconds; PBKDF2 at
210,000 iterations takes seconds on a phone — which is why the create panel lets you
choose the iteration count).

نکتهٔ امنیتی: QuickJS هیچ CSPRNG ندارد. نمک (۱۶ بایت) و نانس (۱۲ بایت) پاکت
SECURE را **کاتلین با `SecureRandom` می‌سازد** و صریح به موتور می‌دهد؛
`Math.random` هرگز به پاکت نزدیک نمی‌شود.

Security note: QuickJS has no CSPRNG. Kotlin draws the SECURE envelope's salt
(16 B) and nonce (12 B) with `SecureRandom` and passes them in explicitly;
`Math.random` never touches an envelope.

## پل · The bridge

یک ورودی، JSON در هر دو جهت — کوچک‌ترین سطح JNI ممکن:

One entry point, JSON both directions — the smallest possible JNI surface:

| `op` | ورودی · in | خروجی · out |
|---|---|---|
| `encode` | `text`/`url`/`dataHex`/`geo`, `ecc`, `theme`, `shape`, `scale`, `secure{pass,iterations,saltHex,nonceHex,context}` | `version,ecc,mask,cells,payloadBytes,codewords,blocks,formatWord,dataBitsHex,beadsHex,inkCoverage,segments,secure{keyId,ciphertextHex,…},raster{width,height,rgbaB64},svg?` |
| `decode` | `grayB64`/`rgbaB64` + `width/height`, `pass`/`keyHex`/`context`, `fast` | `ok,ms,text,encrypted,unlocked,secureInfo,segments,diag{teeth,crown,confidence,rotationDeg,inverted,erasures,errorsFixed,crc,…}` |
| `themes` | — | هشت پالت با کنتراست اندازه‌گیری‌شده · the eight palettes with measured contrast |
| `spec` | — | `name,id,version,date` (1.1.0 / 2026-10-29) |
| `decodeBits` | `dataBitsHex,beadsHex,secureJson?` | decode سطح بیت، برای آزمون‌ها · bit-level decode, used by tests |

## ساخت · Building

APK در **GitHub Actions** ساخته می‌شود (`.github/workflows/android.yml`): در هر
پوش، هستهٔ TS تست می‌شود (۱۶۱ آزمون)، بستهٔ موتور و بردارها بازتولید و تازه‌بودن
آن‌ها با `git diff` اثبات می‌شود، پروتکل موتور در Node بررسی می‌شود (۳۹ بررسی، شامل هم‌ارزی polyfill با TextEncoder بومی)،
سپس Gradle آزمون‌های JVM را در QuickJS واقعی اجرا کرده و
**`app-debug.apk`** را به‌عنوان artifact آپلود می‌کند
(`simurgh-android-debug-apk` در صفحهٔ run).

The APK is built by **GitHub Actions** (`.github/workflows/android.yml`): every push
runs the TS suites (161 tests), regenerates the engine bundle and vectors and proves
the committed copies are fresh (`git diff --exit-code`), gates the engine protocol in
Node (39 checks, incl. polyfill parity with the native TextEncoder), then runs the JVM tests inside a real QuickJS runtime and uploads
**`app-debug.apk`** as the `simurgh-android-debug-apk` artifact on the run page.

محلی (نیاز به JDK 21، Android SDK 36، Gradle 9.7.1 و Node 22): · Locally (JDK 21,
Android SDK 36, Gradle 9.7.1, Node 22):

```sh
npm ci && npm run build          # در ریشهٔ مخزن · at the repo root
node tools/build-engine.mjs      # assets/engine.js
node tools/gen-android-vectors.mjs
cd apps/android
gradle testDebugUnitTest assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

این مخزن عمدی **Gradle wrapper ندارد** (در محیط توسعه، دسترسی به
services.gradle.org نبود)؛ CI از `gradle/actions/setup-gradle` با نسخهٔ سنجاق‌شدهٔ
9.7.1 استفاده می‌کند. در Android Studio هم پروژه مستقیماً باز می‌شود.

There is deliberately **no Gradle wrapper** in the repo (the authoring sandbox could
not reach services.gradle.org); CI pins Gradle 9.7.1 through
`gradle/actions/setup-gradle`. Android Studio opens the project directly.

## سازگاری و دانلود · Compatibility & download

**یک APK برای همه‌چیز.** بستهٔ debug یک APK جهان‌شمول (universal) است که کتابخانهٔ
بومی QuickJS را برای **هر چهار معماری پردازندهٔ گوشی** همراه دارد:
`armeabi-v7a` (ARM ۳۲بیتی)، `arm64-v8a` (ARM ۶۴بیتی)، `x86` و `x86_64`. هیچ
`abiFilters`ی تنظیم نشده و یک گام CI داخل APK را با `unzip` می‌کاود و اگر هر چهار
معماری حاضر نباشند، بیلد را **قرمز** می‌کند.

**از اندروید ۶ تا آخرین نسخه.** `minSdk = 23` (اندروید ۶٫۰ Marshmallow، ۲۰۱۵) تا
`targetSdk = 36`. پوشش: بیش از یک دهه دستگاه. این کفِ ممکن است — متادیتای AAR
کتابخانهٔ quickjs-kt به ۲۳ نیاز دارد (CameraX به ۲۱، Material به ۲۱) و
manifest-merger هر عدد پایین‌تر را رد می‌کند؛ بنابراین «قدیمی‌تر از اندروید ۶» با
این موتور شدنی نیست و صادقانه گفته می‌شود.

**در Releases.** هر بیلد روی شاخهٔ `main` به‌طور خودکار در **GitHub Releases**
منتشر می‌شود: یک ریلیز نسخه‌دار `v<version>-android` و یک ریلیز چرخان `latest`
(همیشه تازه‌ترین APK). فایل‌ها: `SiMurgh-Code-<version>.apk` و
`SiMurgh-Code-latest.apk` — بدون نیاز به ورود به صفحهٔ Actions قابل دانلودند.

**One APK for everything.** The debug build is a *universal* APK carrying the
QuickJS native library for **all four phone CPU architectures**: `armeabi-v7a`
(32-bit ARM), `arm64-v8a` (64-bit ARM), `x86` and `x86_64`. No `abiFilters` is
set, and a CI step unzips the built APK and **fails the build** unless all four
are present.

**Android 6 through the newest release.** `minSdk = 23` (Android 6.0 Marshmallow,
2015) up to `targetSdk = 36` — more than a decade of devices. This is the lowest
achievable floor: the quickjs-kt AAR metadata requires 23 (CameraX needs 21,
Material 21), and the manifest merger rejects anything lower, so "older than
Android 6" is not possible with this engine and is stated plainly rather than
papered over.

**In Releases.** Every build on the `main` branch is published to **GitHub
Releases** automatically: a versioned `v<version>-android` release and a rolling
`latest` release (always the newest APK). Assets `SiMurgh-Code-<version>.apk` and
`SiMurgh-Code-latest.apk` are downloadable without signing in to the Actions page.

## آزمون‌ها · Tests

`EngineVectorsTest` (JVM، بدون دستگاه) همان `engine.js` ارسالی را در QuickJS اجرا
می‌کند و با `vectors.json` + تصاویر PGM که `tools/gen-android-vectors.mjs` از هستهٔ
مرجع می‌گیرد مقایسه می‌کند:

1. `specIsFrozen` — نام/شناسه/نسخهٔ مشخصات.
2. `themesAreCompleteAndPrintSafe` — ۸ پالت، کنتراست ≥ 7، print-safe.
3. `encodeMatchesReferenceBitForBit` — ۶ بارِ مفید (فارسی/URL/دودویی/geo):
   `dataBits`، مهره‌های تاج، `formatWord`، ماسک، نسخه، بایت‌ها، کدواژه‌ها.
4. `decodeBitsRoundTripsEveryVector` — مسیر سطح بیت + CRC.
5. `sealedEnvelopesMatchReference` — `keyId` و **متن رمزشده** پاکت‌های ثابت
   بازتولیدپذیر؛ بازشدن با کلید، قفل‌ماندن بدون کلید و با کلید غلط.
6. `renderedImagesDecode` — سه تصویر رندرشده (جوهر/وارونِ شب/لاجورد): متن،
   دندان ۶۳/۶۳، نسخه، پرچم وارونگی، CRC.
7. `persianQuotesAndNewlinesSurviveTheBridge` — فرار از JS-string + مسیر یونیکد JNI.
8. `garbageIsRejectedCleanly` — ورودی زباله، op ناشناخته، secure بدون کلید.

## فایل‌ها · Files

```
app/src/main/java/code/simurgh/scanner/
  Engine.kt            میزبان QuickJS + پل JSON + SecureRandom
  MainActivity.kt      یک اکتیویتی بومی، دو پنل
  CreateController.kt  ساخت نماد + خودآزمایی بازخوانی + ذخیره/هم‌رسانی
  ScanController.kt    CameraX: پیش‌نمایش، تحلیل فریم، قفل‌گشایی
  Yuv.kt               YUV_420_888 → خاکستری راست‌گرد + کوچک‌سازی جعبه‌ای
  Bitmaps.kt           RGBA → Bitmap، PNG، MediaStore، FileProvider
app/src/main/assets/engine.js      بستهٔ موتور (۱۸۳ KiB، esbuild IIFE، es2019)
app/src/test/resources/            vectors.json + سه PGM مرجع
scripts/make-android-icons.mjs     آیکون‌های لانچر — خودِ نماد v3 اسکن‌شدنی
```

آیکون لانچر یک **نماد سیمرغ واقعی (v3/M)** با `https://simurgh.code` است؛ اسکریپت
پس از تولید، نسخهٔ xxxhdpi را با لولهٔ تصویربرداری بازخوانی می‌کند و در صورت
شکست، خروجی ۱ می‌دهد.

The launcher icon is a real scannable v3 symbol; the generator re-decodes the
xxxhdpi tile through the imaging pipeline and fails if it ever stops scanning.
