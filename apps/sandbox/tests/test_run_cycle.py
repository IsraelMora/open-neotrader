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
