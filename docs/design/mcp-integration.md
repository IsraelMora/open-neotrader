# Blueprint: MCP (Model Context Protocol) Client Integration

> Status: DESIGN (not implemented). Produced from a comparison against
> NousResearch/hermes-agent, which supports MCP servers for extended tooling.

## 0. Goal & hard constraints

Let the trading agent consume tools from external MCP servers, WITHOUT violating
NeoTrader's security model:

- The Python sandbox (`apps/sandbox`) has **NO network**. Only
  `apps/api/src/providers` (`ProviderGateway`) makes outbound HTTP.
- The LLM only sees text/events, never raw price series.
- Every tool call passes through `_validateToolCalls` + the veto/HITL gate;
  max 3 tool calls per cycle.
- API keys flow only via env passthrough, never committed.

## 1. Load-bearing decision

**MCP tools mirror the existing `kernel` namespace, not the on-disk plugin
pattern.** Both tool-call parsers split on the first `__`
(`kernel-parser.ts:66`, `llm.service.ts:59`). By naming MCP tools
`mcp__<server>__<tool>`, the parser yields a synthetic `plugin_id = 'mcp'` with a
**dynamic registry** populated at runtime from connected MCP servers.

This means MCP tool calls flow through `[TOOL SCHEMA]` injection,
`_validateToolCalls`, the debate/veto gate, and audit **completely unchanged**,
while the Python sandbox is **never touched** (dispatch bypasses it via an `mcp`
branch in `_executeToolCalls`).

## 2. Where it lives

- **New module `apps/api/src/mcp/`** — client, registry, config services +
  controller. The MCP client is part of the TS provider/gateway layer (the only
  place allowed outbound network), modeled on
  `apps/api/src/providers/provider-gateway.service.ts` (egress +
  reconnect-on-event pattern).
- The sandbox and plugins remain network-free; MCP is an API-layer concern.

## 3. Tool mapping & dispatch

1. **Discovery**: on connect, the MCP client lists each server's tools and
   registers them in an in-memory registry as `ProviderTool` entries named
   `mcp__<server>__<tool>`, with the MCP tool's JSON input schema.
2. **Injection**: `runGovernedTurn` (~L675) merges the registry into the tool set
   so the LLM sees MCP tools in `[TOOL SCHEMA]` like any other tool.
3. **Validation**: `_resolveDropReason` (~L1495) recognises the `mcp` synthetic
   plugin and validates the call against the registry (default-deny if the
   server/tool is not in the active allow-list).
4. **Dispatch**: a new `_dispatchMcpTool` in `_executeToolCalls` (~L2449) routes
   `plugin_id === 'mcp'` calls to the MCP client instead of the sandbox; results
   return through the same path as sandbox results.
5. **Manifest type**: extend `PluginType` in `manifest.ts:7` with `'mcp'` if MCP
   servers are surfaced as plugin-like config entities.

## 4. Config & trust

- **Explicit allow-list** of MCP servers (transport: stdio / SSE / HTTP), enabled
  per-server by the operator. Default posture: **default-deny** — no server, no
  tool is callable until allow-listed.
- **Per-server tool allow-listing** — even on a trusted server, only named tools
  are exposed.
- **Credentials** via env passthrough, reusing the existing credentials/config
  services. Never committed.
- **Kill switch** via KV flag, consistent with existing KV-driven config.

## 5. Safety for a financial system

- Any MCP tool that could mutate state or place orders MUST route through the
  veto/HITL gate — the `mcp` namespace flows through `_validateToolCalls` and the
  debate/veto stage unchanged, so this is automatic, but the design must NOT add
  a bypass.
- **Fail-soft**: an MCP server that is down or slow must not break the cycle —
  timeouts + isolation; a failed MCP call drops like any denied tool call (safe
  direction), never throws into the loop.
- Read-only MCP tools first; state-mutating tools gated behind explicit operator
  opt-in + veto.

## 6. Phased plan

- **Phase 1 — Read-only MCP tools behind the veto gate.** New `apps/api/src/mcp/`
  module (client + registry + config + controller); `mcp` namespace recognised in
  the parser-driven validate/dispatch path; one stdio/SSE server in the
  allow-list; tools injected into `[TOOL SCHEMA]`. Tests: registry maps MCP tools
  to `mcp__server__tool`; unknown server/tool denied by `_resolveDropReason`;
  dispatch never calls the sandbox; server-down fails soft.
- **Phase 2 — Operator config UI + per-server tool allow-list + credentials.**
- **Phase 3 — State-mutating tools, explicit opt-in + veto, audit of every MCP
  call.**

## 7. Files touched (Phase 1)

- New: `apps/api/src/mcp/` (module + client/registry/config services + controller)
- Edit: `apps/api/src/agents/agents.service.ts` — registry merge (~L675),
  `_resolveDropReason` (~L1495), `_executeToolCalls` (~L2449), new
  `_dispatchMcpTool`
- Edit: `apps/api/src/plugins/manifest.ts:7` — `PluginType += 'mcp'`
- Reference model: `apps/api/src/providers/provider-gateway.service.ts`

## 8. Open questions for the operator

1. Which MCP servers do you actually want to connect, and over which transport?
2. Do MCP tools count against the 3-tool-calls-per-cycle budget (recommended:
   yes — same budget, no special-casing)?
3. Should state-mutating MCP tools ever be allowed, or read-only forever for a
   trading agent?
