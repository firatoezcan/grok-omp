#!/usr/bin/env bun
/**
 * omp-providers-verify.mjs — drive the real pager under termctrl against the
 * adapter + stub OMP agent, open Settings › OMP › Providers, and assert the
 * provider sheet renders and an API-key connect persists to the isolated
 * agent.db.
 *
 * NOTE: the pager's MCP seed row animates ~30s after session create, so
 * waitForIdle never settles — this script waits on text + deadline captures.
 *
 *   bun bridge/omp-providers-verify.mjs
 */
import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const REPO = resolve(import.meta.dir, "..");
const PAGER = process.env.GROK_PAGER_BIN ?? join(REPO, "target/debug/xai-grok-pager");
const ADAPTER = join(REPO, "bridge", "adapter.mjs");
const STUB = join(REPO, "bridge", "omp-stub-agent.mjs");
const BUN = process.env.OMP_BRIDGE_BUN ?? "bun";

const PROFILE = mkdtempSync(join(tmpdir(), "omp-providers-verify-"));

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
	command: [
		PAGER,
		"--cwd", REPO,
		"--no-leader",
		"--agent-command", `${BUN} ${ADAPTER} --agent "${BUN} ${STUB}"`,
	],
	cwd: REPO,
	viewport: { cols: 110, rows: 34 },
	inheritEnv: true,
	env: {
		GROK_DEBUG_LOG: "/tmp/omp-providers-verify.log",
		PI_CODING_AGENT_DIR: PROFILE,
	},
});

const cap = () =>
	session.screen.capture({ settleMs: 400, deadlineMs: 4000, allowIncomplete: true });

try {
	// Boot readiness: the dock label renders once the agent handshake completes.
	await session.screen.waitForText("always-approve", { timeoutMs: 30_000 });

	// Open the settings modal via the /settings prompt command. Send it as one
	// raw write so the pager doesn't batch type+Enter into a bracketed paste.
	await session.keyboard.write(new TextEncoder().encode("/settings\r"));
	await session.screen.waitForText(/Settings/i, { timeoutMs: 8000 });

	// Filter to the Providers row (Browse mode: "/" focuses the filter).
	await session.keyboard.type("/", { paceMs: 30 });
	await session.keyboard.type("providers", { paceMs: 30 });
	let { text } = await cap();
	console.log("=== SETTINGS (filter: providers) ===\n" + text);
	const rowVisible = /Providers/.test(text);

	// Commit the filter (Enter in FilterFocused returns to Browse), then open the row.
	await session.keyboard.press("Enter");
	await session.keyboard.press("Enter");
	await session.screen.waitForText(/Anthropic|xAI|Loading providers/i, { timeoutMs: 10000 });
	({ text } = await cap());
	console.log("=== PROVIDERS SHEET ===\n" + text);

	const sheetChecks = {
		"providers row visible": rowVisible,
		"sheet title": /Providers/.test(text),
		"Anthropic listed": /Anthropic/.test(text),
		"xAI listed": /xAI/.test(text),
		"connect affordance": /connect|oauth|api key/i.test(text),
	};

	// Enter on the focused provider (first row = anthropic, kind "both" → API-key editor).
	await session.keyboard.press("Enter");
	await session.screen.waitForText(/API key/i, { timeoutMs: 8000 });
	({ text } = await cap());
	console.log("=== API KEY INPUT ===\n" + text);
	sheetChecks["api key editor"] = /API key/i.test(text);

	// Type a key and commit.
	await session.keyboard.type("sk-verify-test-key", { paceMs: 10 });
	({ text } = await cap());
	sheetChecks["key masked"] = !text.includes("sk-verify-test-key") && /\u2022/.test(text);
	await session.keyboard.press("Enter");
	await session.screen.waitForText(/connected|restart/i, { timeoutMs: 8000 });
	({ text } = await cap());
	console.log("=== AFTER CONNECT ===\n" + text);
	sheetChecks["connected status"] = /connected/i.test(text);
	sheetChecks["restart note"] = /restart|next grok-pi launch/i.test(text);

	// Verify the credential landed in the isolated agent.db.
	const db = new Database(join(PROFILE, "agent.db"));
	const rows = db.query(
		"SELECT provider, credential_type, data FROM auth_credentials WHERE provider = 'anthropic'",
	).all();
	db.close();
	console.log("=== DB ===\n" + JSON.stringify(rows));
	sheetChecks["agent.db row"] = rows.length === 1
		&& rows[0].credential_type === "api_key"
		&& JSON.parse(rows[0].data).key === "sk-verify-test-key";

	let ok = true;
	for (const [name, pass] of Object.entries(sheetChecks)) {
		console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
		ok &&= pass;
	}
	process.exitCode = ok ? 0 : 1;
} finally {
	await session.stop().catch(() => {});
	await tc.close().catch(() => {});
}
