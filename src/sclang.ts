import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAC_APP = "/Applications/SuperCollider.app/Contents/MacOS/sclang";

export function findSclang(): string | undefined {
  const fromEnv = process.env.SCLANG_PATH;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  if (existsSync(MAC_APP)) return MAC_APP;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, "sclang");
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

export function rendersDir(): string {
  const dir = process.env.SCLANG_MCP_OUTPUT_DIR ?? join(process.cwd(), "renders");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** SuperCollider string literal for a filesystem path or arbitrary text. */
function scString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

export interface RunResult {
  code: number | null;
  log: string;
  timedOut: boolean;
}

function run(sclang: string, scriptPath: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(sclang, [scriptPath], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let log = "";
    let timedOut = false;
    child.stdout!.on("data", (d) => (log += d));
    child.stderr!.on("data", (d) => (log += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, log, timedOut });
    });
  });
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL"); // sclang and the scsynth it spawned
  } catch {
    /* already gone */
  }
}

function workDir(): string {
  return mkdtempSync(join(tmpdir(), "sclang-mcp-"));
}

/**
 * Keeps the useful lines: our own markers and anything sclang reported as an error.
 * Patterns release synths with /n_set even when the synth already freed itself (doneAction: 2),
 * which sclang reports once per note; those are collapsed into a single count.
 */
export function summarizeLog(log: string): string {
  const nodeGone = /^FAILURE IN SERVER \/n_set Node \d+ not found/;
  let nodeGoneCount = 0;
  const lines: string[] = [];
  for (const l of log.split("\n")) {
    if (nodeGone.test(l)) nodeGoneCount++;
    else if (/ERROR|SC_ERROR|WARNING|FAILURE|^\s+(in |Call stack)/i.test(l)) lines.push(l);
  }
  const out = lines.slice(0, 40);
  if (nodeGoneCount) {
    out.push(`(${nodeGoneCount}x harmless "/n_set Node not found": notes released after the synth had already freed itself)`);
  }
  return out.join("\n");
}

const RENDER_RUNNER = (userFile: string, outPath: string, duration: number, tail: number, sampleRate: number) => `
(
var userCode = File.readAllString(${scString(userFile)});
var result, pat, score, defs, opts, total;
result = try { userCode.interpret } { |e| ("SC_ERROR: " ++ e.errorString).postln; 1.exit; nil };
defs = [SynthDef(\\default, { |out = 0, freq = 440, amp = 0.1, pan = 0, gate = 1|
    var sig = SinOsc.ar(freq) * EnvGen.kr(Env.asr(0.01, 1, 0.3), gate, doneAction: 2) * amp;
    Out.ar(out, Pan2.ar(sig, pan));
})] ++ (~defs ? []).asArray;
score = ~score;
if(score.isKindOf(Score).not) {
    pat = ~pattern ? result;
    if(pat.isKindOf(Pattern).not) {
        "SC_ERROR: code must set ~pattern to a Pattern (or ~score to a Score), or return a Pattern from its last expression".postln;
        1.exit;
    };
    score = pat.asScore(${duration}, 0.01);
};
score.score = defs.collect { |d| [0.0, [\\d_recv, d.asBytes]] } ++ score.score;
score.sort;
opts = ServerOptions.new.numOutputBusChannels_(2).numInputBusChannels_(0);
total = ${duration + tail};
score.recordNRT(nil, ${scString(outPath)}, sampleRate: ${sampleRate}, headerFormat: "WAV", sampleFormat: "int16",
    options: opts, duration: total, action: { "SC_RENDER_DONE".postln; 0.exit });
)
`;

export async function renderToWav(opts: {
  sclang: string;
  code: string;
  outPath: string;
  duration: number;
  tail: number;
  sampleRate: number;
}): Promise<RunResult> {
  const dir = workDir();
  const userFile = join(dir, "user.scd");
  const runner = join(dir, "render.scd");
  writeFileSync(userFile, opts.code);
  writeFileSync(runner, RENDER_RUNNER(userFile, opts.outPath, opts.duration, opts.tail, opts.sampleRate));
  const timeout = 60_000 + (opts.duration + opts.tail) * 10_000;
  return run(opts.sclang, runner, timeout);
}

let playing: ChildProcess | undefined;

const PLAY_RUNNER = (userFile: string, duration: number) => `
(
var userCode = File.readAllString(${scString(userFile)});
s.waitForBoot({
    try { userCode.interpret } { |e| ("SC_ERROR: " ++ e.errorString).postln };
    "SC_PLAYING".postln;
    ${duration}.wait;
    s.quit;
    0.exit;
});
)
`;

export function isPlaying(): boolean {
  return playing !== undefined && playing.exitCode === null && playing.signalCode === null;
}

export function stopPlayback(): boolean {
  if (!playing || !isPlaying()) return false;
  killGroup(playing);
  playing = undefined;
  return true;
}

/** Starts realtime playback and returns once the server is up (or failed to boot). */
export function startPlayback(sclang: string, code: string, duration: number): Promise<{ ok: boolean; log: string }> {
  stopPlayback();
  const dir = workDir();
  const userFile = join(dir, "user.scd");
  const runner = join(dir, "play.scd");
  writeFileSync(userFile, code);
  writeFileSync(runner, PLAY_RUNNER(userFile, duration));
  const child = spawn(sclang, [runner], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  playing = child;
  return new Promise((resolve) => {
    let log = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, log });
    };
    const onData = (d: Buffer) => {
      log += d;
      if (log.includes("SC_PLAYING")) finish(!log.includes("SC_ERROR"));
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("close", () => finish(false));
    const timer = setTimeout(() => {
      killGroup(child);
      finish(false);
    }, 30_000);
  });
}
