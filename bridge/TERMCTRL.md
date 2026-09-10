# termctrl — working reference for this repo

`@kitlangton/terminal-control` 1.2.1 drives the Grok pager in `bridge/checks.mjs`.
This file is the API surface plus the failure modes found while landing C1–C4.
Read it before touching the checks.

## Two surfaces

| Surface | Use |
|---|---|
| TS client (`TerminalControl`) | the checks — launch, wait, capture, resize, record |
| `termctrl` CLI | re-deriving a recording (`show --recording`), markers, video |

The client talks to `termctrl driver` (newline-delimited JSON over stdio). The
binary is `bridge/node_modules/.bin/termctrl`; resolve it by path, it is not on
`$PATH` for spawned children.

## Client API (dist/index.d.ts)

```ts
const tc = await TerminalControl.make({ cwd, env, artifacts });
const session = await tc.launch({
  command: [bin, ...args],   // argv array, not a shell string
  cwd, viewport: { cols, rows }, record: path | true | "on-failure",
  env, inheritEnv: true,
});
session.screen.waitForText(text | RegExp, { timeoutMs });
session.screen.waitForIdle({ timeoutMs, quietForMs });
session.screen.waitUntil((snap) => boolean, { timeoutMs });  // poll predicate
session.screen.capture({ settleMs, deadlineMs, allowIncomplete, includeAnsi, includeSvg });
session.screen.text({ settleMs, deadlineMs });   // throws on deadline
session.screen.frame({ settleMs, deadlineMs });
session.keyboard.type(text, { paceMs });
session.keyboard.press("Enter" | "Tab" | "Escape" | `Control+${Uppercase<letter>}` | ...);
session.resize({ cols, rows });
session.status();            // { state, exit, cols, rows, idleForMs, hasVisibleContent, recording }
session.recording();         // Uint8Array of the .termctrl bytes
session.saveRecording(path);
session.stop();
await tc.close();
```

`capture()` returns `{ reason, frame, text }`. `reason` is `"idle" | "deadline" |
"exited" | "outputclosed"`. Without `allowIncomplete: true` it throws
`IncompleteCaptureError` on `deadline`/`outputclosed` — that throw is the C1
assertion, not an inconvenience.

`frame` is `{ version: 2, cols, rows, cursor, cells[] }`; each cell is
`{ x, y, text, width, foreground, background, attributes }`. `text` is the
joined visible screen.

## CLI

```
termctrl show --recording FILE --format json   # re-derive the final frame
termctrl show --recording FILE --at-marker M   # frame at a named marker
termctrl start NAME --record FILE -- CMD       # named session + recording
termctrl mark NAME MARKER                      # named moment in a live recording
termctrl markers FILE                          # list markers
termctrl wait NAME TEXT --timeout MS
termctrl send NAME text:<v> enter ctrl-c ...
termctrl resize NAME --cols C --rows R
termctrl video FILE --edit plan.json -o out.mp4   # needs ffmpeg
```

`show --recording` is deterministic: the same `.termctrl` re-derives the same
frame every time. That is the C4 gate.

## Failure modes found (do not rediscover)

- **Idle is not "text gone".** The pager's `McpInitProgress{total:0}` seed row
  animates `Starting session…` for ~30s after a turn (SEED_EXPIRE,
  `agent_view/mod.rs:203`). At expiry the row *freezes mid-glyph* — it does not
  disappear. Wait for output quiescence (`waitForIdle`), never for the text to
  vanish. And the row only renders once the turn ends, so wait for it to appear
  before waiting for it to stop.
- **`waitForText` can resolve before the screen is ready.** Under `--replay` the
  whole turn lands in <1s; a text predicate can pass while a spinner is still
  animating. Always follow with `waitForIdle` (or `settlePastSeed`) before a
  capture that must be `idle`.
- **Cell-level golden compare is too brittle.** Row positions and right-aligned
  timestamps shift run to run. Compare normalized *text* (join cells by `y`,
  mask clock/seed/spinner/duration), not raw cell arrays.
- **Volatile spans to mask:** `\d{1,2}:\d{2} [AP]M`, `Starting session… Ns`,
  braille spinner glyphs `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, `Worked|Thought for Ns`.
- **`termctrl` is not on `$PATH`** inside `Bun.spawn` — use the absolute path
  under `bridge/node_modules/.bin/`.
- **`record` path** on `launch` writes a `.termctrl` recording; `session.recording()`
  returns the bytes. Recordings are gitignored (`tapes/.gitignore`); only the
  derived golden text is committed.

## Pager-specific notes (the app under test)

- Boot readiness: `waitForText("always-approve")` — the dock label, rendered once
  the agent handshake completes.
- A replayed turn ends with the agent's final text (`done`) plus `Worked for Ns`.
- The pager forwards its configured `mcpServers` in `session/new`; a failing one
  (temporal-docs 401) blocks the prompt. Fixtures record with `--no-mcp`.
- The pager's `x.ai/*` probes fire on timers, so request ids drift run to run —
  the adapter's replay pairs by method+occurrence and rewrites reply ids.
