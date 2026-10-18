import { readFileSync } from "node:fs";

export interface WavStats {
  seconds: number;
  channels: number;
  sampleRate: number;
  peak: number; // 0..1
  rms: number; // 0..1
  clipped: boolean;
  silent: boolean;
}

/** Reads a PCM WAV (16/24-bit int or 32-bit float) and reports level stats, so an agent that cannot listen can still sanity-check a render. */
export function analyzeWav(path: string): WavStats {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("data chunk before fmt chunk");
      const bytes = Math.min(size, buf.length - body);
      const step = fmt.bits / 8;
      const n = Math.floor(bytes / step);
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        const p = body + i * step;
        let v: number;
        if (fmt.format === 3 && fmt.bits === 32) v = buf.readFloatLE(p);
        else if (fmt.bits === 16) v = buf.readInt16LE(p) / 32768;
        else if (fmt.bits === 24) v = buf.readIntLE(p, 3) / 8388608;
        else throw new Error(`unsupported WAV format (${fmt.bits}-bit, format ${fmt.format})`);
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sumSq += v * v;
      }
      const rms = n ? Math.sqrt(sumSq / n) : 0;
      return {
        seconds: n / fmt.channels / fmt.rate,
        channels: fmt.channels,
        sampleRate: fmt.rate,
        peak,
        rms,
        clipped: peak >= 0.999,
        silent: peak < 0.001,
      };
    }
    off = body + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}
