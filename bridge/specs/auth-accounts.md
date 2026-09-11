# Auth & accounts

OMP's multi-provider auth vs the pager's xAI-account login card, auth rail, and billing surfaces.

## Capability

- OMP `initialize` advertises `authMethods`: `[{id:"agent", name:"Use existing local credentials", description:"…~/.omp"}]`, plus `{id:"terminal", type:"terminal", name:"Set up Oh My Pi in terminal", args:[ACP_TERMINAL_AUTH_FLAG]}` when the client advertises `auth.terminal` (`src/modes/acp/acp-agent.ts:634-657`).
- `authenticate{methodId}` validates `methodId ∈ {agent, terminal}` (terminal only if advertised) and returns `{}` — auth is ambient (OMP's own credential store), not a handshake (:678-688).
- Multi-account: `AuthStorage` (`session/auth-storage.ts` → `@oh-my-pi/pi-ai`) holds per-provider api_key/oauth credentials; `omp usage` reports limits per account (`cli/usage-cli.ts`); `_omp/usage` exposes `{reports}` over ACP. No subscription/tier/billing concept.
- No login URL flow, no logout, no consent recording over ACP.

## Wire

- Login-card decision (`acp/mod.rs:540-569`, `event_loop.rs:1363-1440`): `needs_login` = first advertised authMethod whose id maps to an interactive kind — `AuthMethodKind::from_id` knows `"xai.api_key"|"cached_token"|"grok.com"|"oidc"`; only `grok.com`/`oidc` need interactive login (`xai-grok-shell/src/agent/auth_method.rs:234-266`). **OMP's `"agent"`/`"terminal"` → `Unknown` → no login card.** Eager auth then picks `defaultAuthMethodId` → `cached_token` → first method, and sends `authenticate{methodId:"agent"}` (`acp/mod.rs:695-735`) — which OMP accepts. So the flow works by accident; keep it deliberate.
- `x.ai/auth/get_url` `{}` → `{auth_url?, external_provider?, mode?}` — pager polls it 60×50ms after `authenticate` when an interactive method started (`effects/mod.rs:2313-2350`).
- `x.ai/auth/submit_code` `{code}` → `{submitted:true}` (`effects/mod.rs:2363`; shell `auth.rs:73-92`).
- `x.ai/auth/cancel` `{seq?}` → `{cancelled:true}`; `x.ai/auth/logout` `{...}` → clears auth (`auth.rs:94-143`).
- `x.ai/auth/info` → `{methodId?,email?,firstName?,lastName?,profileImageUrl?,teamId/Name/Role?,organizationId/Name/Role?,principalType?,principalId?,userBlockedReason?,teamBlockedReasons:[],codingDataRetentionOptOut:bool}` (`auth.rs:155-246`).
- `x.ai/auth/check_subscription` → `{...}` subscription re-check (`auth.rs:145-153`; pager `actions.rs:65,1978`).
- `x.ai/auth/getBearerToken` → `{token}`; legacy `x.ai/{getApiKey,setApiKey}` (`auth.rs:16-24`).
- `x.ai/consent/record` `{noticeId, version}` → `{noticeId, version}` (`consent.rs:16-95`; pager `effects/mod.rs:2183`).
- `x.ai/billing`, `x.ai/auto-topup-rule` — see usage-cost.md.

## Gap

- `authenticate` works today only because the pager falls back to `authMethods[0]` = `"agent"`. Fragile: if OMP ever lists `terminal` first, or the pager gains a `defaultAuthMethodId`, behavior shifts. Adapter should pin the outcome: leave `authMethods` as OMP sends them (both ids are `Unknown` kind → `needs_login=false`), and let the pager's eager `authenticate{methodId:"agent"}` pass through — it already does.
- `x.ai/auth/info` → `-32601` today. Partial synthesis is possible and honest: `{methodId:"agent", codingDataRetentionOptOut:true}` (fail-closed like the shell's no-credential default). Email/team fields stay absent — OMP has no xAI account. Optional; the pager tolerates sparse fields.
- `x.ai/auth/{get_url,submit_code,cancel,logout,check_subscription,getBearerToken,getApiKey,setApiKey}` → `-32601`. Correct: no xAI auth exists. `logout` erroring means the pager's `/logout` shows an error toast — acceptable and truthful (there is nothing to log out of at the ACP layer; OMP creds are managed by `omp` itself).
- `x.ai/consent/record` → `-32601` (consent notices are xAI-server-targeted; none will arrive for OMP anyway).
- `x.ai/billing`/`auto-topup-rule` → `-32601` (see usage-cost.md); pager hides the credit bar on `BillingError`.
- `_omp/usage` provider-limit reports have no pager surface — could feed a future `/usage` row; out of scope.

## Render

- Login card / welcome auth flow (`app/event_loop.rs:1363+`, `dispatch/auth.rs`) — correctly never triggers for OMP.
- `/logout`, `/login` actions; account/subscription rows in settings; credit bar (`views/credit_bar.rs`) — all error-path only.

## Plan

1. `adapter.mjs`: no change needed for the login card — verify on a live run that `needs_login` stays false (OMP's method ids are `Unknown` kind).
2. Optionally answer `x.ai/auth/info` with the minimal honest payload `{methodId:"agent", codingDataRetentionOptOut:true}` so any account row shows "local credentials" instead of erroring.
3. Keep every other `x.ai/auth/*`, `consent/record`, `billing`, `auto-topup-rule` as `-32601` with clear messages.
4. Verify: pager starts straight into the prompt (no login splash); `/logout` shows a clean error, not a hang.
