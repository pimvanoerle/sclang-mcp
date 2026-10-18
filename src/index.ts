#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { findSclang, isPlaying, renderToWav, rendersDir, startPlayback, stopPlayback, summarizeLog } from "./sclang.js";
import { analyzeWav } from "./wav.js";

const server = new McpServer({ name: "sclang-mcp", version: "0.1.0" });

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

const NO_SCLANG =
  "sclang not found. Install SuperCollider (macOS: `brew install --cask supercollider`; Linux: your package manager) " +
  "or set SCLANG_PATH to the sclang binary.";

server.tool(
  "sc_check",
  "Check that SuperCollider's sclang is installed and where renders are written.",
  {},
  async () => {
    const sclang = findSclang();
    if (!sclang) return text(NO_SCLANG, true);
    return text(`sclang: ${sclang}\nrenders directory: ${rendersDir()}\nplaying: ${isPlaying()}`);
  },
);

server.tool(
  "sc_render",
  [
    "Render SuperCollider code to a WAV file offline (faster than realtime, no audio hardware needed) and report level stats.",
    "The code runs in sclang and must provide what to render in one of three ways:",
    "  ~pattern = Pbind(...)  (or return a Pattern as the last expression);",
    "  ~score = Score([...])  for raw server messages.",
    "Optionally set ~defs = [SynthDef(\\name, {...}), ...] for any custom instruments the pattern uses (a basic \\default instrument is always included).",
    "Use SynthDef objects without .add/.store. Example:",
    "  ~defs = [SynthDef(\\pluck, { |out=0, freq=440, amp=0.2| Out.ar(out, Pluck.ar(WhiteNoise.ar, 1, 0.1, freq.reciprocal, 3) ! 2 * amp * EnvGen.kr(Env.perc(0.01, 2), doneAction: 2)) })];",
    "  ~pattern = Pbind(\\instrument, \\pluck, \\degree, Pseq([0, 2, 4, 7], 2), \\dur, 0.25);",
    "The result includes peak/RMS so you can tell silence or clipping without listening. Returns the WAV path.",
  ].join("\n"),
  {
    code: z.string().describe("SuperCollider code (see tool description)."),
    duration: z.number().positive().max(600).describe("Length of the musical content in seconds."),
    name: z.string().regex(/^[A-Za-z0-9_-]+$/).default("render").describe("File name without extension."),
    tail: z.number().min(0).max(30).default(2).describe("Extra seconds rendered after the content so releases and reverbs can ring out."),
    sampleRate: z.number().int().min(8000).max(96000).default(44100),
  },
  async ({ code, duration, name, tail, sampleRate }) => {
    const sclang = findSclang();
    if (!sclang) return text(NO_SCLANG, true);
    const outPath = resolve(join(rendersDir(), `${name}.wav`));
    const r = await renderToWav({ sclang, code, outPath, duration, tail, sampleRate });
    if (r.timedOut) return text(`Render timed out.\n${summarizeLog(r.log)}`, true);
    if (!r.log.includes("SC_RENDER_DONE") || !existsSync(outPath)) {
      return text(`Render failed.\n${summarizeLog(r.log) || r.log.slice(-1500)}`, true);
    }
    const warnings = summarizeLog(r.log);
    try {
      const s = analyzeWav(outPath);
      const notes = [
        s.silent ? "WARNING: render is silent (check that the pattern plays and the instrument makes sound)." : "",
        s.clipped ? "WARNING: peak hits full scale, the render is clipping. Lower the amp." : "",
        s.peak > 0 && s.peak < 0.1 ? "Note: very quiet (peak below -20 dBFS)." : "",
      ].filter(Boolean);
      const db = (x: number) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : "-inf");
      return text(
        [
          `Rendered ${outPath}`,
          `${s.seconds.toFixed(2)} s, ${s.channels} ch, ${s.sampleRate} Hz`,
          `peak ${s.peak.toFixed(3)} (${db(s.peak)} dBFS), rms ${s.rms.toFixed(3)} (${db(s.rms)} dBFS)`,
          ...notes,
          warnings ? `sclang messages:\n${warnings}` : "",
        ].filter(Boolean).join("\n"),
      );
    } catch (e) {
      return text(`Rendered ${outPath} but could not analyse it: ${(e as Error).message}`);
    }
  },
);

server.tool(
  "sc_play",
  [
    "Play SuperCollider code in realtime on the default audio output. Boots the server, runs the code (the server is `s`, e.g. `Pbind(...).play` or `{ SinOsc.ar(440) ! 2 * 0.1 }.play`), and stops everything after `duration` seconds.",
    "Returns once playback has started. Use sc_stop to cut it short. Only one playback runs at a time; a new call replaces the old one.",
  ].join("\n"),
  {
    code: z.string().describe("SuperCollider code to run after the server has booted."),
    duration: z.number().positive().max(3600).describe("Seconds to keep playing before shutting down."),
  },
  async ({ code, duration }) => {
    const sclang = findSclang();
    if (!sclang) return text(NO_SCLANG, true);
    const r = await startPlayback(sclang, code, duration);
    if (!r.ok) return text(`Playback failed to start.\n${summarizeLog(r.log) || r.log.slice(-1500)}`, true);
    return text(`Playing for ${duration} s. Call sc_stop to end early.`);
  },
);

server.tool("sc_stop", "Stop realtime playback started by sc_play.", {}, async () =>
  text(stopPlayback() ? "Stopped." : "Nothing was playing."),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.on("exit", () => stopPlayback());
