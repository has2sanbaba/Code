/**
 * SiMurgh Code playground.
 *
 * Everything runs locally: encoding, rasterising, the whole imaging pipeline and
 * the DEFLATE codec are the same TypeScript modules the CLI uses, imported
 * straight from `packages/core/src`. There is no server round trip and no build
 * artefact to go stale.
 */
import {
  AIM_PREFIX,
  ANGLE_TRACK,
  SPEC_DATE,
  SPEC_VERSION,
  SYMBOLOGY_ID,
  SYMBOLOGY_NAME,
  capacityTable,
  crown,
  encode,
  getLattice,
  payloadToText,
  toModel,
  unpackFormat,
  type EccLevel,
  type EncodeOptions,
  type EncodedSymbol,
  type Segment,
} from '@simurgh/core';
import { renderRaster, renderSVG } from '@simurgh/core/render';
import {
  blur,
  contrast,
  decodeImage,
  decodeRGBA,
  noise,
  occlude,
  perspective,
  resample,
  rotate,
  type GrayImage,
} from '@simurgh/core/imaging';

/* ------------------------------------------------------------------ helpers */

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}
function num(id: string): number {
  return Number(byId<HTMLInputElement>(id).value);
}
function txt(id: string): string {
  return byId<HTMLInputElement>(id).value;
}
function show(id: string, value: string): void {
  byId(id).textContent = value;
}
/** Persian digits for prose, ASCII digits inside monospace technical output. */
function fa(n: number | string): string {
  return String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] as string);
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function grayToCanvas(img: GrayImage, canvas: HTMLCanvasElement): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const out = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i] as number;
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function segmentSummary(segments: Segment[]): string {
  return segments
    .map((s) => {
      switch (s.kind) {
        case 'byte':
          return `BYTE(${s.value.length})`;
        case 'geo':
          return `GEO(${s.value.lat},${s.value.lon})`;
        case 'frame':
          return `FRAME(${s.index + 1}/${s.count})`;
        case 'mac':
          return `MAC(${s.value.length})`;
        case 'signature':
          return `SIGNATURE(${s.value.length})`;
        case 'vendor':
          return `VENDOR(${s.id})`;
        default:
          return `${s.kind.toUpperCase()}(${s.value.length})`;
      }
    })
    .join(' + ');
}

function trackHex(): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const t of ANGLE_TRACK) {
    acc = (acc << 1) | (t ? 1 : 0);
    if (++bits === 4) {
      out += acc.toString(16).toUpperCase();
      acc = 0;
      bits = 0;
    }
  }
  if (bits) out += (acc << (4 - bits)).toString(16).toUpperCase();
  return out;
}

/* -------------------------------------------------------------------- state */

let current: EncodedSymbol | null = null;
let currentOptions: EncodeOptions = {};
let currentText = '';
let labImage: GrayImage | null = null;

function readPayload(): EncodeOptions {
  const raw = txt('payload');
  if (raw.startsWith('hex:')) {
    const body = raw.slice(4).replace(/\s+/g, '');
    const bytes = new Uint8Array(Math.floor(body.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.substr(i * 2, 2), 16) || 0;
    return { data: bytes };
  }
  if (raw.startsWith('b64:')) {
    const bin = atob(raw.slice(4).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { data: bytes };
  }
  const trimmed = raw.trim();
  // A URL goes through URL mode: a hostname costs 5.29 bits per character there
  // against 8 in TEXT mode, which is often a whole version of the disc.
  return /^https?:\/\//i.test(trimmed) ? { url: trimmed } : { text: raw };
}

function currentEncodeOptions(eccOverride?: EccLevel): EncodeOptions {
  const versionSel = txt('version');
  const maskSel = txt('mask');
  return {
    ...readPayload(),
    ecc: eccOverride ?? (txt('ecc') as EccLevel),
    version: versionSel === 'auto' ? undefined : Number(versionSel),
    mask: maskSel === 'auto' ? undefined : Number(maskSel),
    compression: byId<HTMLInputElement>('compression').checked,
  };
}

function rebuild(): void {
  const errorEl = byId<HTMLParagraphElement>('encode-error');
  const options = currentEncodeOptions();
  try {
    const sym = encode(options);
    current = sym;
    currentOptions = options;
    currentText = options.text ?? options.url ?? `[${options.data?.length ?? 0} byte]`;
    errorEl.textContent = '';
    paintSymbol();
    labImage = buildLabImage();
    if (labImage) grayToCanvas(labImage, byId<HTMLCanvasElement>('lab-canvas'));
    byId('lab-result').innerHTML = '<p class="muted">تصویر آماده است؛ «اجرای رمزگشایی» را بزنید.</p>';
  } catch (e) {
    current = null;
    const err = e as { name?: string; message: string; neededBits?: number; availableBits?: number };
    errorEl.textContent =
      err.name === 'CapacityError' && err.neededBits !== undefined && err.availableBits !== undefined
        ? `ظرفیت کافی نیست: بار مفید ${fa(err.neededBits)} بیت است و ${fa(err.availableBits)} بیت جا دارد. سطح تصحیح خطا را کم کنید، نسخهٔ بزرگ‌تری انتخاب کنید، یا فشرده‌سازی را روشن بگذارید.`
        : `خطا: ${err.message}`;
    byId('stage').innerHTML = '';
    byId('stats').innerHTML = '';
    byId('record').textContent = '—';
  }
}

function symbolModel(sym: EncodedSymbol) {
  return toModel(sym, currentText.slice(0, 80));
}

function paintSymbol(): void {
  const sym = current;
  if (!sym) return;
  const shape = txt('shape') as 'dot' | 'hex' | 'square';
  const model = symbolModel(sym);

  const svg = renderSVG(model, { shape, scale: 12, unit: 'px', quiet: num('quiet'), caption: null, metadata: true });
  // The XML declaration is legal in a file but not inside an HTML document.
  byId('stage').innerHTML = svg.replace(/^<\?xml[^>]*\?>\s*/, '');

  const lat = getLattice(sym.version);
  const g = crown(lat.K);
  const stats: [string, string][] = [
    ['نسخه / K', `${fa(sym.version)} / ${fa(lat.K)}`],
    ['سلول‌های داده', fa(lat.N)],
    ['تصحیح خطا', sym.ecc],
    ['پوشش انتخاب‌شده', fa(sym.mask)],
    ['فشرده‌سازی', sym.compression === 1 ? 'DEFLATE روشن' : 'خاموش'],
    ['بار مفید', `${fa(sym.plan.payloadBytes)} بایت`],
    [
      'کدواژه‌ها',
      `${fa(sym.plan.codewords)} = ${fa(sym.plan.payloadBytes + 4)} داده + ${fa(sym.plan.parityCodewords)} افزونه`,
    ],
    ['بلوک درهم‌بسته', fa(sym.plan.blocks)],
    ['چگالی جوهر', `${fa((sym.inkCoverage * 100).toFixed(1))}٪`],
    ['قطر چاپ', `${fa(2 * lat.K + 10)} ماژول`],
    ['شعاع بوم', `${fa(g.canvasRadius)} ماژول`],
    ['بخش‌های بار', segmentSummary(sym.segments)],
    ['کلمهٔ قالب', sym.formatWord.toString(16).toUpperCase().padStart(6, '0')],
    ['۲۴ دانهٔ تاج', Array.from(sym.beads).join('')],
  ];
  byId('stats').innerHTML = stats
    .map(([k, v]) => `<div><dt>${k}</dt><dd class="mono">${v}</dd></div>`)
    .join('');

  byId('record').textContent = JSON.stringify(
    {
      symbology: SYMBOLOGY_NAME,
      id: SYMBOLOGY_ID,
      aimPrefix: AIM_PREFIX,
      specVersion: SPEC_VERSION,
      specDate: SPEC_DATE,
      version: sym.version,
      K: lat.K,
      cells: lat.N,
      ecc: sym.ecc,
      mask: sym.mask,
      compression: sym.compression === 1,
      format: unpackFormat(sym.formatBits),
      formatWord: `0x${sym.formatWord.toString(16).toUpperCase().padStart(6, '0')}`,
      maskScores: sym.maskScores.map((s) => Number(s.toFixed(1))),
      inkCoverage: Number(sym.inkCoverage.toFixed(4)),
      plan: {
        userPayloadBytes: sym.plan.payloadBytes,
        dataCodewords: sym.plan.payloadBytes + 4,
        parityCodewords: sym.plan.parityCodewords,
        codewords: sym.plan.codewords,
        blocks: sym.plan.blocks,
      },
      crown: {
        halo: [g.haloInner, g.haloOuter],
        beads: g.beadRadius,
        teeth: [g.teethInner, g.teethOuter],
        beak: g.beakRadius,
        limbus: [g.limbusInner, g.limbusOuter],
        outer: g.outerRadius,
        quietZone: g.quietZone,
        canvas: g.canvasRadius,
      },
      angleTrack: Array.from(ANGLE_TRACK).join(''),
      angleTrackHex: `0x${trackHex()}`,
      teeth: Array.from(sym.teeth).join(''),
      beads: Array.from(sym.beads).join(''),
      payloadText: currentText,
    },
    null,
    2,
  );
}

/* ---------------------------------------------------------------------- lab */

function buildLabImage(): GrayImage | null {
  if (!currentOptions.data && !currentOptions.text && !currentOptions.url) return null;
  const ecc = txt('lab-ecc') as EccLevel;
  /*
   * Re-encode at the ECC level the lab is set to. Comparing four readings of one
   * symbol would prove nothing about the ladder; the point of the slider is that
   * the *same payload* survives more damage as parity grows, and that costs cells.
   */
  const sym = encode({ ...currentOptions, ecc, version: undefined, mask: undefined });
  const model = toModel(sym, (sym.segments.length ? currentText : 'lab').slice(0, 80));
  return renderRaster(model, { scale: 10, shape: txt('shape') as 'dot' | 'hex' | 'square', quiet: 2.5 });
}

function runLab(): void {
  const out = byId<HTMLDivElement>('lab-result');
  const base = buildLabImage();
  if (!base) {
    out.innerHTML = '<p class="muted">ابتدا یک نماد بسازید.</p>';
    return;
  }
  out.innerHTML = '<p class="muted">در حال اجرا…</p>';

  // Let the browser paint the busy state before the heavy work starts.
  setTimeout(() => {
    const rot = num('rot');
    const tilt = num('tilt');
    const sigma = num('noise');
    const blurR = num('blur');
    const hole = num('hole');
    const res = num('res');
    const fade = num('fade');

    let img = base;
    if (rot) img = rotate(img, rot);
    if (tilt) img = perspective(img, tilt, -tilt * 0.6);
    if (blurR) img = blur(img, blurR);
    // contrast() maps [lo, hi] onto [0, 255]; widening the window past both ends
    // is what a faded, washed-out scan looks like.
    if (fade) img = contrast(img, -fade * 2, 255 + fade * 2);
    if (sigma) img = noise(img, sigma, 7);
    if (hole) img = occlude(img, [{ fx: 0.5, fy: 0.5, fr: hole / 100, feather: 3 }]);
    if (res) img = resample(img, res);

    labImage = img;
    grayToCanvas(img, byId<HTMLCanvasElement>('lab-canvas'));

    const t0 = performance.now();
    const result = decodeImage(img);
    const ms = performance.now() - t0;

    if (!result.ok) {
      out.innerHTML =
        `<p class="bad">✗ رمزگشایی ناموفق — <span class="mono" dir="ltr">${escapeHtml(result.error ?? 'unknown')}</span></p>` +
        diagTable(result, ms, img);
      return;
    }
    const text = payloadToText(result.payload!);
    out.innerHTML =
      `<p class="good">✓ رمزگشایی شد در ${fa(ms.toFixed(0))} میلی‌ثانیه</p>` +
      `<p class="decoded mono" dir="auto">${escapeHtml(text)}</p>` +
      diagTable(result, ms, img);
  }, 30);
}

function diagTable(result: ReturnType<typeof decodeImage>, ms: number, img: GrayImage): string {
  const d = result.diagnostics;
  const rows: [string, string][] = [
    ['ابعاد تصویر', `${img.width}×${img.height} px`],
    ['نسخهٔ مکان‌یابی‌شده', `v${d.locatedVersion}`],
    ['گام', `${d.pitch.toFixed(2)} px/ماژول`],
    ['چرخش بازیافتشده', `${d.rotationDeg.toFixed(2)}°`],
    ['برازش هندسی', `${d.transformKind}, rms=${d.transformRms.toFixed(3)}`],
    ['دندان‌های همسان', `${d.teethMatches}/63`],
    ['تاج قالب', d.crownOk ? `خوانده شد (فاصلهٔ گولی ${d.golayDistance})` : 'بازجویی شد'],
    [
      'قالب',
      d.format ? `v${d.format.version + 1} ECC=${d.format.ecc} mask=${d.format.mask} compr=${d.format.compression}` : '—',
    ],
    ['میانگین اعتماد', d.meanConfidence.toFixed(3)],
    [
      'سلول‌های محو',
      `${d.erasureCells} (بذر ${d.maskPriorSeeds}، با همسایه‌ها ${d.maskPriorFlagged})`,
    ],
    ['تلاش‌های قالب', `${d.attempts}`],
    ['CRC-32', result.stats?.crcOk ? 'سالم' : 'ناموفق'],
    ['خطاهای اصلاح‌شده', `${result.stats?.errorsFixed ?? 0} کدواژه`],
    ['زمان', `${ms.toFixed(0)} ms`],
  ];
  return `<dl class="diag">${rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd class="mono" dir="ltr">${escapeHtml(v)}</dd></div>`)
    .join('')}</dl>`;
}

/* ------------------------------------------------------------------- upload */

async function decodeFile(file: File): Promise<void> {
  const out = byId<HTMLDivElement>('file-result');
  out.innerHTML = '<p class="muted">در حال خواندن تصویر…</p>';
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = byId<HTMLCanvasElement>('upload-canvas');
    canvas.hidden = false;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const shot = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();

    const t0 = performance.now();
    const result = decodeRGBA(shot.data, shot.width, shot.height);
    const ms = performance.now() - t0;
    const shape = { width: shot.width, height: shot.height, data: new Uint8Array(0) };

    if (!result.ok) {
      out.innerHTML =
        `<p class="bad">✗ ${escapeHtml(result.error ?? 'failed')}</p>` + diagTable(result, ms, shape);
      return;
    }
    const text = payloadToText(result.payload!);
    out.innerHTML = byId<HTMLInputElement>('file-json').checked
      ? `<pre class="mono scroll" dir="ltr">${escapeHtml(
          JSON.stringify(
            {
              ok: true,
              aimPrefix: AIM_PREFIX,
              version: result.version,
              ecc: result.ecc,
              mask: result.mask,
              compressed: result.compression === 1,
              segments: result.payload!.segments.map((s) => (s.kind === 'byte' ? { kind: s.kind, bytes: s.value.length } : s)),
              text,
              diagnostics: result.diagnostics,
            },
            null,
            2,
          ),
        )}</pre>`
      : `<p class="good">✓ رمزگشایی شد در ${fa(ms.toFixed(0))} میلی‌ثانیه</p>` +
        `<p class="decoded mono" dir="auto">${escapeHtml(text)}</p>` +
        diagTable(result, ms, shape);
  } catch (e) {
    out.innerHTML = `<p class="bad">✗ ${escapeHtml((e as Error).message)}</p>`;
  }
}

/* ------------------------------------------------------------------- tables */

function fillCapacityTable(): void {
  const body = byId<HTMLTableElement>('capacity-table').tBodies[0];
  if (!body) return;
  body.innerHTML = capacityTable()
    .map((row) => {
      const K = 2 * row.version + 12;
      return (
        `<tr${row.version === 1 ? ' class="hl"' : ''}><td>${fa(row.version)}</td><td>${fa(K)}</td>` +
        `<td>${fa(row.modules)}</td><td>${fa(row.cells)}</td>` +
        `<td>${fa(row.perEcc.L.payloadBytes)}</td><td>${fa(row.perEcc.M.payloadBytes)}</td>` +
        `<td>${fa(row.perEcc.Q.payloadBytes)}</td><td>${fa(row.perEcc.H.payloadBytes)}</td></tr>`
      );
    })
    .join('');
}

function fillVersionSelect(): void {
  const sel = byId<HTMLSelectElement>('version');
  for (let v = 1; v <= 40; v++) {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = `${v} — ${getLattice(v).N} سلول`;
    sel.appendChild(opt);
  }
}

/* --------------------------------------------------------------------- boot */

const LAB_SLIDERS: [string, string][] = [
  ['rot', 'rot-value'],
  ['tilt', 'tilt-value'],
  ['noise', 'noise-value'],
  ['blur', 'blur-value'],
  ['hole', 'hole-value'],
  ['res', 'res-value'],
  ['fade', 'fade-value'],
];

/**
 * Preset damage scenarios, each of which the pipeline is measured to survive
 * (except `brutal`, which is there to show the boundary honestly: fade plus
 * heavy noise plus a hole plus perspective is past the code's reach at level M).
 */
const PRESETS: Record<string, Record<string, number>> = {
  clean: {},
  rot: { rot: 37 },
  persp: { tilt: 25 },
  hole: { hole: 12 },
  fade: { fade: 50, noise: 10 },
  lowres: { res: 120 },
  combined: { rot: 22, tilt: 18, blur: 1, noise: 10, hole: 6 },
  brutal: { rot: 22, tilt: 25, blur: 1.5, fade: 60, noise: 16, hole: 12, res: 300 },
};

function applyPreset(name: string): void {
  const values = PRESETS[name] ?? {};
  for (const [id, label] of LAB_SLIDERS) {
    const v = values[id] ?? 0;
    byId<HTMLInputElement>(id).value = String(v);
    show(label, fa(v));
  }
  runLab();
}

function wire(): void {
  show('spec-version', `${SPEC_VERSION} (${SPEC_DATE})`);
  show('aim-prefix', AIM_PREFIX);
  show('symbology-id', SYMBOLOGY_ID);
  show('footer-name', SYMBOLOGY_NAME);
  show('footer-version', SPEC_VERSION);

  fillVersionSelect();
  fillCapacityTable();

  for (const id of ['payload', 'ecc', 'version', 'mask', 'shape', 'compression', 'quiet']) {
    byId<HTMLInputElement>(id).addEventListener('input', () => {
      if (id === 'quiet') show('quiet-value', fa(txt('quiet')));
      rebuild();
    });
  }
  byId<HTMLInputElement>('scale').addEventListener('input', () => show('scale-value', fa(txt('scale'))));

  for (const chip of document.querySelectorAll<HTMLButtonElement>('.chip[data-sample]')) {
    chip.addEventListener('click', () => {
      byId<HTMLTextAreaElement>('payload').value = chip.dataset.sample ?? '';
      rebuild();
    });
  }

  byId('sample-binary').addEventListener('click', () => {
    // A deterministic pseudo-random blob: incompressible, so it shows what the
    // symbology costs when DEFLATE has nothing at all to work with.
    const bytes = new Uint8Array(220);
    let s = 0x9e3779b9;
    for (let i = 0; i < bytes.length; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      bytes[i] = s & 0xff;
    }
    byId<HTMLTextAreaElement>('payload').value = `hex:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    rebuild();
  });

  byId('render').addEventListener('click', rebuild);

  byId('download-svg').addEventListener('click', () => {
    if (!current) return;
    const svg = renderSVG(symbolModel(current), {
      shape: txt('shape') as 'dot' | 'hex' | 'square',
      scale: 0.6,
      unit: 'mm',
      quiet: num('quiet'),
      caption: currentText.slice(0, 96),
    });
    download(`simurgh-v${current.version}-${current.ecc}.svg`, svg, 'image/svg+xml');
  });

  byId('download-png').addEventListener('click', () => {
    if (!current) return;
    const scale = num('scale');
    const img = renderRaster(symbolModel(current), {
      scale,
      shape: txt('shape') as 'dot' | 'hex' | 'square',
      quiet: num('quiet'),
    });
    const canvas = document.createElement('canvas');
    grayToCanvas(img, canvas);
    canvas.toBlob((blob) => {
      if (blob) download(`simurgh-v${current!.version}-${current!.ecc}-${scale}px.png`, blob, 'image/png');
    }, 'image/png');
  });

  byId('copy-json').addEventListener('click', async () => {
    const text = byId('record').textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      show('encode-error', 'رکورد JSON در حافظهٔ موقت کپی شد.');
    } catch {
      show('encode-error', 'کپی ممکن نشد؛ متن را از بخش «رکورد کامل نماد» بردارید.');
    }
  });

  for (const [id, label] of LAB_SLIDERS) {
    byId<HTMLInputElement>(id).addEventListener('input', () => show(label, fa(txt(id))));
  }
  byId('run-lab').addEventListener('click', runLab);
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#presets .chip[data-preset]')) {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset ?? 'clean'));
  }
  byId('lab-ecc').addEventListener('change', () => {
    labImage = buildLabImage();
    if (labImage) grayToCanvas(labImage, byId<HTMLCanvasElement>('lab-canvas'));
    byId('lab-result').innerHTML = '<p class="muted">نماد با سطح تصحیح خطای تازه ساخته شد.</p>';
  });
  byId('reset-lab').addEventListener('click', () => {
    for (const [id, label] of LAB_SLIDERS) {
      byId<HTMLInputElement>(id).value = '0';
      show(label, fa('0'));
    }
    labImage = buildLabImage();
    if (labImage) grayToCanvas(labImage, byId<HTMLCanvasElement>('lab-canvas'));
    byId('lab-result').innerHTML = '<p class="muted">بازنشانی شد.</p>';
  });

  byId<HTMLInputElement>('file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void decodeFile(file);
  });
}

wire();
rebuild();
