#!/usr/bin/env bun
/**
 * grok-pi — launcher for the Grok Build TUI driven by Oh My Pi.
 *
 * Compiled to a standalone binary (`bun build --compile`). Resolves its two
 * siblings — the pager and the adapter — from its own install directory, so the
 * three ship together:
 *
 *   <dir>/grok-pi          this launcher
 *   <dir>/grok-pi-pager    the xai-grok-pager release binary
 *   <dir>/grok-pi-agent    the compiled adapter (bridge/adapter.mjs)
 *
 * Everything here is config or environment — no source patch (SPEC §8.1).
 * Extra args pass through to the pager.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve, delimiter } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";

// When compiled, process.execPath is the binary; when run under bun, argv[1].
const selfDir = dirname(process.execPath.endsWith("bun") ? resolve(process.argv[1]) : process.execPath);

const PAGER = process.env.GROK_PI_PAGER ?? join(selfDir, "grok-pi-pager");
const AGENT = process.env.GROK_PI_AGENT ?? join(selfDir, "grok-pi-agent");

// Isolated config/session/cache home — never touches a real ~/.grok install.
const GROK_HOME = process.env.GROK_HOME ?? join(homedir(), ".local", "share", "grok-pi");
mkdirSync(GROK_HOME, { recursive: true });

// Seed the de-brand config (SPEC §8.1) if absent or stale.
const seeded = join(selfDir, "config.toml");
const target = join(GROK_HOME, "config.toml");
if (existsSync(seeded) && (!existsSync(target) || true)) {
	copyFileSync(seeded, target);
	chmodSync(target, 0o600);
}

// --- Isolated OMP home -----------------------------------------------------
// Model/effort switches and session state must not write to the user's real
// ~/.omp during development. Point OMP at a dedicated config+agent dir under
// GROK_HOME. Auth still has to work, so on first run we seed the new agent.db
// from the default profile's via `VACUUM INTO` — a consistent snapshot of
// auth_credentials + settings that then diverges (dev writes stay isolated).
const OMP_HOME = join(GROK_HOME, "omp");
const OMP_AGENT_DIR = join(OMP_HOME, "agent");
mkdirSync(OMP_AGENT_DIR, { recursive: true });

const DEFAULT_AGENT_DIR = join(homedir(), ".omp", "agent");
const DEFAULT_AGENT_DB = join(DEFAULT_AGENT_DIR, "agent.db");
const ISOLATED_AGENT_DB = join(OMP_AGENT_DIR, "agent.db");
if (existsSync(DEFAULT_AGENT_DB)) {
	try {
		const { Database } = await import("bun:sqlite");
		const hasCreds = existsSync(ISOLATED_AGENT_DB)
			? new Database(ISOLATED_AGENT_DB, { readonly: true })
					.query("SELECT count(*) c FROM auth_credentials")
					.get()?.c > 0
			: false;
		if (!hasCreds) {
			const src = new Database(DEFAULT_AGENT_DB, { readonly: true });
			src.exec(`VACUUM INTO '${ISOLATED_AGENT_DB.replace(/'/g, "''")}'`);
			src.close();
		}
	} catch (e) {
		process.stderr.write(`grok-pi: could not seed OMP auth (${e?.message ?? e}); models may need re-auth\n`);
	}
}

// Seed config.yml (modelRoles, providers, advisor, …) so the isolated profile
// starts from the user's real defaults — the right default model included —
// then diverges. Only copied when absent so dev edits in the profile persist.
const DEFAULT_CONFIG = join(DEFAULT_AGENT_DIR, "config.yml");
const ISOLATED_CONFIG = join(OMP_AGENT_DIR, "config.yml");
if (existsSync(DEFAULT_CONFIG) && !existsSync(ISOLATED_CONFIG)) {
	try {
		copyFileSync(DEFAULT_CONFIG, ISOLATED_CONFIG);
	} catch (e) {
		process.stderr.write(`grok-pi: could not seed OMP config (${e?.message ?? e})\n`);
	}
}

// --- Advisor ---------------------------------------------------------------
// OMP's advisor (a second model reviewing each turn) is on by default;
// GROK_PI_ADVISOR=0 disables it. Rather than patch the seeded config.yml, ship
// a PI_CONFIG_FILES overlay (merges over global+project settings) that forces
// `advisor.enabled` and pins `modelRoles.advisor` to the real profile's
// advisor model when one is configured — else OMP's 'slow' priority chain
// resolves the role. `--advisor` on the agent command is the ephemeral
// override that survives any config drift.
const ADVISOR_ON = process.env.GROK_PI_ADVISOR !== "0";
if (ADVISOR_ON) {
	try {
		const realCfg = existsSync(DEFAULT_CONFIG) ? readFileSync(DEFAULT_CONFIG, "utf8") : "";
		const advisorModel = realCfg.match(/^ {2}advisor:\s*(\S+)\s*$/m)?.[1];
		const overlayPath = join(OMP_HOME, "grok-pi-advisor.yml");
		writeFileSync(
			overlayPath,
			"advisor:\n  enabled: true\n" +
				(advisorModel ? `modelRoles:\n  advisor: ${advisorModel}\n` : ""),
			{ mode: 0o600 },
		);
		const existing = process.env.PI_CONFIG_FILES;
		process.env.PI_CONFIG_FILES = existing ? `${existing}${delimiter}${overlayPath}` : overlayPath;
	} catch (e) {
		process.stderr.write(`grok-pi: could not write advisor overlay (${e?.message ?? e})\n`);
	}
	if (!process.env.OMP_ACP_CMD) {
		process.env.OMP_ACP_CMD = "omp acp --advisor";
	}
}

// Belt and braces: cover code paths that predate the config keys.
Object.assign(process.env, {
	GROK_HOME,
	// Isolated OMP home — the "second location" for dev-time model/effort
	// switches and session state. Real ~/.omp stays untouched.
	PI_CONFIG_DIR: OMP_HOME,
	PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
	GROK_DISABLE_AUTOUPDATER: "1",
	GROK_TELEMETRY_ENABLED: "false",
	DISABLE_TELEMETRY: "1",
	GROK_TELEMETRY_TRACE_UPLOAD: "false",
	GROK_FEEDBACK_ENABLED: "false",
});
delete process.env.SENTRY_DSN;
delete process.env.GROK_EXTERNAL_OTEL;

if (!existsSync(PAGER)) {
	process.stderr.write(
		`grok-pi: pager binary not found at ${PAGER}\n` +
			`  expected siblings: grok-pi-pager, grok-pi-agent (or set GROK_PI_PAGER/GROK_PI_AGENT)\n`,
	);
	process.exit(1);
}
if (!existsSync(AGENT)) {
	process.stderr.write(`grok-pi: adapter binary not found at ${AGENT}\n`);
	process.exit(1);
}

// --no-leader: never auto-spawn the leader process. --agent-command: OMP via
// the adapter (capability hygiene + tool shaping), not bare `omp acp`.
const args = [PAGER, "--no-leader", "--agent-command", AGENT, ...process.argv.slice(2)];
const proc = Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"], env: process.env });
const code = await proc.exited;
process.exit(code ?? 0);
