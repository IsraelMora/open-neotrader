# Trading strategy — the applied edge (v1)

Status: design → implementation. Author: autonomous build session 2026-07-03.

## Goal & constraints

- **Objective**: a mathematically measurable, research-backed edge that survives out-of-sample — not a curve-fit. It must generate clean, debuggable data and must NOT be blow-up-prone (aligns with the safe-by-default kernel: drawdown halt, size ceiling, veto).
- **Substrate**: Alpaca (paper first), US ETFs, **daily** bars. LLM orchestrator + Python plugins; the LLM sees textual signals (never raw prices) and picks among whitelisted actions. Risk controls live in opt-in plugins + the kernel.
- **Broker reality**: fractional-friendly liquid ETFs, T+0 paper fills at next-bar open (matches the backtester's no-lookahead convention).

## The chosen edge: Dual / Time-Series Momentum + volatility targeting + trend regime filter

Momentum is the most-replicated market anomaly after value, documented across 200+ years and every asset class:

- **Time-Series Momentum (TSMOM)** — Moskowitz, Ooi & Pedersen (2012, *JFE*): an asset's own past 3–12 month return predicts its next-month return; t-stats are large and consistent across 58 instruments.
- **Cross-Sectional Momentum** — Jegadeesh & Titman (1993): rank assets by trailing return, hold winners.
- **Dual Momentum / GEM** — Antonacci (2014): combine **absolute** momentum (own trend vs. T-bills) with **relative** momentum (rank vs. peers). Rotates equities → bonds when trend breaks, historically cutting max drawdown roughly in half vs. buy-and-hold while keeping equity-like CAGR.
- **Volatility targeting** — Moreira & Muir (2017, *JF*): scaling exposure inversely to realized volatility raises Sharpe and cuts crash risk. Managed-futures trend funds do exactly this.

These compose into one coherent, defensible policy.

### The decision rule (precise, measurable)

For each rebalance (daily evaluation; rebalance on signal change, min-hold to bound turnover):

1. **Momentum score** per asset `i`: blended, skip-most-recent-month to avoid short-term reversal.
   `M_i = mean( r_i(1m,skip), r_i(3m), r_i(6m), r_i(12m) )` on total-return-adjusted closes, using the classic **12–1** (12-month return excluding the last month) as the anchor.
2. **Absolute-momentum filter (the crash guard)**: hold `i` only if `M_i > r_cash` (T-bill / BIL return) **and** `price_i > SMA200_i`. Otherwise that sleeve rotates to the defensive asset (short treasuries / BIL, or IEF/TLT if bonds are themselves in uptrend).
3. **Cross-sectional selection**: rank the assets that pass (1)+(2) by `M_i`; hold the **top K** (K ≈ 3–5).
4. **Volatility-targeted sizing**: weight `w_i ∝ 1/σ_i` (σ = trailing realized vol, e.g. 20–60d), scaled so **portfolio vol targets ≈ 10% annualized**; each `w_i` then clamped by the kernel's `max_position_pct`. This is inverse-vol / risk-parity sizing — no single position dominates.
5. **Exit**: when `i` fails (2) or drops out of top-K, close it (exits always reachable — kernel invariant). An ATR-based trailing stop (via the atr-stop-loss plugin) is a secondary, faster exit.

### Universe (liquid, diversified, momentum-friendly)

Classic dual-momentum / TSMOM rotation set — deep liquidity, low spreads, distinct return drivers:

- **Equities**: SPY (US large), QQQ (US tech/growth), IWM (US small), EFA (developed ex-US), EEM (emerging)
- **Bonds / defensive**: TLT (long UST), IEF (7–10y UST), BIL/SHY (T-bills = the "risk-off" destination)
- **Real assets**: GLD (gold), DBC (broad commodities)
- **Alternatives**: DBMF (managed futures — already in the account; convex crisis alpha)

Rationale: momentum rotation needs assets that (a) trend and (b) are imperfectly correlated so the relative-momentum switch has somewhere good to go. This set spans equity beta, duration, real assets, and trend-following — the diversification that makes the absolute-momentum switch protective rather than cosmetic.

## Why this and not the alternatives

- **Mean reversion / VWAP / bollinger intraday**: higher turnover, fragile to microstructure and costs, needs fast/clean fills — a poor fit for a daily LLM-orchestrated paper bot and easy to overfit.
- **Pairs / stat-arb**: cointegration is unstable out-of-sample (the repo's own pairs plugin has a leg-desync bug flagged separately); needs tight execution.
- **Single-name stock picking**: idiosyncratic risk, earnings gaps, no measurable systematic edge.
- **Momentum rotation** wins on all the axes the goal demands: **measurable** (Sharpe, t-stat, walk-forward), **robust** (most-replicated anomaly), **safe** (built-in trend/vol de-risking + the kernel halt), **low-touch** (daily, low turnover — ideal for generating clean data without churn).

## Measurability & validation (the gate to real money)

Every claim is checked with the repo's **no-lookahead backtester** (`plugins/backtester/`, next-bar-open fills, calendar-annualized CAGR):

- **Reported metrics**: CAGR, annualized Sharpe, max drawdown, Calmar, win rate, profit factor, time-in-market, turnover.
- **Walk-forward** (the `walk_forward_verdict` gate for real entries): rolling out-of-sample windows; a **ROBUSTO** verdict requires out-of-sample Sharpe that is positive and stable across folds (not a single in-sample peak). Real entries stay demoted to paper until ROBUSTO — exits always allowed.
- **The veto shield measures itself**: `cf_pnl` counterfactual attribution (now auto-backfilled) tells us, per decision, whether each veto/modification added or subtracted value — so the strategy and its guards are continuously graded on real data.

## Honest expectations

Dual momentum historically delivers ~mid-teens CAGR with ~15–20% max drawdown and Sharpe ~0.6–0.9 out-of-sample — **excellent** and, crucially, *durable*. It is the disciplined-compounding engine, not a get-rich-quick lever. Aggressiveness is dialed via the vol target and K, not by abandoning the edge. Data from live paper cycles feeds back into the parameters and the veto ledger — that is the improvement loop.

## Implementation plan (mapped to the system)

1. Set the **universe** to the list above.
2. Activate the coherent plugin stack: `momentum-factor-12-1` + `trend-following` (regime/SMA200) + `relative-strength` (cross-sectional rank) + `position-sizing` (inverse-vol/vol-target) + `risk-manager` + `macro-calendar-guard` (event blackout). Deactivate the noisy/fragile ones (intraday MR, pairs, wyckoff) for v1.
3. Encode the decision policy so the LLM's action follows the momentum/absolute-filter rule deterministically (signals carry explicit long/exit + rank + size).
4. Backtest → walk-forward → persist ROBUSTO.
5. Apply as the active strategy; enable real (paper) execution; let cycles run and accumulate data.

(Exact endpoints/config keys filled in from the codebase recon.)
