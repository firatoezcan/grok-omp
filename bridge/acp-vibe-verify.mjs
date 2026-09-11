#!/usr/bin/env bun
/**
 * acp-vibe-verify — stdio ACP exchange proving the patched OMP's mode surface.
 *
 * Usage: bun bridge/acp-vibe-verify.mjs [path-to-omp]
 * Default OMP: the patched build at
 *   ~/Projects/Freelancing/personal/oh-my-pi/packages/coding-agent/dist/omp
 * (built from oh-my-pi branch grok-omp/vibe-acp — see specs/vibe-mode.md).
 *
 * Covers: initialize, session/new mode listing, default↔vibe via both
 * session/set_mode and session/set_config_option, default↔plan via both APIs,
 * plan→vibe rejection (mutual exclusion), vibe→plan (vibe exits first), bogus
 * mode rejection, and the mode_change journal entries in the session JSONL.
 * Exits non-zero on any failed assertion.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";

const OMP =
	process.argv[2] ??
	join(homedir(), "Projects", "Freelancing", "personal", "oh-my-pi", "packages", "coding-agent", "dist", "omp");
const AGENT_DIR = "/tmp/acp-vibe-verify-agent";
const CWD = "/tmp/acp-vibe-verify-cwd";
await Bun.$`mkdir -p ${CWD} ${AGENT_DIR}`.quiet();

const proc = Bun.spawn([OMP, "acp"], {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: AGENT_DIR,
		PI_CONFIG_DIR: "/tmp/acp-vibe-verify-config",
	},
});

let buf = "";
const pending = new Map();
const notifications = [];
void (async () => {
	const dec = new TextDecoder();
	for await (const chunk of proc.stdout) {
		buf += dec.decode(chunk, { stream: true });
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (!line.trim()) continue;
			const msg = JSON.parse(line);
			if (msg.id !== undefined && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			} else {
				notifications.push(msg);
			}
		}
	}
})();
proc.stderr.pipeTo(
	new WritableStream({
		write(c) {
			process.stderr.write(`[omp] ${Buffer.from(c).toString()}`);
		},
	}),
);

let nextId = 1;
function call(method, params) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, resolve);
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`timeout: ${method}`));
			}
		}, 30_000);
		proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};
const lastModeUpdate = () =>
	[...notifications].reverse().find(n => n.params?.update?.sessionUpdate === "current_mode_update")?.params?.update
		?.currentModeId;

// --- handshake -------------------------------------------------------------
const init = await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
check("initialize", init.result?.protocolVersion !== undefined, JSON.stringify(init.result?.agentInfo ?? init.error));

const sess = await call("session/new", { cwd: CWD, mcpServers: [] });
const sessionId = sess.result?.sessionId;
check("session/new", !!sessionId, sess.error ? JSON.stringify(sess.error) : sessionId);
const modeIds = (sess.result?.modes?.availableModes ?? []).map(m => m.id);
check("availableModes = default,plan,vibe", ["default", "plan", "vibe"].every(m => modeIds.includes(m)), modeIds.join(","));
check("currentModeId is default", sess.result?.modes?.currentModeId === "default", sess.result?.modes?.currentModeId);

await sleep(150);
notifications.length = 0;

// --- plan mode via set_mode --------------------------------------------------
const p1 = await call("session/set_mode", { sessionId, modeId: "plan" });
check("set_mode plan ok", !p1.error, p1.error ? JSON.stringify(p1.error) : "");
await sleep(150);
check("current_mode_update → plan", lastModeUpdate() === "plan", lastModeUpdate());

// mutual exclusion: vibe entry while plan is active must be rejected
const px = await call("session/set_mode", { sessionId, modeId: "vibe" });
check("plan-active → set_mode vibe rejected", !!px.error, px.error?.message ?? "no error");
await sleep(100);
check("still in plan after rejected vibe", lastModeUpdate() === "plan", lastModeUpdate());

const p2 = await call("session/set_mode", { sessionId, modeId: "default" });
check("set_mode default exits plan", !p2.error, p2.error ? JSON.stringify(p2.error) : "");
await sleep(150);
check("current_mode_update → default", lastModeUpdate() === "default", lastModeUpdate());

// --- plan mode via set_config_option -----------------------------------------
const p3 = await call("session/set_config_option", { sessionId, configId: "mode", value: "plan" });
check("set_config_option mode=plan ok", !p3.error, p3.error ? JSON.stringify(p3.error) : "");
check(
	"configOptions mode currentValue=plan",
	p3.result?.configOptions?.find(o => o.id === "mode")?.currentValue === "plan",
	p3.result?.configOptions?.find(o => o.id === "mode")?.currentValue,
);
await sleep(150);
check("current_mode_update → plan (config path)", lastModeUpdate() === "plan", lastModeUpdate());

const p4 = await call("session/set_config_option", { sessionId, configId: "mode", value: "default" });
check("set_config_option mode=default exits plan", !p4.error, p4.error ? JSON.stringify(p4.error) : "");

// --- vibe mode via set_mode ---------------------------------------------------
const v1 = await call("session/set_mode", { sessionId, modeId: "vibe" });
check("set_mode vibe ok", !v1.error, v1.error ? JSON.stringify(v1.error) : "");
await sleep(150);
check("current_mode_update → vibe", lastModeUpdate() === "vibe", lastModeUpdate());

// vibe → plan: vibe exits first, then plan enters (implemented behavior)
const v2 = await call("session/set_mode", { sessionId, modeId: "plan" });
check("vibe-active → set_mode plan ok (vibe exits first)", !v2.error, v2.error ? JSON.stringify(v2.error) : "");
await sleep(150);
check("current_mode_update → plan (from vibe)", lastModeUpdate() === "plan", lastModeUpdate());

const v3 = await call("session/set_mode", { sessionId, modeId: "default" });
check("set_mode default exits plan again", !v3.error, v3.error ? JSON.stringify(v3.error) : "");

// --- vibe mode via set_config_option ------------------------------------------
notifications.length = 0;
const v4 = await call("session/set_config_option", { sessionId, configId: "mode", value: "vibe" });
check("set_config_option mode=vibe ok", !v4.error, v4.error ? JSON.stringify(v4.error) : "");
check(
	"configOptions mode currentValue=vibe",
	v4.result?.configOptions?.find(o => o.id === "mode")?.currentValue === "vibe",
	v4.result?.configOptions?.find(o => o.id === "mode")?.currentValue,
);
await sleep(150);
check("current_mode_update → vibe (config path)", lastModeUpdate() === "vibe", lastModeUpdate());

const v5 = await call("session/set_config_option", { sessionId, configId: "mode", value: "default" });
check("set_config_option mode=default exits vibe", !v5.error, v5.error ? JSON.stringify(v5.error) : "");
await sleep(150);
check("current_mode_update → default (from vibe)", lastModeUpdate() === "default", lastModeUpdate());

// --- rejection still works -----------------------------------------------------
const bad = await call("session/set_mode", { sessionId, modeId: "bogus" });
check("bogus mode rejected", !!bad.error, bad.error?.message);

// --- journal: mode_change entries prove the toolset switch ---------------------
await sleep(300);
const sessDir = join(AGENT_DIR, "sessions");
let vibeEntries = 0;
let previousToolsCount = 0;
try {
	for (const dir of readdirSync(sessDir)) {
		for (const file of readdirSync(join(sessDir, dir))) {
			if (!file.includes(sessionId) || !file.endsWith(".jsonl")) continue;
			for (const line of readFileSync(join(sessDir, dir, file), "utf8").split("\n")) {
				if (!line.includes('"mode_change"')) continue;
				const entry = JSON.parse(line);
				if (entry.mode === "vibe") {
					vibeEntries++;
					previousToolsCount = Math.max(previousToolsCount, entry.data?.previousTools?.length ?? 0);
				}
			}
		}
	}
} catch (e) {
	check("session journal readable", false, e.message);
}
check("journal has mode_change:vibe entries", vibeEntries >= 2, `${vibeEntries} entries`);
check("vibe entry snapshots previousTools", previousToolsCount > 5, `${previousToolsCount} tools`);

proc.stdin.end();
await Promise.race([proc.exited, sleep(3000)]);
proc.kill();
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
