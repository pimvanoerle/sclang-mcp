# sclang-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent make music with [SuperCollider](https://supercollider.github.io/).

The main problem with an agent making music is that it can't hear. So the core tool renders to a WAV file offline and reports **peak and RMS levels**, which tells the agent whether it produced silence or clipping. You listen to the file and give feedback. Realtime playback is there too.

Works on **macOS (Intel and Apple Silicon) and Linux**. It runs `sclang` as a subprocess, so there's no native code and no dependency on `supercolliderjs`.

## Tools

| Tool | What it does |
|------|--------------|
| `sc_check` | Finds `sclang` and shows where renders go |
| `sc_render` | Renders SuperCollider code to a WAV file offline (faster than realtime, no audio device needed) and returns the path plus level stats |
| `sc_play` | Plays SuperCollider code in realtime on the default output for N seconds |
| `sc_stop` | Stops realtime playback |

### What `sc_render` expects

The code you send must hand over what to render:

```supercollider
// Optional: custom instruments (a basic \default one is always included).
// Plain SynthDef objects, no .add or .store.
~defs = [
  SynthDef(\pluck, { |out = 0, freq = 440, amp = 0.2|
    var env = EnvGen.kr(Env.perc(0.01, 2), doneAction: 2);
    Out.ar(out, Pluck.ar(WhiteNoise.ar, 1, 0.1, freq.reciprocal, 3) ! 2 * amp * env);
  })
];

// Required: a Pattern...
~pattern = Pbind(\instrument, \pluck, \degree, Pseq([0, 2, 4, 7], 2), \dur, 0.25);

// ...or instead a raw Score for full control: ~score = Score([...]);
```

Example result:

```
Rendered /path/to/renders/pluck.wav
4.00 s, 2 ch, 44100 Hz
peak 0.412 (-7.7 dBFS), rms 0.061 (-24.3 dBFS)
```

Silent and clipping renders are flagged with a warning. sclang compile and runtime errors come back as the tool error.

`sc_play` runs your code after the server has booted (the server is `s`), for example `Pbind(\degree, Pseq([0, 2, 4], inf), \dur, 0.2).play`.

## Install

1. Install SuperCollider
   - macOS: `brew install --cask supercollider`
   - Linux: your package manager, for example `apt install supercollider-language supercollider-server`
2. Add the server to your MCP client. For Claude Code:

```bash
claude mcp add sclang -- npx -y github:pimvanoerle/sclang-mcp
```

Or in a JSON config:

```json
{
  "mcpServers": {
    "sclang": {
      "command": "npx",
      "args": ["-y", "github:pimvanoerle/sclang-mcp"]
    }
  }
}
```

### Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `SCLANG_PATH` | `/Applications/SuperCollider.app/...` on macOS, else `sclang` on `PATH` | Path to the `sclang` binary |
| `SCLANG_MCP_OUTPUT_DIR` | `./renders` (relative to the client's working directory) | Where WAV files are written |

## Security

Code sent to these tools runs in `sclang` with your user's permissions. SuperCollider can run shell commands (`"ls".unixCmd`) and read and write files. Only connect this to an agent you'd trust with a shell. `sc_play` and `sc_render` run in a separate process per call, so a crash or hang can't take the MCP server down; renders time out after a duration-scaled limit.

## Development

```bash
npm install
npm test     # builds, then drives the server over stdio with the MCP SDK client against a real sclang
```

Tests that need `sclang` are skipped when it isn't installed.

## Limits

- `sc_render` renders patterns and scores. Live-coding constructs that need a running server (buses, `Routine`s that talk to `s`, effects chains outside a score) belong in `sc_play`, or in a `~score` you build yourself.
- Every pattern you render must end. An infinite `Pbind` (for example a delay written as `Pbind(\dur, 4)`) makes sclang loop while building the score until the render times out. Cap voices with `Pfindur(seconds, pattern)` and write one-shot delays as `Pbind(\type, \rest, \dur, Pseq([4]))`.
- Renders are 16-bit stereo WAV.
- Renders are mixed straight to the output bus. For a reverb or limiter over everything, add a master synth at the tail of group 1 in a `~score`; the idea is `~score.add([0.0, [\s_new, \master, 999, 1, 1]])` with a `ReplaceOut` synth.

## License

MIT
