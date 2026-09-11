#!/usr/bin/env bun
/**
 * stt-shim — localhost WSS→OMP-STT bridge for the Grok pager's voice dictation.
 *
 * The pager dictates by streaming i16-LE PCM @16 kHz over a TLS WebSocket to
 * `wss://{api_base}/v1/stt` (xAI's wire protocol: `transcript.created`,
 * `transcript.partial`, `transcript.done`, `error`; client sends binary PCM
 * frames then `{"type":"audio.done"}`). OMP already ships a complete local STT
 * stack — Parakeet TDT v3 via sherpa-onnx (default) or Whisper via
 * transformers.js — but only as a Bun-IPC worker (`omp __omp_worker_stt`),
 * never as a socket. This shim is the irreducible bridge: it terminates TLS+WS
 * on 127.0.0.1 and forwards audio into a per-connection OMP worker, mapping
 * its events back onto the xAI vocabulary.
 *
 *   pager ──wss──▶ stt-shim ──Bun IPC──▶ omp __omp_worker_stt ──▶ sherpa/whisper
 *
 * Bearer is accepted and ignored (grok-pi seeds `XAI_API_KEY=dummy`; the pager
 * only requires *some* bearer to attempt the connection). TLS is mandatory on
 * the pager side, so the shim generates a tiny CA + localhost server cert under
 * --dir and reports the CA path; grok-pi exports it via GROK_EXTRA_CA_BUNDLE.
 *
 * Usage:
 *   bun stt-shim.mjs [--dir <cert/state dir>] [--port <n>] [--model <key>]
 *                    [--require-cached] [--check]
 *
 * Prints one JSON line on stdout once listening:
 *   {"type":"ready","port":N,"caPath":"…","model":"parakeet","modelCached":true}
 *
 * Env:
 *   GROK_PI_STT_MODEL    STT model key override (else agent.db stt.modelName,
 *                        else "parakeet")
 *   GROK_PI_STT_OMP_CMD  full worker command prefix override
 *                        (else derived from OMP_ACP_CMD, else "omp")
 *   PI_CODING_AGENT_DIR  OMP agent dir — locates the model cache and is
 *                        inherited by the worker (grok-pi sets the isolated one)
 *   OMP_NATIVE_LIBRARY_PATH  forwarded into LD_LIBRARY_PATH on linux, same as
 *                        OMP's own worker spawn glue
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// args + env
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flagValue(name) {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const CHECK_ONLY = args.includes("--check");
const REQUIRE_CACHED = args.includes("--require-cached") || process.env.GROK_PI_STT_REQUIRE_CACHED === "1";
const PORT = Number.parseInt(flagValue("--port") ?? process.env.GROK_PI_STT_PORT ?? "0", 10) || 0;
const CERT_DIR = resolve(
	flagValue("--dir") ??
		process.env.GROK_PI_STT_DIR ??
		join(process.env.GROK_HOME ?? join(homedir(), ".local", "share", "grok-pi"), "voice"),
);

function log(msg) {
	process.stderr.write(`stt-shim: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// STT model registry — mirrors OMP stt/models.ts + stt/downloader.ts cache
// checks. Keep in sync: keys are the `stt.modelName` values the worker accepts.
// ---------------------------------------------------------------------------

const STT_MODELS = {
	fast: { engine: "transformers", repo: "onnx-community/whisper-base" },
	balanced: { engine: "transformers", repo: "onnx-community/whisper-small" },
	turbo: { engine: "transformers", repo: "onnx-community/whisper-large-v3-turbo" },
	parakeet: {
		engine: "sherpa",
		repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
		files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
	},
};
const DEFAULT_MODEL = "parakeet";

/** Where the worker looks for models: $PI_CODING_AGENT_DIR/cache/tiny-models. */
function tinyModelsCacheDir() {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) return join(agentDir, "cache", "tiny-models");
	// Default profile: XDG_CACHE_HOME/omp wins on linux/darwin when it exists
	// (dirs.ts agentSubdir "cache" category), else ~/.omp/agent.
	const xdg = process.env.XDG_CACHE_HOME;
	if (xdg && (process.platform === "linux" || process.platform === "darwin")) {
		const appRoot = join(xdg, "omp");
		if (existsSync(appRoot)) return join(appRoot, "cache", "tiny-models");
	}
	return join(homedir(), ".omp", "agent", "cache", "tiny-models");
}

/** Read one key from the OMP settings table (values are JSON-serialized). */
function readAgentSetting(key) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	const dbPath = join(agentDir, "agent.db");
	if (!existsSync(dbPath)) return undefined;
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db.query("SELECT value FROM settings WHERE key = ?").get(key);
			if (row?.value === undefined) return undefined;
			const parsed = JSON.parse(row.value);
			return typeof parsed === "string" ? parsed : undefined;
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

function resolveModelKey() {
	const key = flagValue("--model") ?? process.env.GROK_PI_STT_MODEL ?? readAgentSetting("stt.modelName") ?? DEFAULT_MODEL;
	if (!STT_MODELS[key]) {
		log(`unknown stt model "${key}", falling back to ${DEFAULT_MODEL}`);
		return DEFAULT_MODEL;
	}
	return key;
}

/** Mirror of OMP isSttModelCached(): sherpa needs every file; whisper needs config + both onnx shards. */
function isModelCached(key) {
	const spec = STT_MODELS[key];
	const repoDir = join(tinyModelsCacheDir(), spec.repo);
	try {
		if (spec.engine === "sherpa") {
			const root = new Set(readdirSync(repoDir));
			return spec.files.every(f => root.has(f));
		}
		if (!readdirSync(repoDir).includes("config.json")) return false;
		let onnx = [];
		try {
			onnx = readdirSync(join(repoDir, "onnx"));
		} catch {}
		return onnx.some(f => f.startsWith("encoder") && f.endsWith(".onnx")) &&
			onnx.some(f => f.startsWith("decoder") && f.endsWith(".onnx"));
	} catch {
		return false;
	}
}

const MODEL_KEY = resolveModelKey();
const MODEL_CACHED = isModelCached(MODEL_KEY);
// The pager's `language` query param wins per connection; this is only the
// fallback when it sends nothing usable (it always sends a catalog code).
const DEFAULT_LANGUAGE = process.env.GROK_PI_STT_LANGUAGE ?? readAgentSetting("stt.language");

// ---------------------------------------------------------------------------
// TLS material: tiny local CA + leaf for localhost/127.0.0.1.
// rustls (the pager's TLS stack) requires a CA:TRUE anchor in the extra
// bundle, so a bare self-signed leaf is not enough — we mint a real CA and
// sign a server cert with it. openssl only; no deps.
// ---------------------------------------------------------------------------

const CA_KEY = join(CERT_DIR, "ca.key");
const CA_CERT = join(CERT_DIR, "ca.pem");
const LEAF_KEY = join(CERT_DIR, "localhost.key");
const LEAF_CERT = join(CERT_DIR, "localhost.pem");

function openssl(...args) {
	const r = spawnSync("openssl", args, { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`openssl ${args[0]}: ${(r.stderr || r.stdout || "").trim()}`);
	return r.stdout;
}

function certsValid() {
	if (![CA_CERT, LEAF_CERT, LEAF_KEY].every(existsSync)) return false;
	// Re-mint when the leaf is inside its last 30 days.
	const r = spawnSync("openssl", ["x509", "-checkend", String(30 * 86400), "-noout", "-in", LEAF_CERT]);
	return r.status === 0;
}

function ensureCerts() {
	if (certsValid()) return;
	mkdirSync(CERT_DIR, { recursive: true });
	const extFile = join(CERT_DIR, `localhost-ext-${process.pid}.cnf`);
	try {
		// CA (10y, self-signed root the pager trusts via GROK_EXTRA_CA_BUNDLE).
		openssl(
			"req", "-x509", "-newkey", "rsa:2048", "-nodes",
			"-keyout", CA_KEY, "-out", CA_CERT, "-days", "3650",
			"-subj", "/CN=grok-pi local voice CA",
			"-addext", "basicConstraints=critical,CA:TRUE",
			"-addext", "keyUsage=critical,keyCertSign,cRLSign",
		);
		// Leaf (825d) signed by the CA, SANs cover both localhost spellings.
		const csr = join(CERT_DIR, `localhost-${process.pid}.csr`);
		openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", LEAF_KEY, "-out", csr, "-subj", "/CN=localhost");
		writeFileSync(
			extFile,
			"basicConstraints=critical,CA:FALSE\n" +
				"keyUsage=critical,digitalSignature,keyEncipherment\n" +
				"extendedKeyUsage=serverAuth\n" +
				"subjectAltName=DNS:localhost,IP:127.0.0.1\n",
			{ mode: 0o600 },
		);
		openssl(
			"x509", "-req", "-in", csr,
			"-CA", CA_CERT, "-CAkey", CA_KEY, "-CAcreateserial",
			"-out", LEAF_CERT, "-days", "825", "-extfile", extFile,
		);
		rmSync(csr, { force: true });
		for (const f of [CA_KEY, LEAF_KEY, CA_CERT, LEAF_CERT]) {
			try {
				chmodSync(f, 0o600);
			} catch {}
		}
	} finally {
		rmSync(extFile, { force: true });
	}
}

// ---------------------------------------------------------------------------
// OMP STT worker subprocess (Bun IPC, serialization:"advanced").
// In:  {stream_start, stream_audio(Float32Array), stream_stop, stream_cancel}
// Out: {partial, segment, stream_done, error, progress, log, pong}
// ---------------------------------------------------------------------------

function tokenize(cmd) {
	return cmd.trim().split(/\s+/).filter(Boolean);
}

/** Command that re-enters the OMP CLI in worker mode. */
function ompWorkerCmd() {
	if (process.env.GROK_PI_STT_OMP_CMD) return [...tokenize(process.env.GROK_PI_STT_OMP_CMD), "__omp_worker_stt"];
	// OMP_ACP_CMD is e.g. "omp acp --advisor" — everything before `acp` is the
	// CLI invocation; swap the subcommand for the worker arg.
	const acp = process.env.OMP_ACP_CMD;
	if (acp) {
		const toks = tokenize(acp);
		const i = toks.indexOf("acp");
		if (i > 0) return [...toks.slice(0, i), "__omp_worker_stt"];
	}
	return ["omp", "__omp_worker_stt"];
}

function workerEnv() {
	const env = {};
	for (const k in process.env) {
		if (typeof process.env[k] === "string") env[k] = process.env[k];
	}
	// Mirror OMP's nativeLibraryPathOverlay: dlopen'd onnxruntime addons need
	// the packaged C++ runtime on linux.
	if (process.platform === "linux" && env.OMP_NATIVE_LIBRARY_PATH) {
		env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
			? `${env.LD_LIBRARY_PATH}:${env.OMP_NATIVE_LIBRARY_PATH}`
			: env.OMP_NATIVE_LIBRARY_PATH;
	}
	return env;
}

const STDERR_TAIL = 8 * 1024;
const liveWorkers = new Set();
let nextStreamId = 0;

/**
 * Spawn one worker per WS connection (dictation sessions are short and rare;
 * a warm shared worker would pin ~1 GB of model RAM forever). Returns null on
 * spawn failure. `onMessage`/`onExit` get the worker's outbound events.
 */
function spawnWorker({ onMessage, onExit }) {
	const stderrTail = { buf: "" };
	let proc;
	try {
		proc = Bun.spawn({
			cmd: ompWorkerCmd(),
			env: workerEnv(),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			serialization: "advanced",
			ipc(message) {
				onMessage(message);
			},
			onExit(_proc, exitCode, signalCode) {
				liveWorkers.delete(entry);
				const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
				onExit(new Error(`stt worker exited with ${reason}${stderrTail.buf ? ` — ${stderrTail.buf.trim()}` : ""}`));
			},
		});
	} catch (e) {
		log(`worker spawn failed: ${e?.message ?? e}`);
		return null;
	}
	const entry = { proc, send: msg => safeSend(proc, msg) };
	liveWorkers.add(entry);
	// Drain stderr into a bounded tail so a chatty native runtime can't block
	// on a full pipe and a crash surfaces its last lines.
	void (async () => {
		try {
			for await (const chunk of proc.stderr) {
				stderrTail.buf = (stderrTail.buf + Buffer.from(chunk).toString("utf8")).slice(-STDERR_TAIL);
			}
		} catch {}
	})();
	return entry;
}

function safeSend(proc, message) {
	try {
		const r = proc.send(message);
		if (r && typeof r.then === "function") r.then(undefined, () => {});
	} catch {}
}

// ---------------------------------------------------------------------------
// WSS server
// ---------------------------------------------------------------------------

if (CHECK_ONLY) {
	process.stdout.write(
		JSON.stringify({
			type: "check",
			model: MODEL_KEY,
			modelCached: MODEL_CACHED,
			cacheDir: tinyModelsCacheDir(),
			workerCmd: ompWorkerCmd(),
			certDir: CERT_DIR,
			certsValid: certsValid(),
		}) + "\n",
	);
	process.exit(0);
}

try {
	ensureCerts();
} catch (e) {
	// No openssl → no TLS → no shim. Report and exit non-zero so grok-pi can
	// fall back to voice-off.
	process.stdout.write(JSON.stringify({ type: "error", message: `cert generation failed: ${e?.message ?? e}` }) + "\n");
	process.exit(1);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	tls: {
		cert: readFileSync(LEAF_CERT, "utf8"),
		key: readFileSync(LEAF_KEY, "utf8"),
	},
	fetch(req, srv) {
		// Any path upgrades — the pager only ever dials {stt_ws_path}=/v1/stt,
		// and a wrong path is harmless on a loopback-only socket.
		if (srv.upgrade(req, { data: { url: req.url } })) return undefined;
		return new Response("stt-shim: websocket endpoint (wss://…/v1/stt)\n", { status: 400 });
	},
	websocket: {
		// Dictation can pause far longer than Bun's 120s default idle timeout.
		idleTimeout: 960,
		open(ws) {
			const conn = {
				worker: null,
				streamId: String(++nextStreamId),
				startedAt: Date.now(),
				done: false,
			};
			ws.data.conn = conn;
			log(`ws open ${new URL(ws.data.url).pathname}${new URL(ws.data.url).search} (stream ${conn.streamId})`);

			const send = obj => {
				try {
					ws.send(JSON.stringify(obj));
				} catch {}
			};

			const fail = message => {
				send({ type: "error", message });
				try {
					ws.close(1000);
				} catch {}
			};

			if (REQUIRE_CACHED && !MODEL_CACHED) {
				fail(
					`local STT model "${MODEL_KEY}" is not downloaded — run ` +
						`\`PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR ?? "~/.omp/agent"} omp setup speech\``,
				);
				return;
			}

			const worker = spawnWorker({
				onMessage(msg) {
					if (!msg || conn.done) return;
					switch (msg.type) {
						case "partial":
							// Volatile in-progress preview.
							send({ type: "transcript.partial", text: msg.text ?? "", is_final: false, speech_final: false });
							break;
						case "segment":
							// Endpointed utterance — speech_final is what commits text
							// into the pager's prompt box.
							send({ type: "transcript.partial", text: msg.text ?? "", is_final: true, speech_final: true });
							break;
						case "stream_done":
							conn.done = true;
							send({
								type: "transcript.done",
								text: msg.text ?? "",
								duration: (Date.now() - conn.startedAt) / 1000,
							});
							// Session is over; free the model RAM. SIGKILL is OMP's own
							// teardown (onnxruntime's NAPI finalizer segfaults on a
							// graceful exit — issue #1606).
							setTimeout(() => killWorker(conn), 250);
							break;
						case "error":
							send({ type: "error", message: String(msg.error ?? "stt worker error") });
							break;
						case "log":
							if (msg.level !== "debug") log(`worker ${msg.level}: ${msg.msg ?? ""}`);
							break;
						// pong / progress / transcription / downloaded: not used
						// by the streaming path; drop.
					}
				},
				onExit(err) {
					if (conn.done) return;
					conn.done = true;
					send({ type: "error", message: err.message });
					try {
						ws.close(1011);
					} catch {}
				},
			});
			if (!worker) {
				fail("could not spawn `omp __omp_worker_stt` — is omp on PATH?");
				return;
			}
			conn.worker = worker;

			// Ready gate: the pager awaits this ≤10s before streaming audio.
			send({ type: "transcript.created" });

			// Model load is deferred inside the worker; audio that arrives while
			// it loads is buffered by the endpointer.
			const url = new URL(ws.data.url);
			const language = url.searchParams.get("language") || DEFAULT_LANGUAGE;
			worker.send({ type: "stream_start", id: conn.streamId, modelKey: MODEL_KEY, ...(language ? { language } : {}) });
		},
		message(ws, message) {
			const conn = ws.data.conn;
			if (!conn || conn.done || !conn.worker) return;
			if (typeof message === "string") {
				// Only {"type":"audio.done"} is defined client→server; anything
				// else is ignored.
				if (message.includes("audio.done")) {
					conn.worker.send({ type: "stream_stop", id: conn.streamId });
				}
				return;
			}
			// Binary frame: i16-LE PCM @16 kHz → Float32Array for the worker.
			// Copy into a fresh Uint8Array first: a Buffer's byteOffset can be
			// odd, which Int16Array rejects.
			const bytes = new Uint8Array(message);
			const n = bytes.length - (bytes.length % 2);
			if (n <= 0) return;
			const pcm = new Int16Array(bytes.buffer, 0, n / 2);
			const audio = new Float32Array(n / 2);
			for (let i = 0; i < audio.length; i++) audio[i] = pcm[i] / 32768;
			conn.worker.send({ type: "stream_audio", id: conn.streamId, audio });
		},
		close(ws) {
			const conn = ws.data.conn;
			if (!conn) return;
			conn.done = true;
			killWorker(conn);
		},
	},
});

function killWorker(conn) {
	const worker = conn.worker;
	conn.worker = null;
	if (!worker) return;
	liveWorkers.delete(worker);
	try {
		worker.send({ type: "stream_cancel", id: conn.streamId });
	} catch {}
	try {
		worker.proc.kill("SIGKILL");
	} catch {}
}

// Ready line — grok-pi reads exactly one JSON line to learn the port + CA.
process.stdout.write(
	JSON.stringify({
		type: "ready",
		port: server.port,
		caPath: CA_CERT,
		model: MODEL_KEY,
		modelCached: MODEL_CACHED,
	}) + "\n",
);
log(`listening on wss://127.0.0.1:${server.port}/v1/stt (model=${MODEL_KEY}, cached=${MODEL_CACHED})`);

// ---------------------------------------------------------------------------
// lifecycle: die with the parent / on signal; never outlive the pager
// ---------------------------------------------------------------------------

function shutdown() {
	for (const w of [...liveWorkers]) {
		try {
			w.proc.kill("SIGKILL");
		} catch {}
	}
	try {
		server.stop();
	} catch {}
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Orphan watchdog: when grok-pi dies without killing us, ppid flips to 1
// (launchd) — exit rather than leak a listening socket + workers.
const parentPid = process.ppid;
setInterval(() => {
	if (process.ppid !== parentPid) shutdown();
}, 2000).unref();
