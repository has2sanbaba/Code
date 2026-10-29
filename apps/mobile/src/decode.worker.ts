/**
 * Decode worker.
 *
 * A full image decode costs 300-800 ms of dense floating-point work (radial
 * matched filter, homography fit, per-module soft sampling, Reed-Solomon over
 * every block). On the main thread that freezes the viewfinder and the shutter
 * animation, which is exactly what makes a scanner feel broken. Everything that
 * touches pixels therefore runs here, and the UI thread only ever receives small
 * JSON results.
 *
 * Key derivation runs here too: WebCrypto's PBKDF2 is native (~30 ms at
 * 210 000 iterations) and available inside workers, so unlocking a sealed symbol
 * never blocks the camera loop either.
 */
import { decode, deriveKeyAsync, hexDecode, type SecureDecodeOptions } from '@simurgh/core';
import { decodeRGBA, type ImageDecodeResult } from '@simurgh/core/imaging';

export interface DecodeJob {
  id: number;
  /** RGBA pixels. Transferred, not copied. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Passphrase for a sealed symbol; the worker derives the key itself. */
  passphrase?: string;
  /** Raw 256-bit key, hex, when the user supplied one directly. */
  keyHex?: string;
  /** Out-of-band context the encoder authenticated. */
  context?: string;
  /** Envelope parameters, when re-opening an already-located symbol. */
  hint?: { salt: string; iterations: number; suite: number };
  /** Trade robustness for latency: fewer rungs, no polarity retry. */
  fast?: boolean;
}

export interface DecodeReply {
  id: number;
  ms: number;
  ok: boolean;
  error?: string;
  text?: string;
  encrypted?: boolean;
  secureUnlocked?: boolean;
  secureInfo?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}

/** The fields of ImageDiagnostics worth showing in a phone UI. */
function summarise(r: ImageDecodeResult): Record<string, unknown> {
  const d = r.diagnostics;
  return {
    version: r.version ?? 0,
    ecc: r.ecc ?? '-',
    mask: r.mask ?? 0,
    compressed: r.compression === 1,
    width: d.width,
    height: d.height,
    pitch: Number(d.pitch.toFixed(2)),
    rotationDeg: Number(d.rotationDeg.toFixed(1)),
    teeth: `${d.teethMatches}/63`,
    crown: d.crownOk ? 'crown' : `brute(${d.golayDistance})`,
    confidence: Number(d.meanConfidence.toFixed(3)),
    weakFraction: Number(d.weakFraction.toFixed(3)),
    erasures: d.erasureCells,
    errorsFixed: r.stats?.errorsFixed ?? 0,
    crc: r.stats?.crcOk === true,
    inverted: d.inverted,
    polarityRetries: d.polarityRetries,
    attempts: d.attempts,
    transform: `${d.transformKind} rms=${d.transformRms.toFixed(2)}`,
    segments: (r.segments ?? []).map((s) => s.kind),
  };
}

async function secureOptions(job: DecodeJob, found?: { salt: string; iterations: number }): Promise<SecureDecodeOptions | undefined> {
  if (!job.passphrase && !job.keyHex && !job.context) return undefined;
  const opt: SecureDecodeOptions = {};
  if (job.context) opt.context = job.context;

  if (job.keyHex) {
    opt.key = hexDecode(job.keyHex.replace(/\s+/g, ''));
    return opt;
  }
  if (!job.passphrase) return opt;

  const saltHex = job.hint?.salt ?? found?.salt;
  const iterations = job.hint?.iterations ?? found?.iterations;
  if (!saltHex || !iterations) {
    // No envelope parameters yet: hand the passphrase over and let the core
    // derive it with the portable implementation.
    opt.key = job.passphrase;
    return opt;
  }
  const key = await deriveKeyAsync(job.passphrase, hexDecode(saltHex), iterations);
  opt.key = key;
  return opt;
}

self.onmessage = async (ev: MessageEvent<DecodeJob>) => {
  const job = ev.data;
  const t0 = performance.now();
  try {
    // Pass 1: read the symbol. If it turns out to be sealed and we were given a
    // passphrase, we now know the envelope's own salt and cost, so pass 2 derives
    // natively and re-opens from the *bits already sampled* -- no second pass over
    // the pixels, which is the expensive half.
    const first = decodeRGBA(job.data, job.width, job.height, {
      secure: await secureOptions(job),
      ...(job.fast
        ? { retries: 2, noPolarityRetry: true, versionWindow: 0, maxCandidates: 24 }
        : {}),
    });

    let result = first;
    if (first.ok && first.encrypted && !first.secureUnlocked && job.passphrase && first.sampled && first.secureInfo) {
      const info = first.secureInfo;
      const key = await deriveKeyAsync(job.passphrase, hexDecode(info.salt), Math.max(1, info.iterations));
      const reopened = decode(
        {
          dataBits: first.sampled.dataBits,
          confidence: first.sampled.confidence,
          beads: first.sampled.beads,
          format: first.format,
        },
        { secure: { key, ...(job.context ? { context: job.context } : {}) } },
      );
      if (reopened.ok) result = { ...reopened, diagnostics: first.diagnostics, sampled: first.sampled };
    }

    const reply: DecodeReply = {
      id: job.id,
      ms: Math.round(performance.now() - t0),
      ok: result.ok,
      ...(result.ok
        ? {
            text: result.text ?? '',
            encrypted: result.encrypted === true,
            secureUnlocked: result.secureUnlocked === true,
            secureInfo: result.secureInfo as unknown as Record<string, unknown>,
            diagnostics: summarise(result),
          }
        : { error: result.error ?? 'decode failed', diagnostics: summarise(result) }),
    };
    (self as unknown as Worker).postMessage(reply);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      id: job.id,
      ms: Math.round(performance.now() - t0),
      ok: false,
      error: (e as Error).message,
    } satisfies DecodeReply);
  }
};
