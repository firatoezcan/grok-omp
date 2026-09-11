# grok-pi — Grok Build TUI on Oh My Pi

`grok-pi` runs the Grok Build full-screen TUI (the `xai-grok-pager` binary from
this repo) with **Oh My Pi (OMP) as the agent**, connected over ACP through a
local bridge (`bridge/adapter.mjs`). You get the Grok pager's interface —
scrollback, modals, panes, voice dictation, subagent views — while every prompt,
tool call, and permission is handled by OMP and its configured providers.

Nothing here talks to x.ai. Login, telemetry, billing, and the auto-updater are
all disabled or unanswered; credentials come from OMP's own store.

---

## Install & launch

The shipped bundle lives in `dist/` and is installed on `PATH` as `grok-pi`
(`~/.local/bin/grok-pi` is a small shim that pins the three sibling binaries):

```
dist/grok-pi         launcher (compiled bridge/grok-pi.mjs)
dist/grok-pi-pager   the TUI binary
dist/grok-pi-agent   the compiled ACP adapter (bridge/adapter.mjs)
dist/grok-pi-stt     the local speech-to-text shim (bridge/stt-shim.mjs)
```

Run it from any project directory:

```sh
grok-pi
```

Extra arguments pass through to the pager (`grok-pi --help` shows pager flags).

### The isolated profile

`grok-pi` never touches your real `~/.grok` or `~/.omp`. Everything lives under
one isolated home:

```
~/.local/share/grok-pi/           $GROK_HOME — pager config, sessions, certs
~/.local/share/grok-pi/omp/       OMP config dir  ($PI_CONFIG_DIR)
~/.local/share/grok-pi/omp/agent/ OMP agent dir   ($PI_CODING_AGENT_DIR)
```

On first launch the launcher seeds this profile from your real OMP install:

- `agent.db` is cloned with `VACUUM INTO` — a consistent snapshot of your auth
  credentials and settings, so models work immediately. It is only seeded when
  the isolated DB has no credentials yet; afterwards the two diverge.
- `config.yml` (model roles, providers, advisor settings) is copied once, so
  the isolated profile starts with your real default model.
- `config.toml` is re-copied from `dist/config.toml` on every launch — that
  file disables remote settings fetch, telemetry, feedback uploads, the
  auto-updater, the leader process, and the crash handler, and pins auth to
  API-key mode so no sign-in screen ever appears.

To reset the profile, delete `~/.local/share/grok-pi` and relaunch.

### Which OMP runs

The adapter spawns OMP in ACP mode. Resolution order:

1. `OMP_ACP_CMD` — a complete ACP command line, used verbatim
   (e.g. `OMP_ACP_CMD="/path/to/omp acp --advisor"`).
2. `GROK_PI_OMP_CMD` — an `omp` binary or a full command line; `acp` is
   appended when absent.
3. A patched OMP build, auto-detected at
   `~/Projects/Freelancing/personal/oh-my-pi/packages/coding-agent/dist/omp`
   (built from the `grok-omp/vibe-acp` branch) or at
   `$GROK_HOME/omp-build/omp`. The patched build is what makes **vibe mode**
  drivable — see [Vibe mode](#vibe-mode).
4. Stock `omp` on `PATH` — everything works except driving vibe mode.

### The advisor

OMP's advisor (a second model reviewing each turn) is **on by default**. The
launcher writes a `PI_CONFIG_FILES` overlay that forces `advisor.enabled` and
pins `modelRoles.advisor` to your real profile's advisor model, and appends
`--advisor` to the agent command it resolved itself. Advisor notes render as
distinct blocks in the scrollback. Disable it with `GROK_PI_ADVISOR=0`.

---

## Models & effort

`/model` (alias `/m`, or Ctrl+M outside the prompt) opens the model picker. It
lists every model OMP advertises — 51 in a typical profile — each enriched by
the adapter from `omp models --json` with:

- provider/id selector and display name,
- a vision flag (`acceptsImages` / input modalities),
- context-window size and max output tokens,
- reasoning-effort support (`supportsReasoningEffort`).

`/effort <level>` sets reasoning effort on the current model without re-picking
it; `/model <name> <effort>` does both at once. Levels: `none`, `minimal`,
`low`, `medium` (default), `high`, `xhigh`, `max`. Effort only applies to
models OMP marks as reasoning-capable.

On the wire, the pager's `session/set_model` is translated by the adapter to
OMP's `session/set_config_option` (`configId: "model"`), and an effort choice
becomes a follow-up `set_config_option` on `configId: "thinking"`. The choice
is **session-scoped**: it's recorded in the session log, not persisted as a
default — a new session starts from the seeded `config.yml` default. Either
way it only ever touches the isolated OMP profile; your real `~/.omp` is
untouched.

---

## Voice dictation

Dictation is fully local: the pager captures microphone audio, streams it to a
localhost TLS WebSocket run by `grok-pi-stt`, and the shim forwards it to OMP's
STT worker (`omp __omp_worker_stt` — Parakeet TDT v3 via sherpa-onnx by
default, or Whisper via transformers.js). Transcribed text lands in the prompt
box; no audio ever reaches the agent or the network.

**Prerequisite:** the STT model must be downloaded into the isolated profile:

```sh
PI_CODING_AGENT_DIR=~/.local/share/grok-pi/omp/agent omp setup speech
```

If no model is cached, voice stays off and the launcher prints the install
line above. `GROK_PI_VOICE=1` forces the shim on anyway (the pager then shows
"run omp setup speech" on use); `GROK_PI_VOICE=0` disables voice entirely.

### Ways to dictate

| Trigger | Behavior |
|---|---|
| **Hold the space bar** | Push-to-talk on every terminal. A sustained hold is detected from the OS auto-repeat cadence (steady ~10–120 ms inter-key gaps); the few spaces typed before the cadence confirms are removed again, and recording stops 250 ms after the repeat stream ends — or instantly on the real key release on Kitty-protocol terminals. Taps and jittery mashing never trigger it. |
| **Ctrl+Space** or **F8** | Toggle (or hold-to-talk, see below). Works on the agent screen and the dashboard dispatch input. F8 is the fallback where Ctrl+Space is taken (e.g. macOS input-source switching; use Fn+F8 on laptops). |
| `/voice` | Toggle dictation from the command menu. |
| Esc / Enter / `[stop]` | Stop recording. Enter also sends. |

The chord's behavior follows `ui.voice_capture_mode`: `toggle` (press to start,
press again to stop) or `hold` (hold to record, release to stop — needs a
Kitty-protocol terminal, falls back to toggle elsewhere). `ui.voice_keybind_enabled`
disables the chord while keeping `/voice`; `ui.voice_stt_language` /
`voice.language` set the STT language.

Under the hood the launcher seeds `[voice] api_base = "https://127.0.0.1:<port>"`
into the isolated `config.toml`, exports the shim's CA via
`GROK_EXTRA_CA_BUNDLE`, and sets a dummy `XAI_API_KEY` (the pager requires a
bearer to open the socket; the shim ignores it — a real key you exported is
never clobbered).

---

## Vibe mode

`/vibe` switches the session into OMP's **vibe mode**: the main agent becomes a
director with a read-only toolset plus five worker tools
(`vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`) that run
persistent `fast`/`good` worker sessions — real in-process subagents with their
own session files.

| Command | Effect |
|---|---|
| `/vibe` | Toggle vibe mode |
| `/vibe on` / `/vibe off` | Enter / exit explicitly |
| `/vibe <prompt>` | Enter vibe mode and start a turn with that prompt |

While active, the prompt shows a `vibe` badge and a tinted border. Workers
appear as Subagent blocks in the scrollback and as rows in the tasks pane
(**Ctrl+G**), with live turn/tool counters; pressing Enter on a worker opens
its real transcript. Worker results are delivered back into the director and
shown in the conversation. Vibe and plan mode don't mix: entering plan while
vibe is active exits vibe first, but entering vibe while plan is active is
refused — exit plan mode first.

**Requires the patched OMP** (branch `grok-omp/vibe-acp`, auto-detected — see
[Which OMP runs](#which-omp-runs)). On stock OMP the mode switch fails cleanly
and the session stays in its current mode. Cancelling a worker from the UI
reports honestly (`not_found` / `already_finished`) — there is no per-worker
kill over ACP, so a live worker is never falsely marked cancelled.

---

## Sessions

- `/resume` (Ctrl+R) — session picker over OMP's session store: title, cwd,
  message count, timestamps. Deep search (`/resume` then type a query) filters
  adapter-side over the full session list.
- `/fork [--worktree|--no-worktree] [directive]` — branch the current session
  into a peer agent, keeping history (`session/fork`).
- `/new` (alias `/clear`, Ctrl+N twice) — fresh session.
- `/history` — prompt history, read from OMP's real `history.db` for the
  current directory (up-arrow on an empty prompt browses it too).
- `/rename`, `/delete` — **not available**: OMP exposes no rename/delete over
  ACP, so both show an honest error rather than pretending to work.
- **Worktrees** — the welcome screen's "New worktree" flow and
  `x.ai/git/worktree/*` are implemented by the adapter with real local
  `git worktree` commands (create, list, remove, resume-into-worktree). This is
  local git work, not an OMP feature.

The dashboard (`/dashboard`, Ctrl+\\) shows a live roster synthesized from the
active session plus the stored session list.

---

## Slash commands

Type `/` to open the menu; it fuzzy-matches as you type. Commands come from two
sources:

- **pager** — built into the TUI, handled locally or translated by the adapter.
- **OMP** — advertised by the agent over ACP (`available_commands_update`) and
  executed by OMP when sent as a prompt. OMP also advertises skill commands,
  extension commands, and project file commands the same way.

When both sides define the same name, **the pager's builtin wins** and the OMP
command is hidden from the menu (marked *shadowed* below). OMP commands that
exist only in OMP's own TUI (no text-mode handler) are never advertised —
typing them sends literal text to the model. The one exception is `/vibe`,
which the adapter intercepts and translates into a mode switch.

### Pager builtins

| Command | What it does | Notes under grok-pi |
|---|---|---|
| `/tutorial` (aliases `tour`, `onboarding`) | Quick tips for getting the most out of the TUI | |
| `/settings` (aliases `config`, `preferences`, `prefs`) | Open the settings modal | See [Settings](#settings) |
| `/dashboard` (aliases `agents-dashboard`, `sessions`) | Agent Dashboard: live roster of sessions | Roster synthesized by the adapter |
| `/workflows` | Browse installed workflows | Empty — OMP workflows aren't surfaced over ACP |
| `/plugins` (alias `plugin`) | Extensions modal, plugins tab | Lists OMP plugins; enable/disable works; install/uninstall report "unsupported" |
| `/btw <question>` | Ask a side question without interrupting | **Errors** — OMP has no side-question channel over ACP |
| `/voice` | Toggle dictation | See [Voice dictation](#voice-dictation) |
| `/new` (alias `clear`) | Start a new session | |
| `/effort <level>` | Set reasoning effort on the current model | |
| `/model` (alias `m`) | Switch model (and optionally effort) | See [Models & effort](#models--effort) |
| `/context` | Context-window usage breakdown | Real used/total from OMP's usage updates |
| `/compact [instructions]` | Compact conversation history | Runs OMP's real `/compact` as a queued turn |
| `/fork` | Branch the session into a peer agent | |
| `/resume` | Session picker | |
| `/loop [interval] <prompt>` | Re-run a prompt on an interval | **Not offered** — requires the scheduler tool, which OMP doesn't advertise |
| `/plan [description]` | Enter plan mode | Real OMP mode; approval card bridged from OMP's elicitation |
| `/view-plan` (aliases `show-plan`, `plan-view`) | View the current plan | |
| `/vibe [on\|off\|prompt]` | Toggle vibe mode | See [Vibe mode](#vibe-mode) |
| `/remember [text]` | Save a memory note | **Errors** — notes go to `x.ai/memory/rewrite`, which OMP doesn't implement |
| `/recap` (alias `summarize`) | Summarize the session so far | **Errors** — no recap generator over ACP |
| `/rewind` (alias `undo`) | Rewind to a previous turn | **Errors** — OMP rewind is tool-driven, not client-driven |
| `/jump` | Jump to a turn in the conversation | |
| `/expand` | Re-print the last collapsed block (minimal mode) | |
| `/edit-prompt` | Open the prompt draft in `$VISUAL`/`$EDITOR` | |
| `/queue` | List prompts queued behind the running turn | See [Interaction](#interaction) |
| `/session-info` | Session details: agent, model, turns, context | |
| `/share` | Share this session via URL | **Errors** — no share backend |
| `/rename` (alias `title`) | Rename the session | **Errors** — no rename over ACP |
| `/history` | Search prompt history | Reads OMP's real history |
| `/transcript` (alias `log`) | Open the transcript in `$PAGER` | |
| `/export [filename]` | Export the conversation to a file or clipboard | Pager-local export |
| `/copy [N] [file]` | Copy the Nth-latest response to clipboard/file | |
| `/find [text]` | Search the scrollback | |
| `/usage` (alias `cost`) | Usage modal: turns, tokens, session cost | No billing/credit data — see [Usage & cost](#usage--cost) |
| `/tasks` | Tasks pane: subagents, background tasks | Subagents and vibe workers; no bg-task registry |
| `/skills` | Extensions modal, skills tab | Lists OMP skills; toggle works |
| `/mcps` | MCP server status | Lists configured servers; toggle works |
| `/hooks` | Extensions modal, hooks tab | Lists OMP hooks; enable/disable works |
| `/marketplace` | Extensions modal, marketplace tab | Empty — no marketplace over ACP |
| `/workflow` | Launch/manage a saved workflow | No workflows advertised |
| `/personas` | Manage personas | Empty — no persona bundle behind OMP |
| `/config-agents` (alias `agents`) | Manage agent definitions | Empty — no agent-definition bundle behind OMP |
| `/theme` (alias `t`) | Switch color theme | |
| `/auto` | Toggle auto mode | Display flag only under OMP — no classifier; permission prompts still appear |
| `/always-approve` | Toggle always-approve (skip all permission prompts) | Pager-side auto-answer of OMP's permission requests |
| `/vim-mode` | Vim-style scrollback keys (j/k, g/G, y/Y…) | |
| `/multiline` (alias `ml`) | Swap Enter and Shift+Enter | |
| `/compact-mode` | Compact UI density | |
| `/timestamps` | Toggle message timestamps | |
| `/toggle-mouse-reporting` | Toggle terminal mouse reporting | |
| `/minimal` / `/fullscreen` | Switch screen mode | Each visible only in the opposite mode |
| `/timeline` | Toggle the timeline sidebar | |
| `/cd [path]` | Change working directory for new agents | Dashboard only |
| `/imagine <description>` | Generate an image | Requires the image-gen tool — not offered under OMP |
| `/imagine-video <description>` | Generate a video | Same gating as `/imagine` |
| `/docs` (aliases `howto`, `guides`) | Open how-to guides / online Build docs | |
| `/release-notes` (alias `changelog`) | Release notes for this version | |
| `/announcements` | Show or hide announcements | Local announcements only — none arrive from a server |
| `/feedback [text]` | Send feedback about the session | Feedback uploads are disabled in the seeded config |
| `/privacy` | Coding-data retention settings | xAI-account surface; no effect under OMP |
| `/doctor` (aliases `terminal-setup`, `terminal-check`, `terminal-info`) | Check the session and show fixes | |
| `/import-claude` | Import Claude settings | |
| `/login` | Log in | Shows an auth error — no xAI login exists behind OMP |
| `/logout` | Log out | **Errors** — nothing to log out of at the ACP layer |
| `/home` (alias `welcome`) | Return to the welcome screen | |
| `/delete` | Delete this session | **Errors** — no delete over ACP |
| `/help` | Browse commands and shortcuts | |
| `/quit` (alias `exit`) | Quit (Ctrl+Q / Ctrl+D, press twice) | |
| `/gboom` | Hidden easter egg | Not listed in the menu |
| `/scroll-debug` | Toggle the scroll-diagnostics HUD | Hidden |
| `/debug [scroll\|fps\|log]` | Debug overlays | Listed only on debug builds |

### OMP builtins (advertised over ACP)

These are executed by OMP itself. Names that collide with a pager builtin are
shadowed — the pager's version runs instead.

| Command | What it does | Notes |
|---|---|---|
| `/advisor [on\|off\|status\|dump\|configure]` | Toggle the advisor (second model reviewing each turn) | Also forced on by the launcher unless `GROK_PI_ADVISOR=0` |
| `/export [--themes] [path]` | Export session to HTML | **Shadowed** by the pager's `/export` |
| `/trace` | Open this session's trace in the stats dashboard | |
| `/dump` | Return the full transcript as plain text + LLM request JSON path | |
| `/share` | Share via encrypted link (share server or secret gist) | **Shadowed** — pager's `/share` errors |
| `/browser [headless\|visible]` | Toggle browser eval-prelude headless/visible | |
| `/force: <tool> [prompt]` | Force the next turn to use a specific tool | |
| `/ssh <subcommand>` | Manage SSH hosts (add, list, remove) | |
| `/fresh` | Reset provider stream state without changing the transcript | |
| `/compact` | Compact the conversation | **Shadowed** — pager's `/compact` forwards to this |
| `/shake [elide\|images\|thinking]` | Drop heavy content from context | |
| `/handoff [focus]` | Summarize into a handoff document and compact in place | |
| `/pin [session id]` | Pin/unpin a session atop the resume list | |
| `/retry` | Retry the last failed agent turn | |
| `/memory <subcommand>` | Inspect and operate memory maintenance | |
| `/rename [title]` | Rename the session (omit to generate) | **Shadowed** — pager's `/rename` errors |
| `/move [<path>]` | Move the session to a different directory | |
| `/wt [<branch>]` (alias `worktree`) | Move this session into a new worktree, changes included | |
| `/add-dir <path>` / `/remove-dir <path>` / `/dirs` | Multi-root workspace directories | |
| `/marketplace <subcommand>` | Manage marketplace sources and plugins | **Shadowed** — pager's `/marketplace` shows an empty tab |
| `/plugins [list\|enable\|disable]` | Manage plugins | **Shadowed** — use the pager's `/plugins` modal |
| `/reload-plugins` | Reload all plugins | **Blocked** by the pager's reserved-name list |
| `/security <subcommand>` | Plan, run, inspect, import, compare OMP-native security scans | |
| `/model` (alias `models`) | Show current model selection | **Shadowed** — pager's `/model` opens the picker |
| `/switch [model]` | Switch model for this session (fuzzy ids, provider/id, @role, :level) | |
| `/fast [on\|off\|status]` | Toggle priority service tier (provider-dependent) | |
| `/skillful [on\|off\|status]` | Toggle listing skills in the system prompt | |
| `/extended-context [on\|off\|status]` | Toggle extended context windows | |
| `/computer [on\|off\|status]` | Toggle the native computer-use eval prelude | |
| `/prewalk` | Switch to a fast/cheap model at the next action | |
| `/todo <subcommand>` | Manage the agent's todo list | |
| `/session [info\|delete\|pin]` | Show or configure the current session | |
| `/jobs` | Show async background jobs | |
| `/usage [show\|reset]` | Show provider usage and limits | **Shadowed** — pager's `/usage` shows session usage |
| `/stats [--port] [--host]` | Launch the local stats dashboard | |
| `/changelog [full]` | Show changelog entries | **Shadowed** by `/release-notes`' alias |
| `/tools` | Show tools currently visible to the agent | |
| `/context` | Estimated context-usage breakdown | **Shadowed** — pager's `/context` shows the real window |
| `/mcp <subcommand>` | Manage MCP servers (add, list, remove, test) | |

Not advertised (OMP-TUI-only, no text-mode handler): `/collab`, `/join`,
`/leave`, `/copy`, `/open`, `/live`, `/pause`, `/quit`, `/new`, `/clear`,
`/drop`, `/resume`, `/btw`, `/tan`, `/omfg`, `/cleanse`, `/debug`, `/exit`,
`/restart`, `/settings`, `/setup`, `/plan`, `/plan-review`, `/vibe`, `/goal`,
`/guided-goal`, `/loop`, `/queue`, `/hotkeys`, `/extensions`, `/agents`,
`/git`, `/hub`, `/branch`, `/fork`, `/tree`, `/login`, `/logout`. Typing one of
these sends it to the model as literal text — except `/vibe`, which the adapter
intercepts (see [Vibe mode](#vibe-mode)), and names the pager itself handles.

---

## Extensions

`/skills`, `/hooks`, `/plugins`, `/marketplace`, and `/mcps` open the
extensions modal (Ctrl+L outside VS Code-family terminals — there Ctrl+L is
the send-now chord). The adapter populates every tab from OMP's real
`_omp/extensions` listing:

- **Skills** — OMP skills with descriptions; toggling one calls
  `_omp/extensions/toggle`.
- **Hooks** — OMP hooks with their event and source; enable/disable works.
- **Plugins** — installed OMP plugins; enable/disable works. Install,
  uninstall, and marketplace actions report an honest error (no ACP path).
- **MCPs** — servers from your session config merged with OMP's extension
  state; the toggle enables/disables a server and the open modal refreshes.
- **Marketplace** — always empty; OMP's marketplace has no ACP surface.

Skills also appear in the `/` menu as runnable commands when OMP advertises
them.

---

## Usage & cost

- `/usage` — turns completed, summed input/output/cache tokens, and the
  session's cumulative USD cost (real data from OMP's usage reporting). The
  "incomplete" marker shows for resumed sessions whose earlier turns predate
  the adapter.
- `/context` — real context-window used/total, free tokens, and turn count.
- The **context bar** in the status line fills from OMP's per-turn
  `usage_update` — always live.
- `/session-info` — agent name, model, turn count, context snapshot.

There is no billing, subscription, credit bar, or auto-top-up: those are xAI
concepts and the adapter answers their requests with an error, so the credit
bar simply stays hidden.

---

## Interaction

- **Type-ahead queue** — OMP cancels a running turn when a second prompt
  arrives, so the adapter holds extra prompts client-side and drains them FIFO.
  Enter while a turn runs queues a follow-up; `/queue` (Ctrl+; or Ctrl+4)
  opens the queue pane where you can reorder, edit, remove, or clear entries.
- **Send now** — Ctrl+Enter (Ctrl+L in VS Code-family terminals, Ctrl+O in
  Apple Terminal; Ctrl+I is the fallback where Ctrl+Enter drops) promotes the
  message immediately — which does cancel the running turn, honestly, because
  OMP has no mid-turn steer over ACP.
- **Plan mode** — Shift+Tab cycles Normal → Plan → Auto → Always-Approve →
  Normal (Auto is skipped only when the feature is gated off). Plan is a real
  OMP mode (`session/set_mode`); when the agent finishes planning, OMP's
  approval question is bridged into the pager's plan-approval card.
  Always-approve is pager-side: it auto-answers OMP's permission prompts
  (`bash`, `edit`, `delete`, `move` — the only tools OMP gates). Auto is a
  display flag under OMP — there's no classifier, so prompts still appear.
- **Questions** — OMP's `ask` tool and other form elicitations arrive as the
  pager's question card; URL-mode elicitations render as the MCP elicitation
  card.
- **Ctrl+B** — send a running foreground Execute to the background. **Errors**
  under OMP: it calls `x.ai/terminal/background`, which the adapter doesn't
  implement.
- **Ctrl+C** — cancel the turn (with a non-empty draft it clears the prompt
  first). Esc never cancels.
- **Ctrl+T** — todo pane. **Ctrl+G** — tasks pane (in minimal mode: edit prompt
  in external editor). **Ctrl+P** or `?` — command palette. **Ctrl+.** or
  **Ctrl+X** — keyboard-shortcut cheatsheet (whichever your terminal delivers
  reliably is advertised). **F2** or **Ctrl+,** — settings.

---

## Settings

`/settings` (F2 / Ctrl+,) opens the settings modal — Appearance, Mouse, Editor,
Agent, Privacy, Models, Session, and Advanced categories, all persisted to the
isolated `$GROK_HOME/config.toml`. Keys worth knowing under grok-pi:

| Key | Effect |
|---|---|
| `ui.voice_capture_mode` | `hold` or `toggle` for the Ctrl+Space/F8 chord |
| `ui.voice_keybind_enabled` | Enable the voice chord (`/voice` always works) |
| `ui.voice_stt_language` | STT language code or `auto` |
| `voice.api_base` | STT endpoint — managed by the launcher, points at the local shim |
| `voice.language`, `voice.sample_rate` | STT language and capture rate (16 kHz default) |
| `features.voice_mode` | Voice feature flag (also `GROK_VOICE_MODE`) |
| `cli.session_picker_grouped` | Group sessions by repo in the picker |
| `dashboard.enabled` | Show the agent dashboard |

### OMP section

The settings modal has a dedicated **OMP** category, separate from the Grok
settings — it renders only when the connected agent is OMP (detected from
`agentInfo.name == "oh-my-pi"` or the adapter's `_meta.ompAgent` stamp on
initialize). Its **Slash commands** row opens a sub-sheet listing every command
the agent advertised via `available_commands_update` — builtins plus skill,
extension, and file commands — each with its description and an
enabled/disabled toggle. All commands default to enabled; toggling one off
hides it from the `/` menu and blocks it from being sent to the agent. The
disabled set persists as `[ui].omp_disabled_commands` in the isolated
`$GROK_HOME/config.toml`.

---

## The `[agent:state]` token

The shortcuts bar carries a fixed, right-aligned machine-readable marker for
terminal automation and scripting:

| Token | Meaning |
|---|---|
| `[agent:idle]` | Ready for a prompt |
| `[agent:running]` | A turn is streaming |
| `[agent:cancelling]` | A turn or command is being cancelled |
| `[agent:command]` | A pager-local command is running |

A driver can grep the screen text for `[agent:idle]` instead of guessing from
spinners — this is what the repo's own termctrl end-to-end checks wait on.

---

## Environment variables

| Variable | Effect |
|---|---|
| `GROK_HOME` | Isolated pager home (default `~/.local/share/grok-pi`) |
| `OMP_ACP_CMD` | Full ACP command line for the agent, used verbatim (highest precedence) |
| `GROK_PI_OMP_CMD` | `omp` binary or command line; `acp` appended when absent |
| `GROK_PI_PAGER` / `GROK_PI_AGENT` / `GROK_PI_STT_SHIM` | Override the sibling binary paths |
| `GROK_PI_ADVISOR` | `0` disables the advisor (default on) |
| `GROK_PI_VOICE` | `1` force voice on, `0` disable; unset = auto (on when an STT model is cached) |
| `GROK_PI_STT_MODEL` | STT model key (`parakeet` default; `fast`/`balanced`/`turbo` for Whisper) |
| `GROK_PI_STT_OMP_CMD` | Worker command prefix override for the shim |
| `GROK_PI_STT_PORT` / `GROK_PI_STT_DIR` / `GROK_PI_STT_LANGUAGE` / `GROK_PI_STT_REQUIRE_CACHED` | Shim port, cert/state dir, fallback language, require-cached-model |
| `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` | Set by the launcher to the isolated OMP home |
| `PI_CONFIG_FILES` | Launcher appends the advisor overlay here |
| `XAI_API_KEY` | Seeded to `local-voice` when unset (the pager requires a bearer for STT; the shim ignores it) |
| `GROK_EXTRA_CA_BUNDLE` | Points at the shim's CA (merged with any bundle you set) |
| `GROK_VOICE_MODE` | Voice feature flag (same as `features.voice_mode`) |

The launcher also sets `GROK_DISABLE_AUTOUPDATER=1`,
`GROK_TELEMETRY_ENABLED=false`, `DISABLE_TELEMETRY=1`,
`GROK_TELEMETRY_TRACE_UPLOAD=false`, and `GROK_FEEDBACK_ENABLED=false`, and
unsets `SENTRY_DSN` / `GROK_EXTERNAL_OTEL`.

---

## Honest limitations

Everything below is a real gap, reported as an error (`-32601`) rather than
faked:

- **Accounts & billing** — no login/logout, subscription, credits, or consent
  flow exists behind OMP. `/login` shows an auth error, `/logout` and `/share`
  error, the credit bar stays hidden, and `/privacy` has no effect.
- **Session admin** — `/rename` and `/delete` error (OMP's rename/delete are
  internal, not on ACP). Session search matches titles, not bodies.
- **Rewind & recap** — `/rewind` and `/recap` error; OMP's rewind is a model
  tool, not a client action.
- **Side channels** — `/btw` errors; there is no mid-turn side question or
  subagent steering over ACP. Interject lands as the next queued prompt.
- **Background tasks** — OMP's `bash {async}` completions arrive as ordinary
  tool results; there is no task registry, so the tasks pane's background rows
  and `x.ai/task/kill` are unsupported, and Ctrl+B (`x.ai/terminal/background`)
  errors. Subagent cancel answers truthfully
  (`not_found`/`already_finished`) instead of claiming a kill it can't do.
- **Scheduler, announcements, follow-ups, memory flush** — no OMP equivalent;
  those surfaces stay empty or error.
- **Marketplace, personas, workflows** — listed but empty.
- **Image/video generation** — `/imagine` and `/imagine-video` need xAI tools
  and are not offered.
- **Terminal quirks** — some chords depend on what your terminal delivers:
  Ctrl+. is unreliable on Windows/WSL and some terminals (Ctrl+X is the
  alternate); Ctrl+Enter may drop Ctrl on Windows (Ctrl+I works); Ctrl+; is
  remapped to Ctrl+4 in local macOS VS Code terminals; hold-to-release voice
  needs the Kitty keyboard protocol (everywhere else it's toggle — and the
  hold-spacebar gesture works regardless, via auto-repeat detection).
