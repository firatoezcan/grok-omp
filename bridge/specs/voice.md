# Voice: dictation (mic → STT → prompt text)

How the pager's voice dictation works, what it needs that OMP doesn't have, and the minimal honest path.

## Capability

- **Pager side is fully client-side dictation.** Mic capture → streaming STT → transcript text lands in the prompt box. No audio ever crosses ACP; the agent only ever sees typed text via `session/prompt`. "Speech is transcribed straight into the prompt" (`xai-grok-pager/src/actions/defaults.rs:681`).
- **Triggers**: `/voice` slash command, `Ctrl+Space` (toggle; hold-to-talk on Kitty-protocol terminals), `F8` (`ActionId::VoiceToggle`, `actions/defaults.rs:669-683`; `Action::EnableVoiceMode`/`VoiceToggle`/`VoiceStop`, `app/actions.rs:161-169`), and **hold-spacebar push-to-talk** (`app/space_hold.rs`): a sustained space-bar hold is detected from the OS auto-repeat cadence (steady ~30–100 ms inter-space gaps; taps and jittery smashing never qualify, and a ≥10 ms floor keeps unbracketed pastes out), the few optimistically typed spaces are tracked back out, and recording runs hold-owned until the repeat stream goes idle for 250 ms — or until the real `KeyEventKind::Release` arrives on Kitty-protocol terminals. Esc / recording-row `[stop]` stop capture.
- **Gates**: `voice_mode_enabled` feature flag — GA default **on**, remote kill switch via `x.ai/settings/update` `voice_mode_enabled`, `GROK_VOICE_MODE` env, `[features] voice_mode` config (`app/mod.rs:272-298`). Tier gate `is_voice_tier_restricted` → SuperGrok upsell (`app_view.rs:1776`, `dispatch/voice.rs:86`). `AUDIO_SUPPORTED` compile flag (cpal on macOS/Windows, subprocess recorder on Linux; `xai-grok-voice/src/lib.rs:38`).
- **Capture**: cpal → mono i16 → resample to `voice.sample_rate` (default 16 kHz) → **i16 LE PCM bytes** (`audio/capture.rs:396-397`, `to_le_bytes`). On macOS/Linux capture runs in a short-lived `__mic-capture` helper process (`lib.rs:40-43`).
- **OMP side has a complete local STT stack** (`oh-my-pi/packages/coding-agent/src/stt/`): Parakeet TDT v3 via sherpa-onnx (default, SoTA) + Whisper base/small/large-v3-turbo via transformers.js (`stt/models.ts:58-119`), downloaded via `omp setup speech` / `omp tiny-models download`. Runs as a hidden worker subprocess `omp __omp_worker_stt` over Bun IPC `serialization:"advanced"` (`stt/asr-client.ts:71-83`, `subprocess/worker-client.ts:244`). Supports streaming sessions and takes **Float32Array 16 kHz mono** (`stt/asr-protocol.ts:23-51`, `asr-worker.ts:48`).

## Wire

Pager → STT server (nothing to do with ACP):

- `StreamingSttSession` opens **`wss://{api_base}/v1/stt`** with query params `sample_rate`, `encoding=pcm`, `interim_results`, `language`, `endpointing` (`stt/streaming.rs:26,231-245`; `config.rs:33-34`).
- `api_base` default `https://api.x.ai`; overridable via `[voice] api_base` / `[voice] stt_ws_path`, else inherits `[endpoints].xai_api_base_url` (`config.rs:51-77`). **TLS is mandatory** — `http://`/`ws://` are rejected outright ("Refusing to send the bearer token over a plaintext connection", `config.rs:95-101`). Extra roots load from `GROK_EXTRA_CA_BUNDLE` (fallback `SSL_CERT_FILE`) (`xai-grok-extra-ca/src/lib.rs:1-2,16-18`).
- Auth: `Authorization: Bearer <token>` resolved **per connection** from the shell `AuthManager` → `current_api_key_async()` (OAuth session or `XAI_API_KEY` / per-model `api_key`/`env_key`) (`stt/streaming.rs:42-47`; `auth.rs:24-31`; pager `voice/auth.rs:37-40`). No bearer → `VoiceError::Auth("not signed in — run grok login, set XAI_API_KEY, or set a model api_key/env_key")`.
- Client→server: binary PCM frames, then text `{"type":"audio.done"}` on channel close (`streaming.rs:80-89`).
- Server→client events (`stt/types.rs:6-32`): `transcript.created` (ready gate, awaited ≤10 s), `transcript.partial` `{text, is_final, speech_final}`, `transcript.done` `{text, duration}`, `error` `{message}`.
- Mapping to UI (`pipeline.rs:266-317`): `speech_final`/`transcript.done` → `VoiceEvent::UtteranceFinal` (committed into the prompt); non-final partials → `InterimTranscript` (volatile overlay). 10 s no-transcript watchdog → "No speech was detected" error (`pipeline.rs:169-182`).

OMP STT worker protocol (`stt/asr-protocol.ts:23-51`): in `{stream_start, stream_audio(Float32Array), stream_stop, stream_cancel, transcribe, download}`; out `{partial, segment(index,text), stream_done(text), transcription, progress, error}`.

## Gap

- **No xAI API behind OMP.** Under grok-pi the pager's `AuthManager` reads the isolated `GROK_HOME` (`~/.local/share/grok-pi`) — no `auth.json`, no `XAI_API_KEY` — so `require_bearer` fails and voice dies with "not signed in" before any socket opens. Even with a bearer, `api_base` defaults to `api.x.ai`, which OMP setups don't have.
- **OMP's STT is not a service.** It's an in-process client + Bun-IPC worker; nothing listens on a socket, and ACP exposes only `speech.models.list` (settings catalog metadata, `acp-agent.ts:105,1130-1131`) — no transcribe method. Incoming `session/prompt` audio blocks are dropped as `[audio omitted]` (`acp-agent.ts:1716-1717`), but that's moot: the pager never sends audio prompts anyway.
- **The irreducible piece is a localhost WSS shim** speaking the xAI STT wire protocol. Any local engine (OMP worker, whisper.cpp, macOS Speech) needs it regardless, because the pager demands `wss://` + bearer + the `transcript.*` event vocabulary. OMP's worker is the best backend: models, download, endpointing, and streaming sessions already exist, and `omp setup speech` is the install path.
- **Bearer**: the shim ignores the token, but the pager still requires one. Cheapest: `XAI_API_KEY=dummy` in `grok-pi.mjs` env — also flips `is_api_key_auth`, which force-enables voice and skips the tier gate (`app_view.rs:1425-1432`, `mod.rs:288`). Cleaner alternative: a `[models] api_key`/`env_key` in the seeded `config.toml` (no api-key probe on that path).
- **TLS**: shim needs a self-signed localhost cert; point `GROK_EXTRA_CA_BUNDLE` at it. `ws://` is not an option (`config.rs:95-101`).

## Render

- `voice_recording` layout row (`agent_view/render.rs:1317,2417-2422`) — 1-line "Recording" indicator + `[stop]` hitbox.
- Interim transcript renders as volatile prompt overlay; `UtteranceFinal` commits text at the caret. Voice targets the active agent prompt, dashboard dispatch input, or peek reply (`dispatch/voice.rs:28-50`).
- No adapter/ACP render work — transcript becomes ordinary prompt text; submission is the normal `session/prompt` path.

## Plan

1. `bridge/stt-shim.mjs` (Bun, spawned by `grok-pi.mjs` or folded into `adapter.mjs`): `Bun.serve` with `tls:{cert,key}` + WebSocket on `127.0.0.1:<port>`. Per connection: send `{"type":"transcript.created"}` on upgrade; buffer binary frames, convert i16 LE → Float32Array, forward as `stream_audio` to a spawned `omp __omp_worker_stt` (Bun `ipc` + `serialization:"advanced"`, env inherits `PI_CODING_AGENT_DIR` so it uses the isolated model cache); on `{"type":"audio.done"}` send `stream_stop`. Map out: `partial` → `transcript.partial{is_final:false}`, `segment` → `transcript.partial{speech_final:true}` (this is what commits text), `stream_done` → `transcript.done`, `error` → `error{message}`.
2. Seeded `config.toml`: `[voice] api_base = "https://localhost:<port>"` (or `wss://…`; both accepted). Optional `[voice] language`, `sample_rate` already defaults to 16 kHz.
3. `grok-pi.mjs`: generate/cache a self-signed localhost cert under `GROK_HOME`, set `GROK_EXTRA_CA_BUNDLE=<ca.pem>` and `XAI_API_KEY=local-voice` (or seed a model `api_key`) in the pager env.
4. Prereq surfaced to the user: `omp setup speech` (Parakeet download) inside the isolated `PI_CODING_AGENT_DIR`; shim answers `error{message:"run omp setup speech"}` when no model is cached.
5. Verify: e2e tape is impossible for real audio — smoke-test the shim with a synthetic PCM WAV→i16 stream, assert `transcript.created` → partials → `transcript.done`; then a live run pressing Ctrl+Space.
