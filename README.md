<div align="center">

<h1>grok-pi</h1>

**The Grok Build TUI, driven by [Oh My Pi](https://github.com/can1357/oh-my-pi) — your models, your providers, not xAI.**

</div>

`grok-pi` is a fork of [`xai-org/grok-build`](https://github.com/xai-org/grok-build)
that keeps the full-screen Rust TUI — scrollback, modals, panes, voice,
subagent views — and swaps the agent: every prompt, tool call, and permission
is handled by OMP over ACP through a local bridge. Nothing talks to x.ai —
login, telemetry, billing, and the auto-updater are disabled or unanswered,
and xAI-only surfaces (credits, marketplace, rewind) error honestly instead
of pretending.

- **Bring your own model** — `/model` lists every model OMP resolves (51 in a
  typical profile) from any connected provider; `/effort` sets reasoning effort.
- **Hold the space bar to talk** — local push-to-talk dictation (Parakeet or
  Whisper); audio never leaves your machine.
- **`/vibe` director mode** — the main agent spawns and supervises persistent
  worker agents with live progress in the tasks pane (needs the patched OMP
  build, auto-detected).
- **Real sessions** — `/resume`, `/fork`, `/new`, prompt `/history`, and git
  worktrees, all on OMP's session store.
- **Usage & cost** — `/usage` reports turns, tokens, and cumulative USD cost;
  the context bar fills live.
- **Per-command toggles** — Settings › OMP lists every advertised slash
  command with an enable/disable switch.
- **Isolated profile** — everything lives under `~/.local/share/grok-pi`;
  your real `~/.grok` and `~/.omp` are never touched.
- **Advisor on by default** — a second model reviews each turn
  (`GROK_PI_ADVISOR=0` to disable).

## Quickstart

```sh
scripts/build-dist.sh   # build + install the dist bundle (~/.local/bin/grok-pi)
grok-pi                 # run from any project directory
```

Then: **hold the space bar** to dictate, **`/vibe`** to spin up worker agents,
**`/model`** to pick any provider's model.

**Full guide:** [`docs/GROK-PI.md`](docs/GROK-PI.md) — providers & auth, voice
setup, vibe mode, every slash command, and the honest limitations list.

---

*The rest of this file is the upstream `grok-build` build & development doc,
kept verbatim for working on the fork. `SOURCE_REV` records the upstream sync
point.*

[Installing the released binary](#installing-the-released-binary) ·
[Building from source](#building-from-source) ·
[Documentation](#documentation) ·
[Repository layout](#repository-layout) ·
[Development](#development) ·
[Contributing](#contributing) ·
[License](#license)

---

## Installing the released binary

Prebuilt binaries are published for macOS, Linux, and Windows:

```sh
curl -fsSL https://x.ai/cli/install.sh | bash   # macOS / Linux / Git Bash
irm https://x.ai/cli/install.ps1 | iex          # Windows PowerShell
grok --version
```

See the [changelog](https://x.ai/build/changelog) for the latest fixes,
features, and improvements in each release.

## Building from source

Requirements:

- **Rust** — the toolchain is pinned by [`rust-toolchain.toml`](rust-toolchain.toml);
  `rustup` installs it automatically on first build.
- **[DotSlash](https://dotslash-cli.com)** — required so hermetic tools under
  [`bin/`](bin/) (notably [`bin/protoc`](bin/protoc)) can download and run.
  Install it and ensure `dotslash` is on your `PATH` **before** building:

  ```sh
  cargo install dotslash
  # or: prebuilt packages — https://dotslash-cli.com/docs/installation/
  /usr/bin/env dotslash --help   # sanity check
  ```

- **protoc** — proto codegen resolves [`bin/protoc`](bin/protoc) via DotSlash,
  or falls back to a `protoc` on `PATH` / `$PROTOC`.
- macOS and Linux are supported build hosts; Windows builds are best-effort
  and not currently tested from this tree.

```sh
cargo run -p xai-grok-pager-bin              # build + launch the TUI
cargo build -p xai-grok-pager-bin --release  # release binary: target/release/xai-grok-pager
cargo check -p xai-grok-pager-bin            # fast validation
```

The binary artifact is named `xai-grok-pager`; official installs ship it as
`grok`. On first launch it opens your browser to authenticate — see the
[authentication guide](crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md).

## Documentation

Full online documentation is available at
[docs.x.ai/build/overview](https://docs.x.ai/build/overview).

The user guide ships with the pager crate:
[`crates/codegen/xai-grok-pager/docs/user-guide/`](crates/codegen/xai-grok-pager/docs/user-guide/)
— getting started, keyboard shortcuts, slash commands, configuration, theming,
MCP servers, skills, plugins, hooks, headless mode, sandboxing, and more.

For running this TUI against Oh My Pi (OMP) as the agent — the `grok-pi`
launcher, isolated profile, voice dictation, vibe mode, and which surfaces are
real vs. unsupported — see [`docs/GROK-PI.md`](docs/GROK-PI.md).

## Repository layout

| Path | Contents |
|------|----------|
| `crates/codegen/xai-grok-pager-bin` | Composition-root package; builds the `xai-grok-pager` binary |
| `crates/codegen/xai-grok-pager` | The TUI: scrollback, prompt, modals, rendering |
| `crates/codegen/xai-grok-shell` | Agent runtime + leader/stdio/headless entry points |
| `crates/codegen/xai-grok-tools` | Tool implementations (terminal, file edit, search, ...) |
| `crates/codegen/xai-grok-workspace` | Host filesystem, VCS, execution, checkpoints |
| `crates/codegen/...` | The rest of the CLI crate closure (config, MCP, markdown, sandbox, ...) |
| `crates/common/`, `crates/build/`, `prod/mc/` | Small shared leaf crates pulled in by the closure |
| `third_party/` | Vendored upstream source (Mermaid diagram stack) — see below |

> [!IMPORTANT]
> The root `Cargo.toml` (workspace members, dependency versions, lints,
> profiles) is **generated** — treat it as read-only. Prefer editing per-crate
> `Cargo.toml` files.

## Development

```sh
cargo check -p <crate>        # always target specific crates; full-workspace builds are slow
cargo test -p xai-grok-config # per-crate tests
cargo clippy -p <crate>       # lint config: clippy.toml at the repo root
cargo fmt --all               # rustfmt.toml at the repo root
```

## Contributing

> [!NOTE]
> External contributions are not accepted. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

First-party code in this repository is licensed under the **Apache License,
Version 2.0** — see [`LICENSE`](LICENSE).

Third-party and vendored code remains under its original licenses. See:

- [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) — crates.io / git dependencies,
  bundled UI themes, and **in-tree source ports** (including openai/codex and
  sst/opencode tool implementations)
- [`crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md`](crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md)
  — crate-local notice for the codex and opencode ports (license texts +
  Apache §4(b) change notice)
- [`third_party/NOTICE`](third_party/NOTICE) — vendored Mermaid-stack index
