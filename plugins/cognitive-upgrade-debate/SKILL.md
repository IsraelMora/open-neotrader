---
name: Cognitive Upgrade — Multi-Agent Debate Panel
description: Three-role trade review panel (bull / bear / risk-auditor) that gates high-impact tool_calls before dispatch. Ships INACTIVE by default.
---

# Multi-Agent Debate Panel

This plugin provides a three-role debate panel that reviews high-impact trades before they are dispatched. It implements the `[debate]` manifest capability introduced in F6 Slice 3.

## Roles

| Role | block | Purpose |
|------|-------|---------|
| `bull` | false | Argues in favor of the trade when the setup is sound |
| `bear` | false | Argues against the trade, focusing on risks and downside |
| `risk-auditor` | **true** | Hard-veto auditor: a `reject` from this role blocks the trade unconditionally |

### Consensus Algorithm

1. **Auditor veto first**: if `risk-auditor` returns `stance: "reject"`, the trade is blocked immediately (`auditor_blocked: true`). No majority calculation.
2. **Weighted majority**: `score = Σ(confidence × value)` where `approve = +1`, `reject = -1`, `abstain = 0`. If `score > 0` → approve; else → reject (tie breaks conservative).

## Activation

This plugin is **INACTIVE by default**. To activate the debate panel:

1. Activate the plugin:
   ```
   POST /plugins/cognitive-upgrade-debate/activate
   ```

2. Enable the debate gate in KV:
   ```
   POST /kv { "key": "debate.enabled", "value": "true" }
   ```

3. Optionally tune parameters:
   ```
   POST /kv { "key": "debate.min_notional_pct", "value": "0.05" }   # 5% of equity threshold
   POST /kv { "key": "debate.max_roles", "value": "3" }             # use all 3 roles
   POST /kv { "key": "debate.fail_mode", "value": "allow" }         # or "block"
   ```

## What Triggers a Panel

A panel runs IFF ALL of:
- `debate.enabled` KV = `"true"`
- This plugin is active (so `getActiveDebateRoles()` returns non-null)
- The tool_call is high-impact:
  - `promote_pretest` kernel call (always high-impact)
  - Provider trade whose `notional >= debate.min_notional_pct × account_equity`

Low-impact trades and all non-provider calls skip the panel entirely.

## Fail-Soft Behavior

`debate.fail_mode` KV (default: `"allow"`):
- `"allow"`: panel error or timeout → trade dispatched normally + `debate_skipped` audit event
- `"block"`: panel error or timeout → trade dropped + `debate_skipped` audit event

## Customizing Role Prompts

To use a custom prompt for a role, fork this plugin and:
- Replace the `prompt` field for any role in `manifest.toml`, OR
- Use `prompt_file = "MY_BULL_PROMPT.md"` pointing to a file in this directory.

Inline `prompt` always wins over `prompt_file` when both are set.

## Audit Events

When the panel runs, the following audit events are emitted in order:

| Event | When |
|-------|------|
| `debate_started` | Before any LLM calls |
| `debate_stance` ×N | After each role's response is parsed |
| `debate_consensus` | After synthesis; includes full stances array in meta |
| `debate_skipped` | When the panel is skipped due to error, timeout, or gating |

Query debate history: `GET /audit?event_type=debate_consensus`
