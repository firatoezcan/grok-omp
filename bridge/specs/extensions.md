# Extensions: skills, hooks, plugins, MCP, marketplace

OMP's extension surface vs the pager's extensions modal tabs (hooks / plugins / marketplace / skills / MCPs).

## Capability

- **Skills**: `src/extensibility/skills.ts` — `Skill{name, description, path, ...}`; loaded from skill dirs + plugins; `parseSkillInvocation` makes `/skill-name` runnable as a prompt (:451); `session.skills` + `refreshSkills()` per session. Enable/disable via `disabledExtensions` setting, not per-skill config.
- **Hooks**: `src/extensibility/hooks/` — `HookEvent` union: session/context/before_agent_start/agent_start/agent_end/turn_start/turn_end/auto_compaction_start|end/auto_retry_start|end/ttsr_triggered/todo_reminder/tool_call/tool_result (`types.ts:388-404`). Hooks are extension-supplied TS handlers, not config-file command hooks.
- **Plugins**: `src/extensibility/plugins/manager.ts` — `PluginManager.install/uninstall/list/link/setEnabled/getEnabledFeatures/setEnabledFeatures/getPluginSettings/setPluginSetting/doctor` (:115-932). Marketplace dir exists (`plugins/marketplace/`).
- **MCP**: `src/mcp/manager.ts` — `MCPManager.discoverAndConnect/connectServers/disconnectServer/reconnectServer/readServerResource/executePrompt/refreshServerTools` (:200-1522). ACP `session/new` accepts `mcpServers` (http+sse advertised, `acp-agent.ts:659-662`). Server→client requests answered: `ping`, `roots/list` only (`manager.ts:903-915`) — **no `elicitation/create` handling**.
- **Unified listing**: `_omp/extensions` → `{extensions:[Extension{id,kind,name,description,path,source,state,disabledReason,shadowedBy}]}` and `_omp/extensions/toggle` `{providerId, enabled}` (`acp-agent.ts:1186-1202`; kinds incl. skills/hooks/plugins/mcp/prompts/rules/tools via `modes/components/extensions/state-manager.ts:75+`).

## Wire

Pager extensions modal fetches (all `ExtRequest`, envelope `{result:...}` tolerated):

- `x.ai/skills/list` `{cwd}` → `{skills:[SkillInfo{name,displayName?,description,hasUserSpecifiedDescription,paths?,whenToUse?,shortDescription?,author?,argumentHint?,license?,compatibility?,metadata?,...}]}` (`xai-grok-tools/.../skills/types.rs:41+`). Also `x.ai/skills/{add,remove,reset,toggle,config}` and `x.ai/workflows/list` `{sessionId}` → `{workflows:[...]}` (`xai-grok-shell/src/extensions/skills.rs:275-500`).
- `x.ai/hooks/list` `{sessionId}` → `{hooks:[HookInfo{name,event,handlerType,matcher?,command?,url?,timeoutMs,sourceDir,disabled,pinned,removable}], projectTrusted, loadErrors}` (`xai-hooks-plugins-types/src/lib.rs:218-260`). `x.ai/hooks/action` `{sessionId, action:{type:reload|trust|untrust|add{path}|remove{path}|enable{hookName}|disable{hookName}|toggleSource{hookNames,disable}}}` → `ActionOutcome{status,message,requiresReload,requiresRestart}` (`lib.rs:557-640`). Push: `SessionUpdate::HooksChanged{hooks,project_trusted,load_errors}`.
- `x.ai/plugins/list` `{sessionId}` → `{plugins:[PluginInfo{name,id,root,scope,trusted,enabled,version?,description?,skillCount,skillNames,agentCount,agentNames,hookStatus,hookCount,mcpServerCount,mcpStatus,marketplaceSource?,origin?,conflict?}]}` (`lib.rs:270-330`). `x.ai/plugins/action` `{sessionId, action:{type:reload|install{source}|uninstall{pluginId,confirmed?}|update{pluginId?}|add{path}|remove{path}|enable{pluginId}|disable{pluginId}}}` → `ActionOutcome`. `x.ai/plugins/reload`. Push: `PluginsChanged{plugins}`, `PluginUpdatesInstalled{updates}`.
- `x.ai/marketplace/list` → `{sources:[...]}`; `x.ai/marketplace/action` (`xai-grok-shell/src/extensions/marketplace.rs:22-23`).
- `x.ai/mcp/list` `{sessionId?, cache?}` → `{servers:[McpServerEntry{name,displayName?,icons,source:managed|local,sourceLabel?,setup?,setupValues?,config:{type:http{url,scope*}|stdio{command,args,env}|managedGateway},session?{enabled,status?ready|initializing|setupRequired|unavailable,tools:[McpToolEntry],authRequired,setupRequired,blockedReason?}}]}` (`xai-grok-shell/src/extensions/mcp.rs:51-160`). Mutation methods: `mcp/{toggle,toggle_tool,upsert,delete,setup,auth_status,auth_trigger,read_resource,call}`. Notifications: `x.ai/mcp/{servers_updated,tools_changed,init_progress,server_status,elicit_complete}` + `x.ai/mcp_initialized` (`acp_handler/mod.rs:600-606`, `mcp.rs`).
- `x.ai/mcp/elicit` (agent→client **request**): `{sessionId,toolCallId,serverName,message,mode:form{requestedSchema}|url{url,elicitationId}}` → `{outcome:accept{content?}|decline|cancel}` (`xai-grok-tools/src/mcp_elicitation/types.rs:43-80`; pager handler `acp_handler/interactions.rs:13+`).

## Gap

Adapter today: `hooks/list`→`{hooks:[],project_trusted:true,load_errors:[]}`, `plugins/list`→`{plugins:[]}`, `marketplace/list`→`{sources:[]}`, `skills/list`→`{skills:[]}`, `workflows/list`→`{workflows:[]}`, `mcp/list`→`{servers:[{name,session:{enabled:true}}]}` from session/new params only (`adapter.mjs:801-807,842-851`).

Real data is available but unused:

- **skills/list**: OMP skills are reachable only inside the agent process — no ACP getter. Options: (a) forward to a new `_omp/*` ext method (requires OMP change), (b) spawn `omp` CLI if it has a skills list verb, (c) keep empty. Cheapest honest populate: OMP writes skills into `available_commands_update`? No — commands are slash commands, not skills. Keep stub until an `_omp/skills` ext method exists; note `_omp/extensions` already returns skill-kind entries — **forward `x.ai/skills/list` → `_omp/extensions` and filter `kind=="skill"`**, mapping to `SkillInfo{name,description,paths}`.
- **hooks/list**: same play via `_omp/extensions` (`kind=="hook"`) → `HookInfo{name,event,handlerType:"command"|"http"→map,sourceDir:path,disabled:state=="disabled"}`. `hooks/action` enable/disable → `_omp/extensions/toggle` (providerId = extension id); reload/trust/untrust → error or no-op `ActionOutcome{status:"unsupported"}`.
- **plugins/list**: `_omp/extensions` `kind=="plugin"` → `PluginInfo{name,id,root:path,scope,enabled,version?,description?}`. `plugins/action` install/uninstall → no ACP path; error honestly (or spawn `omp plugin` CLI — `cli/plugin-cli.ts` exists).
- **mcp/list**: enrich from `_omp/extensions` `kind=="mcp"` entries (name, source, state) merged with session/new `mcpServers` (url/command). `session.enabled` from `state!="disabled"`; `session.status` unknown → omit. `mcp/toggle` → `_omp/extensions/toggle`. `mcp/{upsert,delete,setup,auth_*}` → `-32601` (OMP has `mcp/config-writer.ts` but no ACP surface).
- **mcp elicitation**: OMP never emits `x.ai/mcp/elicit` (it answers only ping/roots/list to servers). If OMP's MCP layer ever needs user input it uses standard `elicit/create` — which the pager does NOT implement (no `ElicitationRequest` in `xai-acp-lib` `AcpClientMessage`). Adapter translation opportunity: rewrite OMP `elicit/create` requests into `_x.ai/mcp/elicit` form-mode requests toward the pager, and map `{outcome:accept{content}}` back to `{action:"accept",content}`. See interaction.md.
- **marketplace**: OMP has `plugins/marketplace/` but no list/action over ACP → keep `{sources:[]}` or error; the tab renders empty either way.
- Push notifications `HooksChanged`/`PluginsChanged`/`mcp/servers_updated`: synthesize after a successful toggle action so the open modal refreshes (pager auto-refetches on `servers_updated` regardless of params — `mcp.rs:218+`).

## Render

- Extensions modal (`views/extensions_modal.rs`, `views/extensions_modal/`) — tabs: Hooks, Plugins, Marketplace, Skills, MCPs; each tab `TabDataState::{Loading,Loaded,Error}`.
- MCPs modal (`views/mcps_modal.rs`) — `McpsListResponse` decode, per-server rows with status/tools/auth.
- `x.ai/mcp/elicit` → elicitation view (`views/elicitation_view/`); `mcp_initialized` clears the "Starting session…" seed row (adapter already synthesizes it, `adapter.mjs:536`).

## Plan

1. `adapter.mjs`: add `_omp/extensions` forward helper (it's a real OMP ext method — no `_` prefix needed on our side; OMP's `extMethod` switch keys on the bare name).
2. `skills/list` → forward `_omp/extensions {cwd}`, translate: filter `kind=="skill"`, map `{name, displayName, description, path→paths?}`; `skills/toggle` → `_omp/extensions/toggle {providerId:id, enabled}` then answer `SkillsListResponse` shape.
3. `hooks/list` → same source, `kind=="hook"` → `HookInfo` (event from raw event name, `handlerType:"command"`, `sourceDir:path`, `disabled`); `hooks/action` enable/disable→toggle, others→`ActionOutcome{status:"unsupported",message:...}`.
4. `plugins/list` → `kind=="plugin"` → `PluginInfo` minimal; `plugins/action` enable/disable→toggle; install/uninstall→error.
5. `mcp/list` → merge session/new `mcpServers` with `_omp/extensions` mcp-kind entries; `mcp/toggle` → toggle; emit `_x.ai/mcp/servers_updated` after a successful toggle.
6. Keep `marketplace/list` `{sources:[]}`; `workflows/list` stays `{workflows:[]}` (OMP `task/commands.ts` workflow commands exist — could map later).
7. Verify: replay tape + a stubbed `_omp/extensions` response → modal tabs populate.
