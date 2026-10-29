/**
 * ============================================================================
 *  سیمرغ‌کد — the mobile app (installable PWA, Capacitor-wrappable)
 * ============================================================================
 *
 * Two jobs, and nothing else: make a symbol, and read one back. Everything heavy
 * (pixel decoding, key derivation) happens in a Web Worker so the viewfinder
 * never stutters; everything cryptographic happens in @simurgh/core, so the app
 * holds no secret that the library does not already define.
 *
 * The app is offline-first: no fonts, no CDN, no network calls at all. Once the
 * service worker has cached the bundle it works in airplane mode, which is also
 * what makes it usable as a Capacitor WebView.
 */
import {
  ANGLE_TRACK,
  PBKDF2_ITERATIONS,
  SPEC_DATE,
  SPEC_VERSION,
  SYMBOLOGY_NAME,
  encode,
  hexEncode,
  payloadToText,
  toModel,
  type EccLevel,
  type EncodeOptions,
  type GeoFix,
} from '@simurgh/core';
import {
  THEMES,
  THEME_IDS,
  renderRaster,
  renderRGBA,
  renderSVG,
  resolveTheme,
  themeContrast,
  type SmcTheme,
} from '@simurgh/core/render';
import { decodeImage } from '@simurgh/core/imaging';
import type { DecodeJob, DecodeReply } from './decode.worker';

/* ------------------------------------------------------------------ helpers */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

/** SVG output begins with an XML declaration, which innerHTML refuses. */
function inlineSvg(svg: string): string {
  return svg.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
}

const fa = (n: number): string => n.toLocaleString('fa-IR');

function toast(message: string, ms = 1900): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function kv(target: HTMLElement, entries: [string, string | number][]): void {
  target.innerHTML = '';
  for (const [label, value] of entries) {
    const row = document.createElement('div');
    const k = document.createElement('span');
    k.textContent = label;
    const v = document.createElement('b');
    v.textContent = String(value);
    row.append(k, v);
    target.appendChild(row);
  }
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* -------------------------------------------------------------------- state */

type Preset = 'text' | 'url' | 'geo' | 'wifi' | 'file';

interface State {
  preset: Preset;
  text: string;
  bytes: Uint8Array | null;
  geo: GeoFix | null;
  ecc: EccLevel;
  shape: 'dot' | 'hex' | 'square';
  scale: number;
  theme: string;
  caption: boolean;
  seal: boolean;
  passphrase: string;
  iterations: number;
  context: string;
  /** Send http(s) strings through URL mode (5.29-6 bits/char instead of 8). */
  autoUrl: boolean;
}

const state: State = {
  preset: 'url',
  text: 'https://simurgh.code',
  bytes: null,
  geo: null,
  ecc: 'M',
  shape: 'dot',
  scale: 8,
  theme: 'ink',
  caption: true,
  seal: false,
  passphrase: '',
  iterations: PBKDF2_ITERATIONS,
  context: '',
  autoUrl: true,
};

/** Preferences (never the passphrase) survive a reload. */
const PREFS_KEY = 'simurgh.prefs.v1';

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Partial<State>;
    for (const k of ['ecc', 'shape', 'scale', 'theme', 'caption', 'iterations', 'preset'] as const) {
      if (p[k] !== undefined) (state as unknown as Record<string, unknown>)[k] = p[k];
    }
  } catch {
    /* a corrupt preference file must never stop the app */
  }
}

function savePrefs(): void {
  try {
    const { ecc, shape, scale, theme, caption, iterations, preset } = state;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ecc, shape, scale, theme, caption, iterations, preset }));
  } catch {
    /* private mode / full storage: preferences are a convenience, not a feature */
  }
}

/* ------------------------------------------------------------- create panel */

let currentSymbol: ReturnType<typeof encode> | null = null;
let lastError = '';

function buildOptions(): EncodeOptions {
  const opt: EncodeOptions = { ecc: state.ecc };
  if (state.preset === 'file' && state.bytes) opt.data = state.bytes;
  else if (state.preset === 'geo' && state.geo) opt.geo = state.geo;
  else if (state.preset === 'url' && state.autoUrl) opt.url = state.text;
  else opt.text = state.text;

  if (state.seal && state.passphrase) {
    opt.secure = {
      key: state.passphrase,
      iterations: state.iterations,
      ...(state.context ? { context: state.context } : {}),
    };
  }
  return opt;
}

let renderTimer: number | undefined;

function scheduleRender(): void {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, 140);
}

function render(): void {
  const stage = $('stage');
  const meta = $('symbolMeta');
  const note = $('selfTestNote');
  note.hidden = true;

  let sym;
  try {
    sym = encode(buildOptions());
  } catch (e) {
    lastError = (e as Error).message;
    currentSymbol = null;
    stage.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'placeholder';
    p.textContent = `نماد جا نمی‌شود: ${lastError}`;
    stage.appendChild(p);
    kv(meta, []);
    return;
  }

  lastError = '';
  currentSymbol = sym;
  const model = toModel(sym);
  const theme = resolveTheme(state.theme);
  const caption = state.caption ? captionFor(sym) : null;
  const svg = renderSVG(model, {
    theme,
    shape: state.shape,
    scale: 6,
    unit: 'mm',
    caption,
    precision: 2,
  });
  stage.innerHTML = inlineSvg(svg);

  const contrast = themeContrast(theme);
  $('contrastNote').textContent = `کنتراست ${contrast.worst.toFixed(1)}:۱ — ${contrast.printable ? 'چاپ‌پذیر' : 'فقط نمایشگر'}`;

  const lat = { K: 2 * sym.version + 12, N: sym.plan.codewords };
  kv(meta, [
    ['نسخه', fa(sym.version)],
    ['خانه‌ها', fa(3 * lat.K * (lat.K + 1) - 18)],
    ['سطح خطا', sym.ecc],
    ['بایت مفید', fa(sym.plan.payloadBytes)],
    ['قطر چاپ', `${fa(2 * lat.K + 10)} ماژول`],
    ['پوشش مرکب', `${(sym.inkCoverage * 100).toFixed(1)}٪`],
    ['فشرده‌سازی', sym.compression ? 'DEFLATE' : '—'],
    ['قفل', sym.secure ? `SECURE · ${sym.secure.ciphertext.length - 16} بایت` : 'ندارد'],
    ['کدواژه‌ها', fa(lat.N)],
  ]);

  const sealMeta = $('sealMeta');
  if (sym.secure) {
    sealMeta.hidden = false;
    kv(sealMeta, [
      ['شناسهٔ کلید', hexEncode(sym.secure.keyId)],
      ['نمک', hexEncode(sym.secure.salt).slice(0, 16) + '…'],
      ['تکرار PBKDF2', fa(sym.secure.iterations)],
      ['رمزنگاشته', `${fa(sym.secure.ciphertext.length)} بایت`],
    ]);
    $('sealBadge').textContent = 'فعال';
    $('sealBadge').className = 'badge lock';
  } else {
    sealMeta.hidden = true;
    $('sealBadge').textContent = 'خاموش';
    $('sealBadge').className = 'badge';
  }

  updateCharCount();
}

function captionFor(sym: ReturnType<typeof encode>): string {
  if (sym.secure) return `[sealed ${sym.secure.ciphertext.length - 16} B]`;
  const text = payloadText(sym);
  return text.length > 64 ? `${text.slice(0, 61)}…` : text;
}

function payloadText(sym: ReturnType<typeof encode>): string {
  const opt = buildOptions();
  if (opt.text) return opt.text;
  if (opt.url) return opt.url;
  if (opt.data) return `${opt.data.length} bytes`;
  if (opt.geo) return `${opt.geo.lat.toFixed(5)}, ${opt.geo.lon.toFixed(5)}`;
  return sym.segments.map((s) => s.kind).join('+');
}

function updateCharCount(): void {
  const el = $('charCount');
  if (state.preset === 'file' && state.bytes) {
    el.textContent = `${fa(state.bytes.length)} بایت`;
    return;
  }
  const n = [...state.text].length;
  const bytes = new TextEncoder().encode(state.text).length;
  el.textContent = `${fa(n)} نویسه · ${fa(bytes)} بایت`;
}

/* ------------------------------------------------------------ theme picker */

function buildThemePicker(): void {
  const host = $('themes');
  host.innerHTML = '';
  // One tiny symbol, rendered eight times: a palette is only worth showing if the
  // user can see it on the real thing.
  const sample = toModel(encode({ text: 'سیمرغ', ecc: 'M', version: 2 }));
  for (const id of THEME_IDS) {
    const theme = THEMES[id]!;
    const button = document.createElement('button');
    button.className = 'swatch' + (id === state.theme ? ' is-active' : '');
    button.type = 'button';
    button.title = `${theme.fa} — ${theme.en} (${themeContrast(theme).worst.toFixed(1)}:1)`;
    button.setAttribute('aria-label', theme.fa);
    button.innerHTML =
      inlineSvg(
        renderSVG(sample, {
          theme,
          shape: 'dot',
          scale: 3,
          quietZone: true,
          caption: null,
          metadata: false,
          precision: 1,
        }),
      ) + `<span>${theme.fa}</span>`;
    button.addEventListener('click', () => {
      state.theme = id;
      for (const b of host.querySelectorAll('.swatch')) b.classList.remove('is-active');
      button.classList.add('is-active');
      savePrefs();
      render();
    });
    host.appendChild(button);
  }
}

/* --------------------------------------------------------------- scan panel */

const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
let jobId = 0;
let workerBusy = false;
let pendingResolve: ((r: DecodeReply) => void) | null = null;
let lastPixels: { data: Uint8ClampedArray; width: number; height: number } | null = null;
let lastReply: DecodeReply | null = null;

worker.onmessage = (ev: MessageEvent<DecodeReply>) => {
  workerBusy = false;
  pendingResolve?.(ev.data);
  pendingResolve = null;
  if (ev.data.ok) showResult(ev.data);
  else if (ev.data.error && !stream) setStatus(`خطا: ${ev.data.error}`);
};

function postDecode(job: Omit<DecodeJob, 'id'>): Promise<DecodeReply> {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    workerBusy = true;
    worker.postMessage({ ...job, id: ++jobId } as DecodeJob, [job.data.buffer as ArrayBuffer]);
  });
}

let stream: MediaStream | null = null;
let rafId = 0;
let framesDecoded = 0;
let lastDecodeMs = 0;

const video = $<HTMLVideoElement>('video');
const overlay = $('overlay') as HTMLCanvasElement;
const grab = document.createElement('canvas');

function setStatus(text: string | null): void {
  const el = $('vfStatus');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

/** The square the user actually sees (CSS object-fit: cover on a square stage). */
function grabFrame(size = 640): { data: Uint8ClampedArray; width: number; height: number } | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;
  const out = Math.min(size, side);
  grab.width = out;
  grab.height = out;
  const ctx = grab.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, sx, sy, side, side, 0, 0, out, out);
  return { ...ctx.getImageData(0, 0, out, out), width: out, height: out };
}

async function startCamera(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('این مرورگر دوربین نمی‌دهد؛ از «انتخاب تصویر» استفاده کنید.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
  } catch (e) {
    setStatus(`دسترسی به دوربین رد شد: ${(e as Error).message}`);
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  $('vfHint').hidden = true;
  $('stopCamera').hidden = false;
  $<HTMLButtonElement>('startCamera').disabled = true;

  const track = stream.getVideoTracks()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
  const torch = $('torch') as HTMLInputElement;
  torch.disabled = !caps.torch;

  framesDecoded = 0;
  setStatus('در حال جست‌وجوی نماد…');
  loop();
}

function stopCamera(): void {
  cancelAnimationFrame(rafId);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $('vfHint').hidden = false;
  $('stopCamera').hidden = true;
  $<HTMLButtonElement>('startCamera').disabled = false;
  setStatus(null);
  drawReticle(null);
}

/**
 * The viewfinder reticle is the Format Crown itself: Limbus and Halo circles with
 * the 63-tooth Angle Track around them, drawn from the frozen m-sequence. It shows
 * the user how big to frame the symbol, and it is the honest shape of what the
 * matcher is looking for.
 */
function drawReticle(progress: number | null): void {
  const rect = overlay.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  overlay.width = Math.round(rect.width * dpr);
  overlay.height = Math.round(rect.height * dpr);
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const R = Math.min(rect.width, rect.height) * 0.42;

  ctx.strokeStyle = 'rgba(230,196,106,0.85)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.94, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(230,196,106,0.35)';
  ctx.stroke();

  // 63 teeth, weighted by the frozen Angle Track, sweeping with decode progress.
  const lit = progress === null ? 63 : Math.max(1, Math.round(progress * 63));
  for (let i = 0; i < 63; i++) {
    if ((ANGLE_TRACK[i] as number) !== 1) continue;
    const a = (i * 360) / 63 - 90;
    const rad = (a * Math.PI) / 180;
    const r0 = R * 1.02;
    const r1 = R * (i < lit ? 1.1 : 1.06);
    ctx.beginPath();
    ctx.moveTo(cx + r0 * Math.cos(rad), cy + r0 * Math.sin(rad));
    ctx.lineTo(cx + r1 * Math.cos(rad), cy + r1 * Math.sin(rad));
    ctx.strokeStyle = i < lit ? 'rgba(79,182,173,0.95)' : 'rgba(230,196,106,0.35)';
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }
}

function loop(): void {
  if (!stream) return;
  const continuous = ($('continuous') as HTMLInputElement).checked;
  if (!workerBusy && video.readyState >= 2 && (continuous || framesDecoded === 0)) {
    const frame = grabFrame(620);
    if (frame) {
      // postDecode *transfers* the buffer, so keep an independent copy: unlocking
      // a sealed symbol later has to re-send the very same pixels.
      lastPixels = {
        data: new Uint8ClampedArray(frame.data),
        width: frame.width,
        height: frame.height,
      };
      const t0 = performance.now();
      void postDecode({
        ...frame,
        fast: true,
        ...(state.seal && state.passphrase ? { passphrase: state.passphrase } : {}),
      }).then((r) => {
        lastDecodeMs = performance.now() - t0;
        framesDecoded++;
        if (r.ok) {
          navigator.vibrate?.(28);
          drawReticle(1);
          setStatus(`یافت شد: نسخهٔ ${r.diagnostics?.version} در ${Math.round(r.ms)} ms`);
          if (!continuous) stopCamera();
        } else {
          drawReticle(null);
          setStatus(`${fa(framesDecoded)} فریم · ${Math.round(lastDecodeMs)} ms/فریم — نمادی پیدا نشد`);
        }
      });
    }
  }
  rafId = requestAnimationFrame(loop);
}

function showResult(r: DecodeReply): void {
  lastReply = r;
  $('resultCard').hidden = false;
  $('resultActions').hidden = false;
  const badge = $('resultBadge');
  const text = $('resultText');
  const d = r.diagnostics ?? {};

  text.textContent = r.text ?? '';
  if (r.encrypted && !r.secureUnlocked) {
    badge.textContent = 'قفل‌شده';
    badge.className = 'badge lock';
    const info = r.secureInfo ?? {};
    text.textContent =
      `این نماد مهر و موم شده است.\n` +
      `رمزنگاشته: ${info.plaintextBytes} بایت\n` +
      `کلید: ${info.suite === 0 ? `PBKDF2-HMAC-SHA256 × ${info.iterations}` : 'کلید خام ۲۵۶ بیتی'} + ChaCha20-Poly1305\n` +
      `شناسهٔ کلید: ${info.keyId}`;
    $('unlockBox').hidden = false;
    $('openLink').hidden = true;
  } else {
    badge.textContent = r.encrypted ? 'باز شد' : 'خوانده شد';
    badge.className = 'badge on';
    $('unlockBox').hidden = true;
    const url = /^https?:\/\//i.exec((r.text ?? '').trim());
    $('openLink').hidden = !url;
  }

  kv($('resultMeta'), [
    ['نسخه', fa(Number(d.version ?? 0))],
    ['سطح خطا', String(d.ecc ?? '-')],
    ['ماسک', fa(Number(d.mask ?? 0))],
    ['زمان', `${fa(Math.round(r.ms))} ms`],
    ['دندان‌ها', String(d.teeth ?? '-')],
    ['تاج', String(d.crown ?? '-')],
    ['اطمینان', String(d.confidence ?? '-')],
    ['چرخش', `${d.rotationDeg ?? 0}°`],
    ['وارون', d.inverted ? 'بله' : 'خیر'],
    ['خطای اصلاح‌شده', fa(Number(d.errorsFixed ?? 0))],
    ['CRC', d.crc ? 'سالم' : '—'],
  ]);
}

/* -------------------------------------------------------------- wiring, UI */

function switchTab(name: 'create' | 'scan' | 'about'): void {
  for (const t of ['create', 'scan', 'about'] as const) {
    $(`tab-${t}`).classList.toggle('is-active', t === name);
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).classList.toggle('is-active', t === name);
  }
  if (name === 'scan') drawReticle(null);
}

function wireCreate(): void {
  const payload = $('payload') as HTMLTextAreaElement;
  payload.value = state.text;
  payload.addEventListener('input', () => {
    state.text = payload.value;
    if (state.preset === 'url' || state.preset === 'text') scheduleRender();
    else updateCharCount();
  });

  for (const chip of document.querySelectorAll<HTMLButtonElement>('#presetChips .chip')) {
    chip.classList.toggle('is-active', chip.dataset.preset === state.preset);
    chip.addEventListener('click', () => {
      const preset = chip.dataset.preset as Preset;
      for (const c of document.querySelectorAll('#presetChips .chip')) c.classList.remove('is-active');
      chip.classList.add('is-active');
      state.preset = preset;
      state.bytes = null;
      state.geo = null;
      payload.disabled = preset === 'file';
      if (preset === 'wifi') {
        payload.value = 'WIFI:S:نام‌شبکه;T:WPA;P:رمز‌شبکه;;';
        state.text = payload.value;
      } else if (preset === 'geo') {
        void readGeo();
      } else if (preset === 'file') {
        $('fileInput').click();
      } else if (preset === 'url' && !/^https?:/i.test(payload.value)) {
        payload.value = 'https://' + payload.value;
        state.text = payload.value;
      }
      savePrefs();
      scheduleRender();
    });
  }

  $('fileInput').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    state.bytes = new Uint8Array(await file.arrayBuffer());
    state.preset = 'file';
    toast(`${fa(state.bytes.length)} بایت خوانده شد`);
    scheduleRender();
  });

  const bind = <K extends keyof State>(id: string, key: K, parse: (v: string) => State[K]): void => {
    const el = $(id) as HTMLSelectElement;
    el.value = String(state[key]);
    el.addEventListener('change', () => {
      state[key] = parse(el.value);
      savePrefs();
      scheduleRender();
    });
  };
  bind('ecc', 'ecc', (v) => v as EccLevel);
  bind('shape', 'shape', (v) => v as State['shape']);
  bind('scale', 'scale', (v) => Number(v));
  bind('iterations', 'iterations', (v) => Number(v));

  ($('autoUrl') as HTMLInputElement).checked = state.autoUrl;
  $('autoUrl').addEventListener('change', (e) => {
    state.autoUrl = (e.target as HTMLInputElement).checked;
    scheduleRender();
  });

  ($('showCaption') as HTMLInputElement).checked = state.caption;
  $('showCaption').addEventListener('change', (e) => {
    state.caption = (e.target as HTMLInputElement).checked;
    savePrefs();
    render();
  });

  const sealToggle = $('sealToggle') as HTMLInputElement;
  sealToggle.addEventListener('change', () => {
    state.seal = sealToggle.checked;
    $('sealBody').hidden = !state.seal;
    if (state.seal && !state.passphrase) toast('گذرواژه را وارد کنید تا نماد قفل شود');
    scheduleRender();
  });

  const pass = $('passphrase') as HTMLInputElement;
  pass.addEventListener('input', () => {
    state.passphrase = pass.value;
    scheduleRender();
  });
  const ctxInput = $('sealContext') as HTMLInputElement;
  ctxInput.addEventListener('input', () => {
    state.context = ctxInput.value;
    scheduleRender();
  });

  $('downloadSvg').addEventListener('click', () => {
    if (!currentSymbol) return;
    const svg = renderSVG(toModel(currentSymbol), {
      theme: resolveTheme(state.theme),
      shape: state.shape,
      scale: 6,
      unit: 'mm',
      caption: state.caption ? captionFor(currentSymbol) : null,
    });
    download(`simurgh-v${currentSymbol.version}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
    toast('SVG ذخیره شد');
  });

  $('downloadPng').addEventListener('click', () => {
    if (!currentSymbol) return;
    const rgba = renderRGBA(toModel(currentSymbol), { theme: resolveTheme(state.theme), shape: state.shape, scale: state.scale });
    const canvas = document.createElement('canvas');
    canvas.width = rgba.width;
    canvas.height = rgba.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.createImageData(rgba.width, rgba.height);
    imageData.data.set(rgba.data);
    ctx.putImageData(imageData, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      download(`simurgh-v${currentSymbol!.version}.png`, blob);
      toast('PNG ذخیره شد');
    }, 'image/png');
  });

  $('copyText').addEventListener('click', async () => {
    const text = state.preset === 'file' && state.bytes ? `${state.bytes.length} bytes` : state.text;
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    toast('کپی شد');
  });

  $('selfTest').addEventListener('click', () => {
    if (!currentSymbol) return;
    const note = $('selfTestNote');
    note.hidden = false;
    note.textContent = 'در حال بازخوانی…';
    // Render to pixels and read them back through the same pipeline the camera
    // uses. This is the app proving its own output is scannable, on this device.
    setTimeout(() => {
      const img = renderRaster(toModel(currentSymbol!), { scale: 8, shape: state.shape });
      const t0 = performance.now();
      const res = decodeImage(img);
      const ms = Math.round(performance.now() - t0);
      const d = res.diagnostics;
      const expect = sealedExpectation();
      if (res.ok && (res.encrypted === true || res.text === expect)) {
        note.textContent =
          `بازخوانی موفق در ${fa(ms)} ms — نسخهٔ ${fa(res.version ?? 0)}، ` +
          `دندان ${d.teethMatches}/۶۳، اطمینان ${d.meanConfidence.toFixed(2)}، ` +
          `چرخش ${d.rotationDeg.toFixed(1)}°، خطای اصلاح‌شده ${res.stats?.errorsFixed ?? 0}` +
          (res.encrypted ? ' (مهر و موم‌شده: بدون کلید فقط قالب خوانده شد)' : '');
      } else {
        note.textContent = `بازخوانی ناموفق: ${res.error ?? 'محتوا یکسان نیست'}`;
      }
    }, 20);
  });
}

/**
 * What a self-test read-back must produce: the payload text, or -- for a sealed
 * symbol read without a key -- the envelope placeholder.
 */
function sealedExpectation(): string {
  const opt = buildOptions();
  if (opt.secure) {
    const n = (currentSymbol?.secure?.ciphertext.length ?? 16) - 16;
    return `[encrypted:${hexEncode(currentSymbol?.secure?.keyId ?? new Uint8Array(0))} ${n}B]`;
  }
  return opt.text ?? opt.url ?? '';
}

async function readGeo(): Promise<void> {
  const payload = $('payload') as HTMLTextAreaElement;
  if (!navigator.geolocation) {
    toast('مکان‌یابی در دسترس نیست');
    return;
  }
  payload.value = 'در حال گرفتن موقعیت…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.geo = {
        lat: Number(pos.coords.latitude.toFixed(7)),
        lon: Number(pos.coords.longitude.toFixed(7)),
        alt: Math.round(pos.coords.altitude ?? 0),
        flags: 0,
      };
      payload.value = `مکان: ${state.geo.lat}, ${state.geo.lon}`;
      toast('موقعیت ثبت شد');
      scheduleRender();
    },
    (err) => {
      payload.value = '';
      toast(`مکان‌یابی رد شد: ${err.message}`);
    },
    { enableHighAccuracy: true, timeout: 12000 },
  );
}

function wireScan(): void {
  $('startCamera').addEventListener('click', () => void startCamera());
  $('stopCamera').addEventListener('click', stopCamera);
  $('pickImage').addEventListener('click', () => ($('scanFile') as HTMLInputElement).click());
  $('scanFile').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const bitmap = await createImageBitmap(file);
    const side = Math.min(1400, Math.max(bitmap.width, bitmap.height));
    const k = side / Math.max(bitmap.width, bitmap.height);
    const w = Math.round(bitmap.width * k);
    const h = Math.round(bitmap.height * k);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const frame = ctx.getImageData(0, 0, w, h);
    lastPixels = frame;
    setStatus('در حال خواندن تصویر…');
    const r = await postDecode({
      data: frame.data,
      width: w,
      height: h,
      ...(state.passphrase ? { passphrase: state.passphrase } : {}),
      ...(state.context ? { context: state.context } : {}),
    });
    if (r.ok) showResult(r);
    else setStatus(`خوانده نشد: ${r.error}`);
  });

  ($('torch') as HTMLInputElement).addEventListener('change', async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as unknown as MediaTrackConstraintSet] });
    } catch {
      toast('چراغ قوه در این دستگاه کنترل نمی‌شود');
    }
  });

  $('unlockBtn').addEventListener('click', async () => {
    const pass = ($('unlockPass') as HTMLInputElement).value;
    if (!pass) {
      toast('گذرواژه خالی است');
      return;
    }
    if (!lastPixels) {
      toast('تصویری در حافظه نیست؛ دوباره اسکن کنید');
      return;
    }
    $('unlockNote').textContent = 'در حال اشتقاق کلید…';
    const info = lastReply?.secureInfo as { salt?: string; iterations?: number } | undefined;
    const r = await postDecode({
      data: new Uint8ClampedArray(lastPixels.data),
      width: lastPixels.width,
      height: lastPixels.height,
      passphrase: pass,
      ...(info?.salt ? { hint: { salt: info.salt, iterations: Number(info.iterations), suite: 0 } } : {}),
      ...(state.context ? { context: state.context } : {}),
    });
    if (r.ok && r.secureUnlocked) {
      $('unlockNote').textContent = '';
      showResult(r);
      toast('پاکت باز شد');
    } else if (r.ok) {
      $('unlockNote').textContent = 'نماد خوانده شد اما پاکت با این گذرواژه باز نشد.';
    } else {
      $('unlockNote').textContent = `خطا: ${r.error}`;
    }
  });

  $('copyResult').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(lastReply?.text ?? '').catch(() => undefined);
    toast('کپی شد');
  });
  $('clearResult').addEventListener('click', () => {
    $('resultCard').hidden = true;
    lastReply = null;
  });
  $('openLink').addEventListener('click', () => {
    const text = (lastReply?.text ?? '').trim();
    if (/^https?:\/\//i.test(text)) window.open(text, '_blank', 'noopener');
  });

  // Camera-free loopback tests: prove the whole path on this device.
  $('loopTest').addEventListener('click', () => {
    const sample = encode({ text: 'https://simurgh.code/fa/hello?device=pwa', ecc: 'M' });
    runLoopback(sample, undefined, 'نمونهٔ باز');
  });
  $('loopTestSealed').addEventListener('click', () => {
    const sample = encode({
      text: 'رمز گاوصندوق ۴۷۱۲ — sealed on this device',
      ecc: 'H',
      secure: { key: 'demo-pass', iterations: 4096 },
    });
    runLoopback(sample, 'demo-pass', 'نمونهٔ قفل‌شده');
  });
}

function runLoopback(sym: ReturnType<typeof encode>, pass: string | undefined, label: string): void {
  const note = $('loopNote');
  note.hidden = false;
  note.textContent = `${label}: در حال rasterize…`;
  setTimeout(() => {
    const rgba = renderRGBA(toModel(sym), { theme: state.theme, scale: 7, shape: state.shape });
    const t0 = performance.now();
    // Straight through the same worker the camera uses.
    void postDecode({
      data: new Uint8ClampedArray(rgba.data.buffer),
      width: rgba.width,
      height: rgba.height,
      ...(pass ? { passphrase: pass, hint: { salt: hexEncode(sym.secure!.salt), iterations: sym.secure!.iterations, suite: 0 } } : {}),
    }).then((r) => {
      const ms = Math.round(performance.now() - t0);
      if (r.ok) {
        showResult(r);
        note.textContent = `${label}: بازخوانی موفق در ${fa(ms)} ms (رندر ${rgba.width}×${rgba.height} پیکسل)`;
      } else {
        note.textContent = `${label}: شکست — ${r.error}`;
      }
    });
  }, 20);
}

/* --------------------------------------------------------------------- PWA */

let deferredPrompt: Event | null = null;

function wirePwa(): void {
  const showInstall = (yes: boolean) => {
    $('installBtn').hidden = !yes;
    $<HTMLButtonElement>('installBtn2').disabled = !yes;
  };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstall(true);
  });
  const doInstall = async () => {
    if (!deferredPrompt) {
      toast('در منوی مرورگر: «افزودن به صفحهٔ اصلی»');
      return;
    }
    (deferredPrompt as unknown as { prompt: () => void }).prompt();
    deferredPrompt = null;
    showInstall(false);
  };
  $('installBtn').addEventListener('click', doInstall);
  $('installBtn2').addEventListener('click', doInstall);

  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }
  $('swStatus').addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    const keys = await caches.keys();
    toast(
      reg?.active
        ? `آفلاین آماده — کش: ${keys.join(', ') || '(خالی)'}`
        : 'سرویس‌ورکر هنوز فعال نشده (نیاز به HTTPS یا localhost)',
      3200,
    );
  });

  const mark = $('brandMark');
  mark.innerHTML = inlineSvg(
    renderSVG(toModel(encode({ text: SYMBOLOGY_NAME, version: 2, ecc: 'M' })), {
      theme: 'lapis',
      scale: 3,
      caption: null,
      metadata: false,
      precision: 1,
      quietZone: true,
      quiet: 1,
    }),
  );

  $('specVersion').textContent = SPEC_VERSION;
  kv($('aboutMeta'), [
    ['نام', SYMBOLOGY_NAME],
    ['نسخهٔ مشخصات', SPEC_VERSION],
    ['تاریخ', SPEC_DATE],
    ['هزینهٔ PBKDF2', fa(PBKDF2_ITERATIONS)],
    ['رمزنگاری', 'ChaCha20-Poly1305'],
    ['حداکثر ظرفیت', '۲٬۶۸۹ بایت'],
  ]);
  $('perfNote').textContent = 'تمام محاسبات روی دستگاه — هیچ داده‌ای به شبکه نمی‌رود.';
}

/* --------------------------------------------------------------------- boot */

function boot(): void {
  loadPrefs();
  ($('ecc') as HTMLSelectElement).value = state.ecc;
  ($('shape') as HTMLSelectElement).value = state.shape;
  ($('scale') as HTMLSelectElement).value = String(state.scale);
  ($('iterations') as HTMLSelectElement).value = String(state.iterations);

  buildThemePicker();
  wireCreate();
  wireScan();
  wirePwa();

  for (const t of ['create', 'scan', 'about'] as const) {
    $(`tab-${t}`).addEventListener('click', () => switchTab(t));
  }

  // Deep links: the manifest's shortcuts point at #scan and #create.
  const hash = window.location.hash.replace('#', '');
  switchTab(hash === 'scan' || hash === 'about' ? hash : 'create');

  render();
  drawReticle(null);
  window.addEventListener('resize', () => drawReticle(null));
}

boot();
