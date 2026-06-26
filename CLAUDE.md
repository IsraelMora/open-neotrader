# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NeuroTrader (public: **open-neotrader**) is a self-hosted platform of AI trading agents. An LLM acts as an **orchestrator**: it reads textual context (news, events) and invokes whitelisted skills declared in Python plugins. By design the LLM is unconstrained at the kernel level — risk controls live in **opt-in plugins**, not hardcoded guardrails. The LLM never sees raw price series and never executes arbitrary code.

## Commands

`pnpm` lives at `~/.local/bin` — prepend it to PATH first: `export PATH="$HOME/.local/bin:$PATH"`.

```bash
# Monorepo-wide (Turborepo)
pnpm install
pnpm build          # turbo build (^build dependency order)
pnpm test           # turbo test
pnpm lint           # turbo lint

# apps/api (NestJS) — run from apps/api/
pnpm dev            # nest start --watch (:3000)
pnpm build          # nest build → dist/src/main.js (nest PRESERVES src/, entry is dist/src/main NOT dist/main)
pnpm test           # jest
pnpm test -- path/to/file.spec.ts            # single test file
pnpm test -- -t "describe or it name"        # single test by name
pnpm lint:fix
pnpm db:migrate     # prisma migrate deploy  (root db:migrate/db:generate delegate to the API's Prisma scripts)

# apps/sandbox (Python) — run from apps/sandbox/
python3 -m pytest                                          # all
python3 -m pytest tests/backtester/test_engine.py -v       # single file
python3 -m pytest -k "next_bar_open"                       # single test by name

# apps/web (Astro) — run from apps/web/. Uses pnpm like the rest of the monorepo.
pnpm dev            # :4321, proxies /api → :3000
pnpm build
```

All JS/TS projects use **pnpm** (never npm/yarn). The workspace sets `shared-workspace-lockfile=false`
in `.npmrc`, so each app keeps its own `pnpm-lock.yaml` — that's what the standalone Docker builds copy.

Quick sandbox smoke test (no NestJS): `echo '{"cmd":"list_plugins","active_ids":[]}' | python3 apps/sandbox/runner.py`

## Architecture

Monorepo: pnpm@9 workspace (`apps/*`, `packages/*`) + Turborepo.

```
Browser → nginx (apps/web) ── /        → Astro static panel
                            └─ /api/*   → apps/api (NestJS :3000)
                                            ├─ SQLite via Prisma 7 + better-sqlite3
                                            ├─ providers/  → ONLY place that makes outbound HTTP (OHLCV, LLM)
                                            └─ sandbox/    → spawns `python3 runner.py` per call
                                                              └─ runner.py → plugins/<id>/plugin.py
```

**Two NestJS apps:** `apps/api` (the agent runtime) and `apps/store` (separate plugin marketplace, own Prisma DB). They are independent Nest projects.

### The agent cycle (core flow)

`apps/api/src/cycle/cycle-executor.service.ts` orchestrates one run: gather textual context → call the LLM (`llm/`) → LLM emits tool calls limited to skills whitelisted in active plugins' `manifest.toml` → each call dispatched to the Python sandbox as a subprocess → results fed back. Hard limit: **3 tool calls per cycle** (anti-amplification). Trades pass through a **veto gate / HITL** stage — features must be opt-in, fail-soft, and never bypass the veto gate or flip trade direction.

### Security boundaries (non-negotiable)

- **The Python sandbox has NO network.** Only `apps/api/src/providers/` (ProviderGateway) makes outbound HTTP. Don't add network calls inside `apps/sandbox/` or plugins.
- The LLM only sees text/news/events — never price series.
- API keys flow only via env passthrough (`.env`, gitignored) — never baked into the image or committed. `.env.example` must stay credential-free.
- Plugins are baked into the image at `/plugins`; runtime installs (`POST /api/plugins/install`) write there too (hence `chown node:node /plugins` in the Dockerfile).

### Sandbox protocol (`apps/sandbox/runner.py`)

stdin→stdout JSON. Commands: `list_plugins`, `call_plugin` (only functions declared in `manifest.toml [skills]`), `run_cycle`. Always replies `{"ok": true, "result": ...}` or `{"ok": false, "error": "..."}`. `runner.py` lazy-imports `isolation.py` / `analyzer.py`.

### Plugins

37 plugins in `plugins/<id>/`, each with `manifest.toml` (id, type: `skill` | `universe_provider` | `discipline`, declared `[skills] keys`) and `plugin.py`. The Python SDK is `packages/plugin-sdk` (`neurotrader_sdk`).

### Backtester (`plugins/backtester/`)

Adapter-per-strategy pipeline. NestJS fetches OHLCV → `scripts/generate.py` slides over bars calling the real strategy's `analyze(bars[:i+1])` (**strict no-lookahead**) → `scripts/engine.py` `run_backtest()`. Engine correctness invariants enforced by tests: fills at the **NEXT bar's open** (not signal-bar close), CAGR annualized over the **calendar span**, `time_in_market_pct` from real trade durations. Don't regress these — see `apps/sandbox/tests/backtester/test_engine.py`.

## Conventions

- Strict TDD is active for this project — write the failing test first.
- Secrets only via `.env` (gitignored). Never commit credentials; keep `.env.example` clean.
- Git author identity for this repo is `OpenNeoTrader <noreply@open-neotrader.dev>`; conventional commits, no AI/Co-Authored-By attribution.
- ESLint v9 flat config across `apps/api` and `apps/web`, target zero problems — fix issues, don't add `eslint-disable` or downgrade rules.
- Docker build context is the monorepo root; `apps/api/Dockerfile` generates the Prisma client in the `deps` stage (both builder and runner copy `node_modules` from it).
