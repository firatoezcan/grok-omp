# Usage, cost & context

OMP usage/cost reporting vs the pager's `/usage`, `/context`, credit bar, and session-info surfaces.

## Capability

- End-of-turn `usage_update`: OMP emits `{sessionUpdate:"usage_update", size, used, cost:{amount,currency:"USD"}}` where `size`/`used` are **context-window tokens**, not cumulative counters (`src/modes/acp/acp-agent.ts:2166-2180`). `cost` is the session's cumulative USD from `UsageStatistics.cost` (`src/session/session-entries.ts:326-337`: `input, output, cacheRead, cacheWrite, totalTokens, orchestrationInput/Output/CacheRead, premiumRequests, cost`).
- `session/prompt` responses carry a per-turn `usage` object (`acp-agent.ts:1010-1020`, `#buildTurnUsage`).
- `_omp/usage` ext method returns provider usage reports (rate-limit windows per authenticated account): `{reports: [...]}` (`acp-agent.ts:1177-1185`, backed by `fetchUsageReports`).
- `omp usage` CLI prints per-account provider limits/windows (`src/cli/usage-cli.ts`); `omp stats` prints aggregate token/cost stats (`src/cli/stats-cli.ts:79+`). Neither is reachable over ACP except `_omp/usage`.
- No per-model breakdown, no `modelUsage` map, no `numTurns` counter is emitted on the wire.

## Wire

- `x.ai/session/usage` `{sessionId}` → **bare** (no `result` envelope) `{usage: PromptUsage}` — decode at `app/effects/mod.rs:5092-5122`. `PromptUsage` = flattened `PromptUsageModel{input_tokens, output_tokens, total_tokens, cached_read_tokens, cache_creation_tokens, reasoning_tokens, model_calls, api_duration_ms, cost_usd_ticks?: i64 (1e10 ticks/$1), cost_is_partial}` + `modelUsage: {modelId: PromptUsageModel}` + `numTurns` + `usageIsIncomplete` (`xai-grok-shell/src/extensions/notification.rs:93-112,193-225`).
- `x.ai/session/info` `{sessionId}` → **enveloped** `{result: SessionInfoResponse}` where `SessionInfoResponse{sessionId, cwd, ...SessionInfoData flattened}` and `SessionInfoData.context: ContextInfo{used,total,systemPromptTokens,toolDefinitionsCount,toolDefinitionsTokens,compactionCount,turnCount,toolCallCount,messageCount,messageTokens,freeTokens,usagePct,autoCompactThresholdPercent,usageCategories:[{label,tokens,detail?}]}` (`xai-grok-shell/src/session/acp_types.rs:465-540,568-573`; fetch at `effects/mod.rs:5061-5087`). Note: this call site reads `response.result` — double-wrapped — unlike the bare-payload sites.
- `x.ai/billing` `{}` → `{config: BillingConfig{creditUsagePercent?, currentPeriod?{type,start,end}, monthlyLimit?, used?, onDemandCap?, onDemandUsed?, prepaidBalance?, isUnifiedBillingUser?, billingPeriodStart/End?, history:[BillingPeriodUsage]}, onDemandEnabled?, subscriptionTier?}`; `Cent{val}` = USD cents (`xai-grok-shell/src/extensions/billing.rs:14-113`; pager fetch `effects/mod.rs:4801+`).
- `x.ai/auto-topup-rule` → `{rule: {enabled, minBeforeHittingSl?, topupAmount?, maxAmountPerMonth?}}` (`billing.rs:115-133`).
- `usage_update` (standard ACP) also feeds the pager's context bar directly.

## Gap

Adapter today (`adapter.mjs`):

- `session/usage` answers `{usage:{numTurns:0, modelUsage:{}, usageIsIncomplete:true}}` (:788-798) — honest but empty. Improvement: OMP's cumulative `cost` IS known from `usage_update.cost.amount`; convert to `cost_usd_ticks` (`amount * 1e10`) and set `cost_is_partial:false`. `numTurns` can be counted by observing `session/prompt` responses. `modelUsage` stays empty (OMP doesn't break down per model over ACP) — keep `usageIsIncomplete:true` whenever a turn lacked cost data.
- `session/info` answers `{result:{sessionId,cwd,agentName,model,turns:0,context:{size,used}}}` (:773-787). Field mismatches to fix: pager's `ContextInfo` wants `used`/`total` (not `size`), `usagePct`, `freeTokens`, `turnCount`, `compactionCount`. Map `size→total`, compute `usagePct`/`freeTokens`, track `turns` from prompt responses. `usageCategories` could be populated from skills/MCP counts the adapter already knows (skills list, `mcpServers` from session/new) — optional.
- `x.ai/billing`, `x.ai/auto-topup-rule` → `-32601` (correct: OMP has no xAI billing concept; do NOT fabricate). The pager's credit bar simply stays hidden on error — verify `BillingError` path renders gracefully (`effects/mod.rs:4816+` returns `TaskResult::BillingError`).
- `_omp/usage` reports (provider rate limits) have no pager surface — the pager's `/usage` shows billing + session usage only. Optionally expose as a `usageCategories`-style note; not required.

## Render

- `RenderBlock::ContextInfo` (`scrollback/blocks/context_info.rs`) — `/context` block, rebuilt from the `ContextInfo` snapshot each redraw (`scrollback/block.rs:670-676`).
- Usage modal (`app/usage_modal.rs`) + credit bar (`views/credit_bar.rs`) — fed by `x.ai/session/usage` + `x.ai/billing`.
- Status/context bar (`views/context_bar.rs`) — fed by `usage_update` (already works).
- `/session-info` text + modal — `session_info_fields`/`format_session_info` (`effects/mod.rs:5185-5260`).

## Plan

1. `adapter.mjs` `ExtSurface`: track `turns` (increment on each `session/prompt` response) and `lastCost` (from `usage_update.cost.amount`).
2. `session/usage` answer: `{usage:{numTurns, modelUsage:{}, inputTokens:0, outputTokens:0, totalTokens:0, costUsdTicks: lastCost!=null ? Math.round(lastCost*1e10) : undefined, usageIsIncomplete:true}}` — keep `usageIsIncomplete` true because token counters are unknown; cost is real.
3. `session/info` answer: emit `context:{used, total:size, usagePct, freeTokens, turnCount:turns, compactionCount:0}` matching `ContextInfo` camelCase; keep the double-wrapped `{result:{...}}` envelope this call site expects.
4. Leave `x.ai/billing`/`x.ai/auto-topup-rule` as `-32601`; confirm the pager's `BillingError` path hides the credit bar without a toast loop.
5. Verify: tape with a `usage_update` carrying `cost` → `x.ai/session/usage` returns non-zero `costUsdTicks`; `/context` block shows real used/total.
