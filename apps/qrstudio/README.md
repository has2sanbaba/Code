# آرت کیوآر · ArtQR

یک اپ بومی اندروید برای ساخت **کد‌های QR گرافیکی و زیبا** — رنگی، گرادیان، ماژول‌های
گرد/نقطه‌ای، موزاییک رنگ از یک عکس، و عکس/نقاشی به‌صورت نشان در مرکز — که **در همهٔ
اسکنرهای استاندارد QR قابل اسکن می‌مانند**.

A native Android app that creates **graphical, beautiful QR codes** — coloured,
gradient, rounded/dot modules, a photo-coloured mosaic, or a photo/painting as a
centre emblem — that **stay scannable by every standard QR scanner**.

---

## چگونه «زیبا» و «قابل اسکن» با هم ممکن می‌شوند · How "beautiful" and "scannable" coexist

اسکنرها رنگ را نمی‌بینند؛ تصویر را خاکستری و سپس آستانه‌گذاری می‌کنند. پس تنها چیزی
که مهم است **اختلاف روشنایی** ماژول‌های تیره و زمینهٔ روشن است، نه رنگ. این اپ هر انتخاب
هنری را در زمان رندر به باندهای روشناییِ امن می‌برد و قوانین ISO/IEC 18004 را سخت
اعمال می‌کند:

Scanners do not see colour; they grayscale then threshold. So the only property
that matters is the **luminance gap** between dark modules and the light field —
not hue. The renderer clamps every artistic choice into safe lightness bands at
render time and hard-enforces the ISO/IEC 18004 rules:

| قانون · Rule | اجرای اپ · What the app does |
|---|---|
| کنتراست · Contrast | ماژول تیره ≤ L0.20 و زمینه ≥ L0.60 (نسبت ≥ ~7:1)؛ رنگPastel خودکار نجات می‌یابد |
| قطبیت · Polarity | فقط تیره-روی-روشن؛ هرگز معکوس نمی‌شود |
| حاشیهٔ آرام · Quiet zone | ≥ ۴ ماژول، رنگ روشن یکنواخت |
| الگوهای یابنده/زمان‌بندی · Finder/timing | هندس دست‌نخورده؛ فقط رنگ آزاد است |
| نشان مرکزی · Centre emblem | ≤ ۱۵٪ مساحت، روی پد روشن، با ECC H |
| سطح اصلاح خطا · ECC | پیش‌فرض H (۳۰٪ بازیابی) برای کارهای گرافیکی |

## تضمین اسکن‌پذیری · The scannability guarantee

- **رمزگذاری با ZXing** (`com.google.zxing:core`) — پیاده‌سازی مرجع ISO/IEC 18004 —
  پس لایهٔ داده دقیقاً مطابق استاندارد است.
- **خودآزمایی روی دستگاه:** هر رندر پیش از نمایش با همان ZXing دوباره رمزگشایی
  می‌شود؛ اپ «✓ قابل اسکن» یا «✗» را نشان می‌دهد.
- **آزمون CI:** `ArtScannabilityTest` هر سبک (کلاسیک، رنگی، گرادیان، نقطه، موزاییک
  عکس، نشان عکس، و ترکیب همه) را روی JVM رندر و با ZXing رمزگشایی می‌کند؛ سبک زیبا ولی
  ناخوانا = **شکست تست**، نه غافلگیری در چاپ.

- **Encoding uses ZXing** (the ISO reference implementation), so the data layer is
  spec-exact.
- **On-device self-test:** every render is decoded back with ZXing before it is
  shown; the app reports "✓ scannable" or "✗".
- **CI suite:** `ArtScannabilityTest` renders every style on a plain JVM and decodes
  it with ZXing; a pretty-but-unreadable style is a **test failure**, not a print-time
  surprise. The renderer is pure Kotlin over `IntArray` (no Android types), which is
  why this runs with no emulator.

## ساخت و انتشار · Build & release

`.github/workflows/qrstudio.yml` با هر push می‌سازد: آزمون‌های JVM + `assembleDebug`،
آپلود APK، و روی شاخهٔ `main` انتشار در **GitHub Releases** با تگ‌های
`qrstudio-v<version>` و `qrstudio-latest` (جدا از ریلیزهای اپ دیگر). بدون Gradle
wrapper؛ CI گرادل 9.7.1 را پین می‌کند.

Built by `.github/workflows/qrstudio.yml` on every push: JVM tests + `assembleDebug`,
APK artifact, and on `main` a **GitHub Releases** publish under `qrstudio-v<version>`
and rolling `qrstudio-latest` (kept separate from the sibling app's releases). No
Gradle wrapper; CI pins Gradle 9.7.1.
