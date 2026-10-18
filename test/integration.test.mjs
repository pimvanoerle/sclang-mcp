import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const out = mkdtempSync(join(tmpdir(), "sclang-mcp-test-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  env: { ...process.env, SCLANG_MCP_OUTPUT_DIR: out },
});
const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text };
};

const hasSclang = !(await call("sc_check")).isError;

test("lists tools", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["sc_check", "sc_play", "sc_render", "sc_stop"]);
});

test("renders a Pbind with the default instrument", { skip: !hasSclang }, async () => {
  const r = await call("sc_render", {
    code: "~pattern = Pbind(\\degree, Pseq([0, 2, 4], 1), \\dur, 0.25);",
    duration: 1,
    name: "default_inst",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Rendered .*default_inst\.wav/);
  assert.doesNotMatch(r.text, /silent/);
});

test("renders a custom SynthDef", { skip: !hasSclang }, async () => {
  const r = await call("sc_render", {
    code: `~defs = [SynthDef(\\blip, { |out=0, freq=440, amp=0.2| Out.ar(out, (SinOsc.ar(freq) * EnvGen.kr(Env.perc(0.01, 0.5), doneAction: 2) * amp) ! 2) })];
           ~pattern = Pbind(\\instrument, \\blip, \\degree, Pseq([0, 4, 7], 1), \\dur, 0.25);`,
    duration: 1,
    name: "custom_def",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /peak 0\.\d+/);
  assert.doesNotMatch(r.text, /silent/);
});

test("reports a silent render", { skip: !hasSclang }, async () => {
  const r = await call("sc_render", { code: "~pattern = Pbind(\\amp, 0, \\dur, 0.25);", duration: 1, name: "silent" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /silent/);
});

test("reports an sclang error", { skip: !hasSclang }, async () => {
  const r = await call("sc_render", { code: "~pattern = Pbind(\\degree, thisDoesNotExist.foo);", duration: 1, name: "bad" });
  assert.equal(r.isError, true);
  assert.match(r.text, /ERROR/);
});

test("rejects code that yields no pattern", { skip: !hasSclang }, async () => {
  const r = await call("sc_render", { code: "1 + 1", duration: 1, name: "nopattern" });
  assert.equal(r.isError, true);
  assert.match(r.text, /must set ~pattern/);
});

test("sc_stop with nothing playing", async () => {
  assert.match((await call("sc_stop")).text, /Nothing was playing/);
});

test.after(() => client.close());
