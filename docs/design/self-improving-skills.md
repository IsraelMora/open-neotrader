# Blueprint: Guarded Self-Improvement of Skills from Real Outcomes

> Status: DESIGN (not implemented). Produced from a comparison against
> NousResearch/hermes-agent's self-improving skills.

## 0. Executive summary

The machinery for self-improvement already exists but is wired as **auto-apply**:
`kernel__write_skill` → `writeSkillGuarded` writes the SKILL.md file in-place the
moment a plugin sets `llm_writable: true`. For a LIVE trader this is the wrong
default, because `_loadSkillsSection` injects every active SKILL.md body into the
decision-turn system prompt (`llm.service.ts:288-302`). A self-edit is therefore
**not** cosmetic knowledge — it reshapes the reasoning that produces trades on the
very next cycle.

The design re-routes the existing guarded write into a **proposal queue**
(`proposed → approved → active`), modeled on the already-proven `TradeIntent`
HITL pattern (`trade-intent.service.ts`: `pending → approve/reject`). The LLM may
only PROPOSE. A human applies via a TOTP-gated REST call, which then calls the
existing `writeSkillGuarded` (keeping diff-cap + snapshot + audit). Nothing the
LLM does mutates a live skill body. This makes reckless self-edits structurally
impossible, not merely discouraged.

## 1. Patterns found (verified)

- **Neutral kernel principle** (CLAUDE.md): risk controls live in opt-in plugins;
  features must be opt-in, fail-soft, never bypass the veto gate, never flip
  trade direction.
- **Existing guarded write**: `PluginsService.writeSkillGuarded`
  (`plugins.service.ts:1113-1203`) — `llm_writable` gate, diff-cap (minLen 50,
  ratio 0.5), KV snapshot `skill_snapshot:<name>` (FIFO cap 5) with provenance,
  `skill_written`/`skill_write_denied` audit. `revertSkill` (1209) restores last
  snapshot.
- **Manifest opt-in field** already parsed: `manifest.plugin.llm_writable?`
  (`manifest.ts:70`). No plugin sets it.
- **Kernel reflection tool**: `KERNEL_WRITE_SKILL_TOOL` (`agents.service.ts:155`),
  injected only when `source === 'reflection'`, dispatched via `_kernelWriteSkill`
  (1642) → `writeSkillGuarded`.
- **HITL staging template to reuse**: `TradeIntentService`
  (`trade-intent.service.ts`) — `status:'pending'`, `approve(id, decided_by)`
  hard-guards `status !== 'pending'`, `reject`, `list(status)`.
- **TOTP/confirm precedent**: `kernel__promote_pretest` lands in
  `needs_confirmation`; only a TOTP REST call applies to live.
- **Outcome recording already present**: episodes (`_ltmRecordEpisode`),
  per-skill signal vectors (`_mlCaptureSignals`, keyed by `active_skill_hash`),
  outcomes backfilled posteriorly by `SnapshotService.updateOutcome` (no
  lookahead). Veto/decision audit events.
- **Reflection context**: `_assembleReflectionContext` (2819) aggregates audit,
  equity, veto summary, lessons, episodes under a 5000-char budget. Reflection
  runs out-of-band via `PanelService.reflectNow`, separate from the cycle ticker.

## 2. Decision

**Replace auto-apply with a human-gated proposal queue. The LLM proposes diffs;
humans approve; only approval invokes the existing `writeSkillGuarded`.**

1. `llm_writable` is redefined to mean "eligible to RECEIVE PROPOSALS", never
   "auto-editable". A second flag `llm_writable_scope = "knowledge"` constrains
   what may change.
2. A new `SkillProposal` entity mirrors `TradeIntent`:
   `proposed → approved → active | rejected | superseded`.
3. Approval (`POST /skills/proposals/:id/approve`, TOTP-gated) is the ONLY write
   path to a live skill body.

Rejected alternative: stronger diff-caps on auto-apply — a same-length rewrite
slips the ratio cap, and "recoverable via revert" is not good enough for money.

## 3. Components

- **`SkillProposal` (Prisma)** in `apps/api/prisma/schema.prisma`: `id` (`sp_`),
  `skill_name`, `plugin_id`, `base_body_hash` (staleness), `proposed_body`,
  `rationale`, `evidence_json`, `scope`, `status`, `created_by='llm'`,
  `decided_by`, `cycle_id`, timestamps, `diff_summary_json`.
- **`SkillProposalService`** (`apps/api/src/skill-proposal/`), mirror of
  `TradeIntentService`: `propose()` (pre-flight guards, persists `proposed`,
  never writes file), `list/pending`, `approve()` (hard-guard, staleness check,
  then `writeSkillGuarded`), `reject()`.
- **`SkillProposalController`**: `GET /skills/proposals[?status=]`,
  `GET /skills/proposals/pending`, `POST /skills/proposals/:id/approve` (TOTP),
  `POST /skills/proposals/:id/reject`. No external create route — proposals are
  born only inside reflection.
- **Kernel handler change**: `_kernelWriteSkill` (1642) calls
  `skillProposal.propose(...)` instead of `writeSkillGuarded`. Tool description
  rewritten to "propose for review".
- **Reflection enrichment**: `_assembleReflectionContext` gains a
  `[SKILL OUTCOME LEDGER]` section from ML per-skill aggregates + LTM episode
  outcomes + veto counts, within the existing budget.
- **Manifest scope flag**: add `llm_writable_scope?: 'knowledge'` to `manifest.ts`.

## 4. Opt-in & scope

```toml
[plugin]
llm_writable = true
llm_writable_scope = "knowledge"   # the ONLY accepted scope
```

Both flags required. Scope = the **prose body** of SKILL.md only. Reject in
pre-flight if the diff touches frontmatter, code fences, manifest/plugin.py/
tools.json/[skills], or contains decision-rule tokens (`buy`/`sell`/`direction:`).
Hard type check: `plugin.type === 'skill'` and id NOT in a protected set
(`risk-manager`, `position-sizing`, `decision`, `param-discipline`, disciplines,
providers). Even a knowledge edit to an active skill is trade-affecting (live
prompt injection), so scope limits content type, not approval requirement.

## 5. Outcome feedback loop

Runs inside `runReflectionTurn` (out-of-band, via `reflectNow`), never in
`_executeCycle`. All outcome data already captured with no lookahead. New
`_buildSkillOutcomeSection` joins per-skill aggregates + episode outcomes + veto
counts into a compact ledger; reflection LLM reads it and may emit
`kernel__write_skill` → enqueues a proposal. Cheap: reuse existing audit query,
hard char cap, top-N skills, dedupe near-identical proposals.

## 6. Guardrails (money)

1. **No auto-apply to live, ever** — kernel write path severed from filesystem;
   only `approve` (TOTP REST) calls `writeSkillGuarded`.
2. **HITL mandatory** for any skill change that could affect trade decisions
   (all active-skill edits). `proposed → (human + TOTP) → active`.
3. **Diff-cap retained** at approval; structural scope linter at propose-time.
4. **Staleness guard**: `base_body_hash`; if live body changed → `superseded`.
5. **KV snapshot + rollback** retained; `revertSkill` + `POST /skills/:name/revert`.
6. **Full audit**: `skill_proposed/approved/rejected/superseded` + existing
   `skill_written/reverted`.
7. **Scope fail-closed**: any guard miss → `ok:false` + audited denial.
8. **Kill switch**: KV flag `skill_proposals.enabled` (default off).

## 7. Separation from the live path

Authoring is out-of-band (reflection only). Application is out-of-band and
human-driven. Approved changes take effect on the NEXT cycle's prompt build (no
in-flight swap). The model proposes; it never mutates.

## 8. Phased plan

- **Phase 1 — Proposal queue, nothing auto-applies.** Prisma model + migration;
  `propose/list/pending` with full pre-flight; re-point `_kernelWriteSkill`;
  add `llm_writable_scope`; read-only controller; `skill_proposed` audit.
  TDD: propose denied for each guard; propose succeeds writing a row WITHOUT
  touching any SKILL.md (assert file unchanged on disk).
- **Phase 2 — Human approval applies via guarded write.** `approve/reject` with
  TOTP; superseded-on-drift; controller routes; revert; audit events.
- **Phase 3 — Outcome ledger feeding reflection.** `_buildSkillOutcomeSection`;
  inject `[SKILL OUTCOME LEDGER]` within budget. TDD: no-lookahead attribution.
- **Phase 4 (later) — Shadow validation.** Route an approved candidate through a
  pretest/virtual variant before it goes live.

## 9. Open questions for the operator

1. Accept that knowledge edits still change live behavior (approval always
   required)?
2. Which skills opt in? (Suggest one narrative skill; never disciplines/providers.)
3. Is the existing TOTP guard the right gate, or a separate two-person rule?
4. Reflection cadence vs. queue triage ownership?
5. Linter strictness vs. usefulness (recommend fail-closed)?
6. Rollback depth (KV ring cap 5 vs. per-proposal archive)?
7. Coarse outcome attribution by `active_skill_hash` acceptable in Phase 3?
