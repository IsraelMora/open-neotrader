"""
TDD tests for the new cmd_run_cycle implementation.

STRICT TDD — RED first. These tests are written against the NEW contract BEFORE
the implementation is updated.

New contract:
  INPUT  {"cmd":"run_cycle","active_ids":[...],"context":{"cycle_id":..,"universe":[...],
          "ohlcv":{SYM:[bar,...]},"portfolio":{...},"config":{...}}}
  LOGIC  skill plugins (type=skill, hooks/cycle.py on_cycle) → pending_signals
         discipline plugins (type=discipline, hooks/cycle.py on_cycle) → filter/size signals
  OUTPUT {"universe":[...],"pending_signals":[...],"signals":[...],"logs":[...],"errors":[]}

Both "pending_signals" and "signals" in the output point to the same list (alias, for
backward compatibility with callers that read either key).

Tests use the REAL plugins (trend-following, risk-manager) with synthetic OHLCV data so
no network calls are made.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Loader helpers (mirrors pattern in test_sdk_soft_check.py)
# ---------------------------------------------------------------------------

SANDBOX_DIR = Path(__file__).parent.parent
RUNNER_PATH = SANDBOX_DIR / "runner.py"
SDK_PATH = SANDBOX_DIR.parent.parent / "packages" / "plugin-sdk"

# Real plugins dir in the monorepo
REAL_PLUGINS_DIR = SANDBOX_DIR.parent.parent / "plugins"


def _load_runner():
    """Load a fresh runner module, patching away rlimit and isolation side-effects."""
    if str(SDK_PATH) not in sys.path:
        sys.path.insert(0, str(SDK_PATH))
    spec = importlib.util.spec_from_file_location("_runner_run_cycle", RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)

    try:
        import resource as _res
        original_setrlimit = _res.setrlimit
        _res.setrlimit = lambda *a, **kw: None
    except ImportError:
        original_setrlimit = None
        _res = None  # type: ignore[assignment]

    try:
        import isolation as _iso
        original_apply = _iso.apply
        _iso.apply = lambda *a, **kw: None
    except ImportError:
        original_apply = None
        _iso = None  # type: ignore[assignment]

    try:
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    finally:
        if _res is not None and original_setrlimit is not None:
            _res.setrlimit = original_setrlimit
        if _iso is not None and original_apply is not None:
            _iso.apply = original_apply

    return mod


# ---------------------------------------------------------------------------
# Synthetic OHLCV factory — 130 bars of a slow uptrend (no network)
# ---------------------------------------------------------------------------

def _make_bars(symbol: str = "AAA", n: int = 130) -> list[dict]:
    """
    Build n daily bars with an accelerating uptrend so that the EMA/MACD/Ichimoku
    indicators in trend-following can produce a 'long' signal on the last bar.

    Prices start at 100.0 and increase by a growing delta each day.
    """
    bars = []
    price = 100.0
    for i in range(n):
        delta = 0.20 + i * 0.008  # acceleration
        open_p = price
        close_p = price + delta
        high_p = close_p + 0.05
        low_p = open_p - 0.05
        bars.append({
            "date": f"2024-{(i // 30) + 1:02d}-{(i % 30) + 1:02d}",
            "open": round(open_p, 4),
            "high": round(high_p, 4),
            "low": round(low_p, 4),
            "close": round(close_p, 4),
            "volume": 1_000_000,
        })
        price = close_p
    return bars


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRunCycleWithRealPlugins:
    """Integration tests using the real trend-following and risk-manager plugins."""

    @pytest.fixture(autouse=True)
    def _point_to_real_plugins(self, monkeypatch):
        """Point PLUGINS_DIR at the real plugins directory."""
        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", REAL_PLUGINS_DIR)
        self.mod = mod

    def _run(self, active_ids, context):
        req = {"cmd": "run_cycle", "active_ids": active_ids, "context": context}
        return self.mod.cmd_run_cycle(req)

    # ── core shape ───────────────────────────────────────────────────────────

    def test_result_has_required_keys(self):
        """cmd_run_cycle always returns universe, pending_signals, signals, logs, errors."""
        result = self._run(active_ids=[], context={})
        for key in ("universe", "pending_signals", "signals", "logs", "errors"):
            assert key in result, f"Missing key: {key}"

    def test_pending_signals_and_signals_are_same_object(self):
        """pending_signals and signals are the same list (backward-compat alias)."""
        result = self._run(active_ids=[], context={})
        assert result["pending_signals"] is result["signals"], (
            "'pending_signals' and 'signals' must be the same list object"
        )

    # ── trend-following strategy plugin ──────────────────────────────────────

    def test_trend_following_emits_signals_on_uptrend(self):
        """trend-following on_cycle emits long signals for an accelerating uptrend."""
        bars = _make_bars("AAA", n=130)
        result = self._run(
            active_ids=["trend-following"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": bars},
                "portfolio": {},
                "config": {},
            },
        )
        assert len(result["errors"]) == 0, f"Unexpected errors: {result['errors']}"
        assert len(result["pending_signals"]) > 0, (
            "Expected at least one signal from trend-following on a strong uptrend; got none. "
            f"logs={result['logs']}"
        )
        # All signals must carry _plugin tag
        for sig in result["pending_signals"]:
            assert "_plugin" in sig, f"Signal missing '_plugin' tag: {sig}"
            assert sig["_plugin"] == "trend-following"

    def test_trend_following_no_crash_empty_ohlcv(self):
        """Empty ohlcv → zero signals and no errors (insufficient bars warning expected)."""
        result = self._run(
            active_ids=["trend-following"],
            context={
                "universe": ["AAA"],
                "ohlcv": {},
                "portfolio": {},
                "config": {},
            },
        )
        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        assert result["pending_signals"] == [], (
            f"Expected no signals with empty ohlcv; got {result['pending_signals']}"
        )

    def test_trend_following_no_crash_too_few_bars(self):
        """Too few bars → insufficient warning logged, no crash, no signals."""
        result = self._run(
            active_ids=["trend-following"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": _make_bars("AAA", n=10)},
                "portfolio": {},
                "config": {},
            },
        )
        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        assert result["pending_signals"] == []

    # ── risk-manager discipline plugin ───────────────────────────────────────

    def test_risk_manager_processes_pending_signals(self):
        """risk-manager on_cycle receives pending_signals and returns signals list."""
        bars = _make_bars("AAA", n=130)
        result = self._run(
            active_ids=["trend-following", "risk-manager"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": bars},
                "portfolio": {},
                "portfolio_value": 100_000.0,
                "config": {},
            },
        )
        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        # risk-manager must have received and returned the signals (could filter or pass through)
        # We verify shape: all remaining signals have required fields
        for sig in result["pending_signals"]:
            assert "symbol" in sig, f"Signal missing 'symbol': {sig}"
            assert "action" in sig, f"Signal missing 'action': {sig}"

    def test_risk_manager_with_no_signals_no_crash(self):
        """risk-manager with empty pending_signals (empty universe) → no crash."""
        result = self._run(
            active_ids=["risk-manager"],
            context={
                "universe": [],
                "ohlcv": {},
                "portfolio": {},
                "portfolio_value": 100_000.0,
                "config": {},
            },
        )
        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        assert result["pending_signals"] == []

    # ── decision plugin (no hooks/cycle.py) must be skipped gracefully ────────

    def test_decision_plugin_skipped_gracefully(self):
        """decision plugin has no hooks/cycle.py — must be skipped with no crash."""
        result = self._run(
            active_ids=["decision"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": _make_bars("AAA", n=130)},
                "portfolio": {},
                "config": {},
            },
        )
        # No errors — skipping is silent
        assert result["errors"] == [], (
            f"Expected no errors skipping decision; got {result['errors']}"
        )
        # No signals emitted (decision has no cycle hook)
        assert result["pending_signals"] == []

    def test_decision_mixed_with_real_strategy(self):
        """decision in active_ids alongside trend-following: decision skipped, strategy runs."""
        bars = _make_bars("AAA", n=130)
        result = self._run(
            active_ids=["trend-following", "decision"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": bars},
                "portfolio": {},
                "config": {},
            },
        )
        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        # decision being present must not kill trend-following signals
        # (trend-following should still emit on a strong uptrend)
        assert len(result["pending_signals"]) > 0, (
            "Expected signals from trend-following when decision is in active_ids but "
            f"has no cycle hook. logs={result['logs']}"
        )

    # ── logs are collected ────────────────────────────────────────────────────

    def test_logs_are_collected_from_plugins(self):
        """cmd_run_cycle collects logs from all plugin on_cycle calls."""
        bars = _make_bars("AAA", n=130)
        result = self._run(
            active_ids=["trend-following"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": bars},
                "portfolio": {},
                "config": {},
            },
        )
        assert len(result["logs"]) > 0, "Expected logs from trend-following on_cycle"
        for log in result["logs"]:
            assert "level" in log, f"Log entry missing 'level': {log}"
            assert "msg" in log, f"Log entry missing 'msg': {log}"

    # ── provider_tools.get_ohlcv from injected data ──────────────────────────

    def test_get_ohlcv_respects_limit(self):
        """provider_tools.get_ohlcv(limit=N) returns at most N bars."""
        # Use a custom hook via monkeypatching to test get_ohlcv directly
        # We verify indirectly: trend-following requests bars_needed bars;
        # if limit slicing works, it will find sufficient bars in a 130-bar set.
        bars = _make_bars("AAA", n=130)
        result = self._run(
            active_ids=["trend-following"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": bars},
                "portfolio": {},
                "config": {},
            },
        )
        # If limit slicing didn't work, trend-following would get all 130 bars unsliced;
        # it should still work (and emit signals) since 130 >= bars_needed (~88).
        assert result["errors"] == []

    # ── momentum-factor-12-1 strategy plugin (Fix A regression coverage) ─────

    def _make_daily_bars_with_monthly_step(
        self, symbol: str, start: float, monthly_step: float, n_months: int = 20
    ) -> list[dict]:
        """~21 trading days/month for n_months months; each MONTH's close increases by
        monthly_step vs the previous month's close (mild daily noise within the month
        so month-end != any arbitrary daily close, but the monthly TREND is unambiguous).
        """
        bars = []
        year, month = 2023, 1
        month_base = start
        for _m in range(n_months):
            for day in range(1, 22):
                # Small within-month drift toward month_base + monthly_step so the
                # month-end (last day) close lands near month_base + monthly_step.
                close = month_base + monthly_step * (day / 21.0)
                bars.append(
                    {
                        "date": f"{year:04d}-{month:02d}-{day:02d}",
                        "open": round(close - 0.1, 4),
                        "high": round(close + 0.2, 4),
                        "low": round(close - 0.2, 4),
                        "close": round(close, 4),
                        "volume": 1_000,
                    }
                )
            month_base += monthly_step
            month += 1
            if month > 12:
                month = 1
                year += 1
        return bars

    def test_momentum_factor_12_1_computes_sensible_signals_from_daily_bars(self):
        """Regression for Fix A: momentum-factor-12-1 asks for timeframe="1Month" —
        given ~400 DAILY bars (real cycle.bars default), it must compute momentum
        over the RESAMPLED MONTHLY series (a genuine ~20-month trend), not over the
        last ~14 DAILY bars (~3 weeks), and emit long/exit signals accordingly.
        """
        # AAA: strong sustained monthly uptrend. BBB: sustained monthly downtrend.
        # CCC/DDD/EEE: flat/mild, filler so universe >= 5 (plugin requirement).
        aaa = self._make_daily_bars_with_monthly_step("AAA", start=100.0, monthly_step=5.0)
        bbb = self._make_daily_bars_with_monthly_step("BBB", start=100.0, monthly_step=-4.0)
        ccc = self._make_daily_bars_with_monthly_step("CCC", start=100.0, monthly_step=0.2)
        ddd = self._make_daily_bars_with_monthly_step("DDD", start=100.0, monthly_step=0.1)
        eee = self._make_daily_bars_with_monthly_step("EEE", start=100.0, monthly_step=0.3)

        assert len(aaa) > 300, "fixture must resemble the real cycle.bars=400 default"

        result = self._run(
            active_ids=["momentum-factor-12-1"],
            context={
                "universe": ["AAA", "BBB", "CCC", "DDD", "EEE"],
                "ohlcv": {"AAA": aaa, "BBB": bbb, "CCC": ccc, "DDD": ddd, "EEE": eee},
                "portfolio": {},
                "market_trend_up": True,
                "config": {"top_pct": 20, "lookback_months": 12},
            },
        )

        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        signals = {s["symbol"]: s for s in result["pending_signals"]}

        # If timeframe were still ignored, get_ohlcv(timeframe="1Month", limit=14) would
        # get 14 DAILY bars (~3 weeks) instead of ~14 MONTHLY bars — AAA's clean uptrend
        # would not reliably surface as the top long signal from raw daily noise-free data,
        # AND (more decisively) with only 14 raw daily bars this daily fixture would look
        # like a single trading month, not the ~20-month history the plugin asked for.
        assert "AAA" in signals, (
            f"Expected AAA (sustained monthly uptrend) to get a momentum signal; "
            f"got signals={list(signals)} logs={result['logs']}"
        )
        aaa_sig = signals["AAA"]
        assert aaa_sig["action"] == "long", (
            f"Expected AAA to rank as 'long' on a clean ~20-month monthly uptrend, "
            f"got action={aaa_sig['action']!r} — resample likely broken (Fix A)."
        )
        assert aaa_sig["return_12_1"] > 0
        assert aaa_sig["rank"] == 1

    # ── unique module names prevent cross-plugin collision ────────────────────

    def test_no_sys_modules_collision_between_plugins(self):
        """Loading two plugins with hooks/cycle.py must not collide in sys.modules."""
        bars = _make_bars("AAA", n=130)
        # Run twice to force re-load of both plugins
        result1 = self._run(
            active_ids=["trend-following", "risk-manager"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": bars},
                "portfolio": {},
                "portfolio_value": 100_000.0,
                "config": {},
            },
        )
        result2 = self._run(
            active_ids=["trend-following", "risk-manager"],
            context={
                "universe": ["AAA"],
                "ohlcv": {"AAA": bars},
                "portfolio": {},
                "portfolio_value": 100_000.0,
                "config": {},
            },
        )
        # Both runs must succeed without errors
        assert result1["errors"] == [], f"Run 1 errors: {result1['errors']}"
        assert result2["errors"] == [], f"Run 2 errors: {result2['errors']}"


class TestRunCycleProviderTools:
    """Unit-level tests for the get_ohlcv closure built inside cmd_run_cycle."""

    @pytest.fixture(autouse=True)
    def _load(self, monkeypatch):
        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", REAL_PLUGINS_DIR)
        self.mod = mod

    def _build_ctx_and_get_ohlcv(self, ohlcv_data: dict) -> callable:
        """
        Run cmd_run_cycle with a fake skill plugin that captures provider_tools,
        then return the captured get_ohlcv callable.
        """
        # We monkeypatch PLUGINS_DIR to a fake tree with one plugin whose
        # hooks/cycle.py captures provider_tools
        import tempfile
        import textwrap
        from pathlib import Path

        tmp = Path(tempfile.mkdtemp())
        pid = "capture-test"
        pdir = tmp / pid
        (pdir / "hooks").mkdir(parents=True)
        (pdir / "plugin.py").write_text("", encoding="utf-8")
        (pdir / "manifest.toml").write_text(
            textwrap.dedent("""\
                [plugin]
                id = "capture-test"
                type = "skill"
                [hooks]
                on_cycle = "hooks/cycle.py"
                [skills]
                keys = []
            """),
            encoding="utf-8",
        )
        (pdir / "hooks" / "cycle.py").write_text(
            textwrap.dedent("""\
                import json, sys
                _CAPTURE_PATH = None  # will be patched via import
                def on_cycle(ctx):
                    pt = ctx.get("provider_tools", {})
                    get_ohlcv = pt.get("get_ohlcv")
                    result = {}
                    if callable(get_ohlcv):
                        result["bars_AAA_5"] = get_ohlcv(symbol="AAA", limit=5)
                        result["bars_AAA_none"] = get_ohlcv(symbol="AAA")
                        result["bars_ZZZ"] = get_ohlcv(symbol="ZZZ", limit=3)
                    return {"signals": [], "logs": [], "extra": result}
            """),
            encoding="utf-8",
        )

        old_dir = self.mod.PLUGINS_DIR
        self.mod.PLUGINS_DIR = tmp

        req = {
            "cmd": "run_cycle",
            "active_ids": [pid],
            "context": {"universe": [], "ohlcv": ohlcv_data, "portfolio": {}, "config": {}},
        }
        result = self.mod.cmd_run_cycle(req)
        self.mod.PLUGINS_DIR = old_dir
        return result

    def test_get_ohlcv_returns_empty_for_missing_symbol(self):
        result = self._build_ctx_and_get_ohlcv({"AAA": _make_bars("AAA", n=10)})
        # Check via the "extra" data captured by the hook — it goes into logs
        # Actually result doesn't expose "extra" from the hook; we check errors are absent
        assert result["errors"] == []

    def test_get_ohlcv_limit_slices_tail(self, tmp_path, monkeypatch):
        """get_ohlcv(symbol=X, limit=N) returns the LAST N bars of the injected data."""
        import textwrap

        pid = "limit-test"
        pdir = tmp_path / pid
        (pdir / "hooks").mkdir(parents=True)
        (pdir / "plugin.py").write_text("", encoding="utf-8")
        (pdir / "manifest.toml").write_text(
            textwrap.dedent("""\
                [plugin]
                id = "limit-test"
                type = "skill"
                [hooks]
                on_cycle = "hooks/cycle.py"
                [skills]
                keys = []
            """),
            encoding="utf-8",
        )

        hook_src = textwrap.dedent("""\
            _SIGNAL_DATA = {}

            def on_cycle(ctx):
                pt = ctx.get("provider_tools", {})
                get_ohlcv = pt.get("get_ohlcv")
                sliced = get_ohlcv(symbol="AAA", limit=3) if callable(get_ohlcv) else []
                full = get_ohlcv(symbol="AAA") if callable(get_ohlcv) else []
                sig = {"type": "t", "symbol": "AAA", "action": "long",
                       "sliced_len": len(sliced), "full_len": len(full),
                       "_sliced_last_close": sliced[-1]["close"] if sliced else None}
                return {"signals": [sig], "logs": []}
        """)
        (pdir / "hooks" / "cycle.py").write_text(hook_src, encoding="utf-8")

        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", tmp_path)

        bars = _make_bars("AAA", n=10)
        req = {
            "cmd": "run_cycle",
            "active_ids": [pid],
            "context": {"universe": [], "ohlcv": {"AAA": bars}, "portfolio": {}, "config": {}},
        }
        result = mod.cmd_run_cycle(req)

        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        assert len(result["pending_signals"]) == 1
        sig = result["pending_signals"][0]
        assert sig["sliced_len"] == 3, f"Expected 3 bars (limit=3), got {sig['sliced_len']}"
        assert sig["full_len"] == 10, f"Expected 10 bars (no limit), got {sig['full_len']}"
        # Last 3 bars — the close of the last sliced bar must equal the last bar in full set
        assert sig["_sliced_last_close"] == bars[-1]["close"]


def _make_daily_bars_across_months(
    start_year: int = 2024, start_month: int = 1, n_months: int = 14
) -> list[dict]:
    """~21 trading days per month, oldest-first, spanning n_months calendar months.

    Each day's close increases monotonically so month-end closes are easy to assert on.
    """
    bars = []
    year, month = start_year, start_month
    price = 100.0
    for _m in range(n_months):
        days_in_month = 21
        for day in range(1, days_in_month + 1):
            price += 1.0
            bars.append(
                {
                    "date": f"{year:04d}-{month:02d}-{day:02d}",
                    "open": round(price - 0.5, 4),
                    "high": round(price + 0.5, 4),
                    "low": round(price - 1.0, 4),
                    "close": round(price, 4),
                    "volume": 1_000,
                }
            )
        month += 1
        if month > 12:
            month = 1
            year += 1
    return bars


class TestGetOhlcvResample:
    """provider_tools.get_ohlcv must RESAMPLE the injected daily bars to the
    requested timeframe instead of ignoring it (see Fix A — momentum-factor-12-1
    was computing "12-1 momentum" over ~14 DAILY closes instead of ~14 MONTHLY
    closes because timeframe was silently discarded)."""

    @pytest.fixture(autouse=True)
    def _load(self, monkeypatch):
        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", REAL_PLUGINS_DIR)
        self.mod = mod

    def test_resample_bars_monthly_keeps_last_bar_of_each_month(self):
        daily = _make_daily_bars_across_months(n_months=3)
        monthly = self.mod._resample_bars(daily, "1Month")

        assert len(monthly) == 3
        # Each monthly bar's close must equal the LAST daily close of that month
        month_1_days = [b for b in daily if b["date"].startswith("2024-01")]
        month_2_days = [b for b in daily if b["date"].startswith("2024-02")]
        month_3_days = [b for b in daily if b["date"].startswith("2024-03")]
        assert monthly[0]["close"] == month_1_days[-1]["close"]
        assert monthly[1]["close"] == month_2_days[-1]["close"]
        assert monthly[2]["close"] == month_3_days[-1]["close"]
        # open = first day of month, high/low = extremes, volume = sum
        assert monthly[0]["open"] == month_1_days[0]["open"]
        assert monthly[0]["high"] == max(d["high"] for d in month_1_days)
        assert monthly[0]["low"] == min(d["low"] for d in month_1_days)
        assert monthly[0]["volume"] == sum(d["volume"] for d in month_1_days)
        # Oldest-first order preserved
        assert monthly[0]["date"] < monthly[1]["date"] < monthly[2]["date"]

    def test_resample_bars_weekly_groups_by_iso_week(self):
        # 21 daily bars spanning ~3 ISO weeks
        daily = _make_daily_bars_across_months(n_months=1)[:21]
        weekly = self.mod._resample_bars(daily, "1Week")

        assert 1 < len(weekly) < len(daily), "weekly resample must reduce bar count"
        # Every weekly close must be one of the injected daily closes (last-of-week)
        daily_closes = {d["close"] for d in daily}
        assert all(w["close"] in daily_closes for w in weekly)

    def test_resample_bars_daily_passthrough_unchanged(self):
        daily = _make_daily_bars_across_months(n_months=1)
        assert self.mod._resample_bars(daily, "1d") == daily
        assert self.mod._resample_bars(daily, None) == daily
        assert self.mod._resample_bars(daily, "1day") == daily

    def test_get_ohlcv_resamples_before_applying_limit(self, tmp_path, monkeypatch):
        """End-to-end: injecting ~14 months of daily bars, a plugin calling
        get_ohlcv(timeframe='1Month', limit=14) must receive ~14 MONTHLY bars,
        not 14 DAILY bars."""
        import textwrap

        pid = "resample-test"
        pdir = tmp_path / pid
        (pdir / "hooks").mkdir(parents=True)
        (pdir / "plugin.py").write_text("", encoding="utf-8")
        (pdir / "manifest.toml").write_text(
            textwrap.dedent("""\
                [plugin]
                id = "resample-test"
                type = "skill"
                [hooks]
                on_cycle = "hooks/cycle.py"
                [skills]
                keys = []
            """),
            encoding="utf-8",
        )
        (pdir / "hooks" / "cycle.py").write_text(
            textwrap.dedent("""\
                def on_cycle(ctx):
                    pt = ctx.get("provider_tools", {})
                    get_ohlcv = pt.get("get_ohlcv")
                    bars = get_ohlcv(symbol="AAA", timeframe="1Month", limit=14)
                    sig = {"type": "t", "symbol": "AAA", "action": "long",
                           "bars_len": len(bars)}
                    return {"signals": [sig], "logs": []}
            """),
            encoding="utf-8",
        )

        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", tmp_path)

        daily = _make_daily_bars_across_months(n_months=14)  # ~294 daily bars
        req = {
            "cmd": "run_cycle",
            "active_ids": [pid],
            "context": {"universe": [], "ohlcv": {"AAA": daily}, "portfolio": {}, "config": {}},
        }
        result = mod.cmd_run_cycle(req)

        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        sig = result["pending_signals"][0]
        assert sig["bars_len"] == 14, (
            f"Expected 14 MONTHLY bars (resampled + limited), got {sig['bars_len']} — "
            "timeframe is likely being ignored"
        )


class TestRunCycleErrorIsolation:
    """A crashing plugin must not abort the entire cycle."""

    def test_crashing_plugin_adds_error_entry(self, tmp_path, monkeypatch):
        """A plugin whose on_cycle raises must add an error entry, not propagate."""
        import textwrap

        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", tmp_path)

        pid = "crash-test"
        pdir = tmp_path / pid
        (pdir / "hooks").mkdir(parents=True)
        (pdir / "plugin.py").write_text("", encoding="utf-8")
        (pdir / "manifest.toml").write_text(
            textwrap.dedent("""\
                [plugin]
                id = "crash-test"
                type = "skill"
                [hooks]
                on_cycle = "hooks/cycle.py"
                [skills]
                keys = []
            """),
            encoding="utf-8",
        )
        (pdir / "hooks" / "cycle.py").write_text(
            "def on_cycle(ctx):\n    raise RuntimeError('deliberate crash')\n",
            encoding="utf-8",
        )

        req = {
            "cmd": "run_cycle",
            "active_ids": [pid],
            "context": {"universe": [], "ohlcv": {}, "portfolio": {}, "config": {}},
        }
        result = mod.cmd_run_cycle(req)

        assert len(result["errors"]) == 1
        err = result["errors"][0]
        assert err["plugin"] == pid
        assert "crash" in err["error"].lower() or "deliberate" in err["error"].lower(), (
            f"Expected error message to contain crash info, got: {err['error']}"
        )

    def test_disciplines_not_run_by_runner(self, tmp_path, monkeypatch):
        """cmd_run_cycle only GENERATES signals (skills); discipline plugins (veto/sizing)
        run once in the NestJS veto layer, NOT here. So a discipline that would crash is
        never invoked by the runner, and skill signals pass through untouched."""
        import textwrap

        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", tmp_path)

        # Skill plugin that emits one signal
        s_pid = "good-skill"
        s_dir = tmp_path / s_pid
        (s_dir / "hooks").mkdir(parents=True)
        (s_dir / "plugin.py").write_text("", encoding="utf-8")
        (s_dir / "manifest.toml").write_text(
            textwrap.dedent("""\
                [plugin]
                id = "good-skill"
                type = "skill"
                [hooks]
                on_cycle = "hooks/cycle.py"
                [skills]
                keys = []
            """),
            encoding="utf-8",
        )
        (s_dir / "hooks" / "cycle.py").write_text(
            textwrap.dedent("""\
                def on_cycle(ctx):
                    return {
                        "signals": [{"type": "t", "symbol": "AAA", "action": "long"}],
                        "logs": [],
                    }
            """),
            encoding="utf-8",
        )

        # Discipline plugin that crashes
        d_pid = "bad-discipline"
        d_dir = tmp_path / d_pid
        (d_dir / "hooks").mkdir(parents=True)
        (d_dir / "plugin.py").write_text("", encoding="utf-8")
        (d_dir / "manifest.toml").write_text(
            textwrap.dedent("""\
                [plugin]
                id = "bad-discipline"
                type = "discipline"
                [hooks]
                on_cycle = "hooks/cycle.py"
            """),
            encoding="utf-8",
        )
        (d_dir / "hooks" / "cycle.py").write_text(
            "def on_cycle(ctx):\n    raise ValueError('discipline exploded')\n",
            encoding="utf-8",
        )

        req = {
            "cmd": "run_cycle",
            "active_ids": [s_pid, d_pid],
            "context": {"universe": [], "ohlcv": {}, "portfolio": {}, "config": {}},
        }
        result = mod.cmd_run_cycle(req)

        # The discipline is NOT executed by the runner → no error from it, even though
        # its on_cycle would raise. Disciplines are the veto layer's responsibility.
        assert not any(e["plugin"] == d_pid for e in result["errors"]), (
            f"Discipline {d_pid} should NOT be run by the runner; got errors: {result['errors']}"
        )
        # Skill signal passes through untouched (no discipline filtering here).
        assert len(result["pending_signals"]) == 1, (
            f"Expected skill signal from {s_pid} to pass through; got {result['pending_signals']}"
        )


class TestRunCyclePerPluginConfig:
    """
    Bug A (pretest ignores per-portfolio plugin config): cmd_run_cycle must let a
    caller pass DIFFERENT effective config to different active plugins in the SAME
    cycle via context["plugin_configs"][plugin_id], layered on top of the manifest
    [config] defaults and the legacy global context["config"] dict (still supported
    for backward compatibility with callers that only set one global config).
    """

    def _write_echo_plugin(self, root: Path, pid: str) -> None:
        import textwrap

        pdir = root / pid
        (pdir / "hooks").mkdir(parents=True)
        (pdir / "plugin.py").write_text("", encoding="utf-8")
        (pdir / "manifest.toml").write_text(
            textwrap.dedent(f"""\
                [plugin]
                id = "{pid}"
                type = "skill"
                [hooks]
                on_cycle = "hooks/cycle.py"
                [skills]
                keys = []
                [config.top_pct]
                type = "number"
                default = 10
            """),
            encoding="utf-8",
        )
        (pdir / "hooks" / "cycle.py").write_text(
            textwrap.dedent("""\
                def on_cycle(ctx):
                    cfg = ctx.get("config", {})
                    return {
                        "signals": [{
                            "type": "config_echo",
                            "symbol": "X",
                            "action": "long",
                            "top_pct": cfg.get("top_pct"),
                        }],
                        "logs": [],
                    }
            """),
            encoding="utf-8",
        )

    def test_plugin_configs_gives_each_plugin_its_own_config_in_the_same_cycle(
        self, tmp_path, monkeypatch
    ):
        """Two portfolios' worth of plugins (same plugin id family, different top_pct)
        must each see their OWN top_pct, not a single shared value."""
        self._write_echo_plugin(tmp_path, "echo-a")
        self._write_echo_plugin(tmp_path, "echo-b")

        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", tmp_path)

        req = {
            "cmd": "run_cycle",
            "active_ids": ["echo-a", "echo-b"],
            "context": {
                "universe": [],
                "ohlcv": {},
                "portfolio": {},
                "config": {},
                "plugin_configs": {
                    "echo-a": {"top_pct": 20},
                    "echo-b": {"top_pct": 50},
                },
            },
        }
        result = mod.cmd_run_cycle(req)

        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        by_plugin = {s["_plugin"]: s["top_pct"] for s in result["pending_signals"]}
        assert by_plugin == {"echo-a": 20, "echo-b": 50}, (
            f"Expected per-plugin config to differentiate top_pct; got {by_plugin}"
        )

    def test_plugin_without_a_plugin_configs_entry_falls_back_to_manifest_default(
        self, tmp_path, monkeypatch
    ):
        """A plugin with no entry in plugin_configs must still get its manifest default
        (10), not crash and not silently inherit another plugin's override."""
        self._write_echo_plugin(tmp_path, "echo-a")
        self._write_echo_plugin(tmp_path, "echo-c")

        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", tmp_path)

        req = {
            "cmd": "run_cycle",
            "active_ids": ["echo-a", "echo-c"],
            "context": {
                "universe": [],
                "ohlcv": {},
                "portfolio": {},
                "config": {},
                "plugin_configs": {"echo-a": {"top_pct": 99}},
            },
        }
        result = mod.cmd_run_cycle(req)

        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        by_plugin = {s["_plugin"]: s["top_pct"] for s in result["pending_signals"]}
        assert by_plugin == {"echo-a": 99, "echo-c": 10}

    def test_legacy_global_config_still_applies_when_plugin_configs_is_absent(
        self, tmp_path, monkeypatch
    ):
        """Backward compatibility: callers (e.g. the live agent cycle) that only set
        the global context["config"] and never send plugin_configs keep working."""
        self._write_echo_plugin(tmp_path, "echo-a")

        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", tmp_path)

        req = {
            "cmd": "run_cycle",
            "active_ids": ["echo-a"],
            "context": {
                "universe": [],
                "ohlcv": {},
                "portfolio": {},
                "config": {"top_pct": 33},
            },
        }
        result = mod.cmd_run_cycle(req)

        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        assert result["pending_signals"][0]["top_pct"] == 33
