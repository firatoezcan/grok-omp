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
import { appendFileSync, mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";

// When compiled, process.execPath is the binary; when run under bun, argv[1].
const selfDir = dirname(process.execPath.endsWith("bun") ? resolve(process.argv[1]) : process.execPath);

const PAGER = process.env.GROK_PI_PAGER ?? join(selfDir, "grok-pi-pager");
const AGENT = process.env.GROK_PI_AGENT ?? join(selfDir, "grok-pi-agent");

// Isolated config/session/cache home — never touches a real ~/.grok install.
const GROK_HOME = process.env.GROK_HOME ?? join(homedir(), ".local", "share", "grok-pi");
mkdirSync(GROK_HOME, { recursive: true });

// Seed the de-brand config (SPEC §8.1). The seeded file wins per key, but the
// user's own keys (e.g. `[ui]` settings written by the pager's Settings modal)
// must survive — a blind copy would wipe them every launch. `[voice]` is
// stripped: the STT shim rewrites it below once the port is known.
const seeded = join(selfDir, "config.toml");
const target = join(GROK_HOME, "config.toml");

/** Parse a TOML file into { tables: Map<name, {keys: Map<key, line>, lines: string[]}>, order: [name] }.
 *  Line-oriented: `keys` maps `key = value` pairs inside `[table]` sections;
 *  `lines` keeps the table's raw body (comments included). */
function parseTomlTables(text) {
	const tables = new Map();
	const order = [];
	// Lines before the first table header (file-level comments, top-level keys).
	const preamble = [];
	let current = null;
	for (const line of text.split("\n")) {
		const header = line.match(/^\s*\[([^\]]+)\]/);
		if (header) {
			current = header[1].trim();
			if (!tables.has(current)) {
				tables.set(current, { keys: new Map(), lines: [] });
				order.push(current);
			}
			continue;
		}
		if (!current) {
			preamble.push(line);
			continue;
		}
		const entry = tables.get(current);
		entry.lines.push(line);
		const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
		if (kv) entry.keys.set(kv[1], line.trim());
	}
	return { tables, order, preamble };
}
/** Read one `[ui]` key from a TOML file. Returns the raw value string or undefined. */
function readUiKey(path, key) {
	if (!existsSync(path)) return undefined;
	try {
		const { tables } = parseTomlTables(readFileSync(path, "utf8"));
		const line = tables.get("ui")?.keys.get(key);
		if (!line) return undefined;
		return line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "");
	} catch {
		return undefined;
	}
}

/** Merge seeded config into the user's: seeded keys win, user extras survive. */
function mergeSeededConfig(seededPath, targetPath) {
	const seededText = readFileSync(seededPath, "utf8");
	if (!existsSync(targetPath)) {
		writeFileSync(targetPath, seededText, { mode: 0o600 });
		return;
	}
	const seed = parseTomlTables(seededText);
	const user = parseTomlTables(readFileSync(targetPath, "utf8"));
	const out = [];
	// Seed preamble (file-level comments / top-level keys) leads the output.
	for (const line of seed.preamble) out.push(line);
	for (const name of seed.order) {
		out.push(`[${name}]`);
		const seedEntry = seed.tables.get(name);
		const userKeys = user.tables.get(name)?.keys;
		// Seeded body verbatim (comments kept), then user keys the seed doesn't define.
		for (const line of seedEntry.lines) out.push(line);
		if (userKeys) for (const [k, line] of userKeys) if (!seedEntry.keys.has(k)) out.push(line);
		out.push("");
	}
	// User tables absent from the seed are appended verbatim (minus [voice]).
	for (const name of user.order) {
		if (seed.tables.has(name) || name === "voice" || name.startsWith("voice.")) continue;
		out.push(`[${name}]`);
		for (const line of user.tables.get(name).lines) out.push(line);
		out.push("");
	}
	writeFileSync(targetPath, out.join("\n"), { mode: 0o600 });
}

if (existsSync(seeded)) {
	try {
		mergeSeededConfig(seeded, target);
	} catch (e) {
		process.stderr.write(`grok-pi: config merge failed (${e?.message ?? e}); reseeding\n`);
		copyFileSync(seeded, target);
		chmodSync(target, 0o600);
	}
}

// [ui] settings the launcher honors (written by the pager's Settings › OMP
// section). Env vars still win over the file.
const UI_ADVISOR = readUiKey(target, "omp_advisor_enabled");
const UI_VOICE = readUiKey(target, "omp_voice_enabled");
const UI_STT_MODEL = readUiKey(target, "omp_stt_model");

// `[ui].omp_advisor_enabled` (Settings › OMP › Advisor) gates the advisor when
// `GROK_PI_ADVISOR` is unset; the env var still wins.
if (process.env.GROK_PI_ADVISOR === undefined && UI_ADVISOR === "false") {
	process.env.GROK_PI_ADVISOR = "0";
}
// `[ui].omp_voice_enabled` (Settings › OMP › Voice dictation) gates the STT shim
// when `GROK_PI_VOICE` is unset; the env var still wins.
if (process.env.GROK_PI_VOICE === undefined && UI_VOICE === "false") {
	process.env.GROK_PI_VOICE = "0";
}
// `[ui].omp_stt_model` (Settings › OMP › Voice model) feeds the shim's
// `GROK_PI_STT_MODEL` when the env var is unset.
if (process.env.GROK_PI_STT_MODEL === undefined && UI_STT_MODEL) {
	process.env.GROK_PI_STT_MODEL = UI_STT_MODEL;
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

// --- OMP command -----------------------------------------------------------
// Which `omp` the adapter spawns. Precedence:
//   1. OMP_ACP_CMD      — the adapter's own contract; a full ACP command line
//      used verbatim (e.g. "/path/to/omp acp --advisor").
//   2. GROK_PI_OMP_CMD  — the omp binary (or a full "... acp" command line);
//      "acp" is appended when absent and --advisor is added per GROK_PI_ADVISOR.
//   3. A patched OMP build at a known location — built from the oh-my-pi
//      source clone branch `grok-omp/vibe-acp` @ 9081533 (vibe-mode DRIVING
//      patch, bridge/specs/vibe-mode.md) at the clone's dist/omp, or a copy
//      dropped into $GROK_HOME/omp-build/omp.
//   4. Stock `omp` on PATH — vibe mode stays observe-only.
const PATCHED_OMP_CANDIDATES = [
	join(homedir(), "Projects", "Freelancing", "personal", "oh-my-pi", "packages", "coding-agent", "dist", "omp"),
	join(GROK_HOME, "omp-build", "omp"),
];
const OMP_ACP_CMD_USER_SET = process.env.OMP_ACP_CMD !== undefined;
const OMP_CMD =
	process.env.OMP_ACP_CMD ??
	(() => {
		const base = process.env.GROK_PI_OMP_CMD ?? PATCHED_OMP_CANDIDATES.find(p => existsSync(p)) ?? "omp";
		return /\bacp\b/.test(base) ? base : `${base} acp`;
	})();
process.env.OMP_ACP_CMD = OMP_CMD;

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
	// --advisor is appended only to a command grok-pi resolved itself — a
	// verbatim user-supplied OMP_ACP_CMD keeps full control of its flags.
	if (ADVISOR_ON && !OMP_ACP_CMD_USER_SET && !process.env.OMP_ACP_CMD.includes("--advisor")) {
		process.env.OMP_ACP_CMD = `${process.env.OMP_ACP_CMD} --advisor`;
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

// --- Voice (local STT shim) -------------------------------------------------
// The pager dictates over wss://{api_base}/v1/stt (TLS + bearer mandatory) —
// bridge/specs/voice.md. stt-shim.mjs terminates that socket on 127.0.0.1 and
// feeds OMP's `__omp_worker_stt` (Parakeet/Whisper, local). The worker
// downloads the model lazily on first use (same path `omp setup speech`
// exercises), so no upfront gate: voice is on whenever the shim can launch.
// GROK_PI_VOICE=0 disables; =1 is accepted for symmetry but unnecessary.
let sttShim = null;
const VOICE_MODE = process.env.GROK_PI_VOICE || undefined;
if (VOICE_MODE !== "0" && VOICE_MODE !== "false") {
	const shimCmd = process.env.GROK_PI_STT_SHIM
		? process.env.GROK_PI_STT_SHIM.split(/\s+/)
		: existsSync(join(selfDir, "grok-pi-stt"))
			? [join(selfDir, "grok-pi-stt")]
			: (() => {
					const bunExe = process.execPath.endsWith("bun") ? process.execPath : Bun.which("bun");
					const script = join(selfDir, "stt-shim.mjs");
					return bunExe && existsSync(script) ? [bunExe, script] : null;
				})();
	if (!shimCmd) {
		if (VOICE_MODE) process.stderr.write("grok-pi: voice requested but no stt-shim/bun found; voice disabled\n");
	} else {
		sttShim = await startSttShim(shimCmd);
		if (sttShim) {
			// Point the pager's STT socket at the shim. The seeded config.toml is
			// re-copied every launch, so append/replace the [voice] table here.
			try {
				const cfgPath = join(GROK_HOME, "config.toml");
				const lines = readFileSync(cfgPath, "utf8").split("\n");
				const kept = [];
				let skipping = false;
				for (const line of lines) {
					const header = line.match(/^\s*\[\[?([^\]]+)\]?\]/);
					if (header) {
						skipping = header[1].trim() === "voice" || header[1].trim().startsWith("voice.");
						if (skipping) continue;
					}
					if (!skipping) kept.push(line);
				}
				while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
				kept.push("", "[voice]", `api_base = "https://127.0.0.1:${sttShim.port}"`, "");
				writeFileSync(cfgPath, kept.join("\n"), { mode: 0o600 });
			} catch (e) {
				process.stderr.write(`grok-pi: could not seed [voice] config (${e?.message ?? e}); voice disabled\n`);
				sttShim.proc.kill("SIGTERM");
				sttShim = null;
			}
		}
		if (sttShim) {
			// The pager demands TLS + a bearer; the shim ignores the token.
			// XAI_API_KEY=dummy also flips is_api_key_auth, which force-enables
			// voice and skips the SuperGrok tier gate — but never clobber a real
			// key the user exported.
			if (!process.env.XAI_API_KEY) process.env.XAI_API_KEY = "local-voice";
			// Trust the shim's CA. If the user already has an extra bundle,
			// concatenate so their roots survive.
			let bundle = sttShim.caPath;
			const existingBundle = process.env.GROK_EXTRA_CA_BUNDLE ?? process.env.SSL_CERT_FILE;
			if (existingBundle && existsSync(existingBundle) && existingBundle !== sttShim.caPath) {
				try {
					bundle = join(GROK_HOME, "voice", "extra-ca-bundle.pem");
					writeFileSync(
						bundle,
						readFileSync(sttShim.caPath, "utf8") + "\n" + readFileSync(existingBundle, "utf8"),
						{ mode: 0o600 },
					);
				} catch {
					bundle = sttShim.caPath;
				}
			}
			process.env.GROK_EXTRA_CA_BUNDLE = bundle;
		}
	}
}

/**
 * Spawn the shim and read its single ready line:
 *   {"type":"ready","port":N,"caPath":"…","modelCached":bool}
 * Returns null (shim dead / timed out) so the caller can run voice-off.
 * Shim stderr is drained into a log file — the pager owns the TTY.
 */
async function startSttShim(cmd) {
	const logPath = join(GROK_HOME, "stt-shim.log");
	let proc;
	try {
		proc = Bun.spawn(cmd, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
	} catch (e) {
		process.stderr.write(`grok-pi: stt-shim spawn failed (${e?.message ?? e}); voice disabled\n`);
		return null;
	}
	// Drain stderr → log file so a noisy worker never stalls on a full pipe.
	void (async () => {
		try {
			for await (const chunk of proc.stderr) appendFileSync(logPath, Buffer.from(chunk));
		} catch {}
	})();
	const firstLine = (async () => {
		let buf = "";
		try {
			for await (const chunk of proc.stdout) {
				buf += Buffer.from(chunk).toString("utf8");
				const nl = buf.indexOf("\n");
				if (nl >= 0) return buf.slice(0, nl);
			}
		} catch {}
		return null;
	})();
	const timeout = new Promise(r => setTimeout(() => r("timeout"), 10_000));
	const line = await Promise.race([firstLine, proc.exited.then(() => null), timeout]);
	if (typeof line !== "string") {
		process.stderr.write("grok-pi: stt-shim did not report ready; voice disabled\n");
		proc.kill("SIGTERM");
		return null;
	}
	try {
		const ready = JSON.parse(line);
		if (ready.type !== "ready") throw new Error(ready.message ?? "not ready");
		return { proc, port: ready.port, caPath: ready.caPath, modelCached: ready.modelCached === true };
	} catch (e) {
		process.stderr.write(`grok-pi: stt-shim bad ready line (${e?.message ?? e}); voice disabled\n`);
		proc.kill("SIGTERM");
		return null;
	}
}

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
// The pager owns the session lifecycle; voice dies with it.
if (sttShim) {
	try {
		sttShim.proc.kill("SIGTERM");
	} catch {}
}
process.exit(code ?? 0);
