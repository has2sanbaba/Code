/**
 * ============================================================================
 *  COLOUR THEMES -- and the contrast arithmetic that keeps them scannable
 * ============================================================================
 *
 * A SiMurgh symbol is read from a photograph by thresholding luminance, so a
 * pretty palette is only allowed if it survives that threshold. Every theme here
 * is therefore specified together with its own contrast ratio, computed the way
 * WCAG 2.1 does (relative luminance of linearised sRGB channels):
 *
 *      L = 0.2126 R + 0.7152 G + 0.0722 B      R,G,B linearised
 *      ratio = (L_light + 0.05) / (L_dark + 0.05)
 *
 * The reader's own measurements set the bar: Otsu's method finds a clean split
 * when the two populations are far apart, and the imaging tests pass from
 * ratio ~7 upwards even after JPEG noise, blur and 25 degrees of perspective.
 * Below ~4.5 a printed symbol starts to fail on glossy paper, so
 * {@link themeContrast} reports a verdict rather than a bare number.
 *
 * All of this is about *ink on paper*. The geometry -- radii, tooth angles, bead
 * positions -- is untouched by colour, which is what makes theming safe at all.
 */

export interface SmcTheme {
  /** Stable identifier, used by the CLI, the playground and the mobile app. */
  id: string;
  /** Persian label, for RTL user interfaces. */
  fa: string;
  /** English label. */
  en: string;
  /** Data modules and core. */
  ink: string;
  /** Format Crown: limbus, halo, angle-track teeth and the 24 beads. */
  crown: string;
  /** Substrate. */
  paper: string;
  /** Caption text; defaults to `ink`. */
  caption?: string;
}

/**
 * Built-in palettes, drawn from Persian manuscript and tilework colours: lapis
 * lazuli, turquoise (فیروزه‌ای), saffron, rosewater, pistachio, pomegranate and
 * a night variant for dark user interfaces. Each is checked at module load time
 * by `THEME_CONTRAST`, so a future edit that drops one below the floor fails the
 * test suite instead of shipping an unscannable symbol.
 */
export const THEMES: Record<string, SmcTheme> = {
  ink: { id: 'ink', fa: 'مرکاب', en: 'Ink on paper', ink: '#111418', crown: '#111418', paper: '#ffffff' },
  lapis: { id: 'lapis', fa: 'لاجورد', en: 'Lapis lazuli', ink: '#123a72', crown: '#0d2a55', paper: '#f7f3e6' },
  turquoise: { id: 'turquoise', fa: 'فیروزه‌ای', en: 'Turquoise', ink: '#0b5d5f', crown: '#083f45', paper: '#fbf8ef' },
  saffron: { id: 'saffron', fa: 'زعفران', en: 'Saffron', ink: '#6b3a06', crown: '#4d2803', paper: '#fff8e6' },
  rosewater: { id: 'rosewater', fa: 'گلاب', en: 'Rosewater', ink: '#7d2340', crown: '#5c1730', paper: '#fdf2f5' },
  pistachio: { id: 'pistachio', fa: 'پسته‌ای', en: 'Pistachio', ink: '#2f4f16', crown: '#22390f', paper: '#f7f8ef' },
  pomegranate: { id: 'pomegranate', fa: 'انار', en: 'Pomegranate', ink: '#6d0f1c', crown: '#4c0912', paper: '#fff5f2' },
  night: { id: 'night', fa: 'شب', en: 'Night (screen only)', ink: '#e9d9a5', crown: '#f3e6bd', paper: '#0e1116' },
};

export const THEME_IDS = Object.keys(THEMES);

/** Minimum contrast ratio for a theme intended to be printed and photographed. */
export const PRINT_CONTRAST_FLOOR = 7;
/** Below this a symbol is decorative only: it will not survive a phone camera. */
export const SCAN_CONTRAST_FLOOR = 4.5;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into 0..255 channels. */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, '');
  const expand = (c: string) => parseInt(c + c, 16);
  if (h.length === 3) return [expand(h[0]!), expand(h[1]!), expand(h[2]!)];
  if (h.length === 6 || h.length === 8) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  throw new RangeError(`not a hex colour: ${hex}`);
}

/** WCAG 2.1 relative luminance of an sRGB colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => v / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export interface ThemeContrast {
  ink: number;
  crown: number;
  /** The worse of the two -- this is the number that decides scannability. */
  worst: number;
  printable: boolean;
  scannable: boolean;
  verdict: string;
}

/** Report a theme's contrast against its own paper. */
export function themeContrast(theme: SmcTheme): ThemeContrast {
  const ink = contrastRatio(theme.ink, theme.paper);
  const crown = contrastRatio(theme.crown, theme.paper);
  const worst = Math.min(ink, crown);
  const printable = worst >= PRINT_CONTRAST_FLOOR;
  const scannable = worst >= SCAN_CONTRAST_FLOOR;
  const verdict = printable
    ? 'print-safe'
    : scannable
      ? 'screen-safe only: below the 7:1 print floor'
      : 'unscannable: below 4.5:1, a camera will not reliably threshold this';
  return { ink, crown, worst, printable, scannable, verdict };
}

/** Contrast of every built-in theme, keyed by theme id. */
export const THEME_CONTRAST: Record<string, ThemeContrast> = Object.fromEntries(
  Object.values(THEMES).map((t) => [t.id, themeContrast(t)]),
);

/** Accept a theme id or an inline theme object; unknown ids throw. */
export function resolveTheme(theme?: string | SmcTheme): SmcTheme {
  if (!theme) return THEMES.ink!;
  if (typeof theme !== 'string') return theme;
  const t = THEMES[theme];
  if (!t) throw new RangeError(`unknown theme '${theme}' (try: ${THEME_IDS.join(', ')})`);
  return t;
}

/**
 * Mix two hex colours, t = 0 -> a, t = 1 -> b. Used by the rasteriser to give a
 * themed symbol a soft edge instead of a hard aliased one.
 */
export function mixHex(a: string, b: string, t: number): [number, number, number] {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const k = clamp01(t);
  return [
    Math.round(ar + (br - ar) * k),
    Math.round(ag + (bg - ag) * k),
    Math.round(ab + (bb - ab) * k),
  ];
}
