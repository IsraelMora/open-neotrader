"""
Tests for market-context plugin (merged market-breadth + volatility-regime).

Strict TDD: tests written before implementation.

Output contract:
  ctx keys:  market_breadth_score, market_breadth_regime, market_breadth_divergence,
             market_breadth_details, emit_alerts (may be set)
  signal:    type="volatility_regime" in returned signals list
"""

from __future__ import annotations

import math
import sys
import os
import pytest


# Load THIS plugin's cycle.py under a unique module name (every plugin's hook is
# named cycle.py → a bare `from cycle import` collides via sys.modules across the
# full pytest session, the same way runner.py avoids it with unique spec names).
def _load_on_cycle(_plugin):
    import importlib.util as _ilu, os as _os, sys as _sys
    _root = _os.path.join(_os.path.dirname(__file__), "..", "..", "..", "..", "plugins", _plugin)
    _sc = _os.path.join(_root, "scripts")
    if _sc not in _sys.path:
        _sys.path.insert(0, _sc)
    _spec = _ilu.spec_from_file_location("_cycle_" + _plugin.replace("-", "_"),
                                         _os.path.join(_root, "hooks", "cycle.py"))
    _m = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_m)
    return _m.on_cycle
on_cycle = _load_on_cycle("market-context")

# Make the plugin scripts importable
PLUGIN_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "..", "plugins", "market-context"
)
sys.path.insert(0, os.path.join(PLUGIN_ROOT, "scripts"))
sys.path.insert(0, os.path.join(PLUGIN_ROOT, "hooks"))


# ── helpers ──────────────────────────────────────────────────────────────────

def _spy_closes(n: int = 300, trend: str = "up") -> list[float]:
    """Generate synthetic SPY closes."""
    import math
    closes = []
    for i in range(n):
        if trend == "up":
            closes.append(400 + i * 0.1)
        elif trend == "down":
            closes.append(400 - i * 0.1)
        else:
            closes.append(400 + math.sin(i * 0.1) * 10)
    return closes


def _make_ctx(
    *,
    advances: list[int] | None = None,
    declines: list[int] | None = None,
    provider_gives_data: bool = True,
    vix_value: float = 18.0,
    index_closes: list[float] | None = None,
    config: dict | None = None,
) -> dict:
    """Build a synthetic ctx dict with provider_tools stub."""
    closes = index_closes or _spy_closes(300)
    vix_bars = [{"close": vix_value}]

    def fake_get_ohlcv(symbol: str, timeframe: str = "1d", limit: int = 300):
        if not provider_gives_data:
            return None
        if "VIX" in symbol.upper() or symbol.startswith("^"):
            return vix_bars
        return [{"close": c} for c in closes[-limit:]]

    ctx: dict = {
        "config": config or {},
        "provider_tools": {"get_ohlcv": fake_get_ohlcv} if provider_gives_data else {"get_ohlcv": None},
        "emit_alerts": [],
    }
    if advances is not None:
        ctx["market_advances"] = advances
    if declines is not None:
        ctx["market_declines"] = declines
    return ctx


# ── (a) on_cycle sets market_breadth_* ctx keys ──────────────────────────────

class TestBreadthCtxKeys:
    def test_score_key_set(self):
        """on_cycle must set market_breadth_score on ctx."""
        pass  # on_cycle: module-level
        ctx = _make_ctx(advances=[300] * 5, declines=[100] * 5)
        on_cycle(ctx)
        assert "market_breadth_score" in ctx
        assert isinstance(ctx["market_breadth_score"], (int, float))

    def test_regime_key_set(self):
        """on_cycle must set market_breadth_regime on ctx."""
        pass  # on_cycle: module-level
        ctx = _make_ctx(advances=[300] * 5, declines=[100] * 5)
        on_cycle(ctx)
        assert "market_breadth_regime" in ctx
        assert ctx["market_breadth_regime"] in {
            "bullish", "neutral", "bearish", "extreme_bullish", "extreme_bearish"
        }

    def test_divergence_key_set(self):
        """on_cycle must set market_breadth_divergence on ctx (may be None)."""
        pass  # on_cycle: module-level
        ctx = _make_ctx(advances=[300] * 5, declines=[100] * 5)
        on_cycle(ctx)
        assert "market_breadth_divergence" in ctx

    def test_details_key_set(self):
        """on_cycle must set market_breadth_details dict on ctx."""
        pass  # on_cycle: module-level
        ctx = _make_ctx(advances=[300] * 5, declines=[100] * 5)
        on_cycle(ctx)
        assert "market_breadth_details" in ctx
        assert isinstance(ctx["market_breadth_details"], dict)

    def test_score_range(self):
        """market_breadth_score must be in [0, 100]."""
        pass  # on_cycle: module-level
        ctx = _make_ctx(advances=[300] * 5, declines=[100] * 5)
        on_cycle(ctx)
        assert 0 <= ctx["market_breadth_score"] <= 100


# ── (b) on_cycle emits volatility_regime signal ───────────────────────────────

class TestVolatilityRegimeSignal:
    def test_signal_emitted(self):
        """on_cycle must return a dict with 'signals' list containing a volatility_regime signal."""
        pass  # on_cycle: module-level
        ctx = _make_ctx()
        result = on_cycle(ctx)
        assert "signals" in result
        types = [s["type"] for s in result["signals"]]
        assert "volatility_regime" in types

    def test_signal_has_regime_field(self):
        """The volatility_regime signal must have a 'regime' field."""
        pass  # on_cycle: module-level
        ctx = _make_ctx()
        result = on_cycle(ctx)
        vol_sig = next(s for s in result["signals"] if s["type"] == "volatility_regime")
        assert "regime" in vol_sig
        assert vol_sig["regime"] in {"low", "normal", "high", "crisis", "unknown"}

    def test_signal_has_expected_fields(self):
        """The volatility_regime signal must include the canonical fields."""
        pass  # on_cycle: module-level
        ctx = _make_ctx()
        result = on_cycle(ctx)
        vol_sig = next(s for s in result["signals"] if s["type"] == "volatility_regime")
        for field in ("vix", "rv_21d", "rv_percentile", "size_multiplier"):
            assert field in vol_sig, f"Missing field: {field}"

    def test_result_has_logs(self):
        """on_cycle must return 'logs' list."""
        pass  # on_cycle: module-level
        ctx = _make_ctx()
        result = on_cycle(ctx)
        assert "logs" in result
        assert isinstance(result["logs"], list)


# ── (c) breadth regime threshold classification ───────────────────────────────

class TestBreadthRegimeClassification:
    def test_bullish_high_score(self):
        """Many advances → bullish or extreme_bullish."""
        from market_breadth import compute_breadth
        result = compute_breadth(advances=[800] * 5, declines=[200] * 5)
        assert result.regime in {"bullish", "extreme_bullish"}
        assert result.score > 50

    def test_bearish_low_score(self):
        """Many declines → bearish or extreme_bearish."""
        from market_breadth import compute_breadth
        result = compute_breadth(advances=[200] * 5, declines=[800] * 5)
        assert result.regime in {"bearish", "extreme_bearish"}
        assert result.score < 50

    def test_neutral_balanced(self):
        """Balanced advances/declines → neutral."""
        from market_breadth import compute_breadth
        result = compute_breadth(advances=[500] * 5, declines=[500] * 5)
        assert result.regime == "neutral"
        assert 20 <= result.score <= 80

    def test_extreme_bullish_threshold(self):
        """Score >= 80 → extreme_bullish."""
        from market_breadth import compute_breadth
        # 950/50 ratio → very high AD pct → score near 95
        result = compute_breadth(advances=[950] * 5, declines=[50] * 5)
        assert result.regime == "extreme_bullish"

    def test_custom_thresholds(self):
        """Custom config thresholds are respected."""
        from market_breadth import compute_breadth
        # With bullish_threshold=60, a score of 65 should be bullish
        cfg = {"breadth_bullish_threshold": 60, "breadth_bearish_threshold": 40}
        result = compute_breadth(advances=[700] * 5, declines=[300] * 5, config=cfg)
        # 700/1000 = 70% AD → score ~70 → bullish with threshold 60
        assert result.regime in {"bullish", "extreme_bullish"}


# ── (d) volatility regime classification ─────────────────────────────────────

class TestVolatilityRegimeClassification:
    def test_low_regime_low_vix(self):
        """VIX < 15 → low regime."""
        from regime import detect_regime
        closes = _spy_closes(300, "up")
        result = detect_regime(index_closes=closes, vix_value=12.0)
        assert result.regime == "low"
        assert result.size_multiplier == 1.0

    def test_normal_regime(self):
        """VIX 15-25 → normal regime."""
        from regime import detect_regime
        closes = _spy_closes(300, "up")
        result = detect_regime(index_closes=closes, vix_value=20.0)
        assert result.regime == "normal"

    def test_high_regime(self):
        """VIX > 25 and < 40 → high regime."""
        from regime import detect_regime
        closes = _spy_closes(300, "up")
        result = detect_regime(index_closes=closes, vix_value=30.0)
        assert result.regime == "high"
        assert result.size_multiplier == 0.50

    def test_crisis_regime(self):
        """VIX > 40 → crisis regime."""
        from regime import detect_regime
        closes = _spy_closes(300, "up")
        result = detect_regime(index_closes=closes, vix_value=55.0)
        assert result.regime == "crisis"
        assert result.size_multiplier == 0.10

    def test_no_vix_uses_rv_percentile(self):
        """Without VIX, regime is determined by RV percentile."""
        from regime import detect_regime
        closes = _spy_closes(300, "up")
        result = detect_regime(index_closes=closes, vix_value=None)
        assert result.regime in {"low", "normal", "high", "crisis", "unknown"}
        assert result.vix is None


# ── (e) graceful when data is missing ────────────────────────────────────────

class TestGracefulDegradation:
    def test_no_advance_decline_data(self):
        """Missing advances/declines → ctx still gets breadth keys (defaults)."""
        pass  # on_cycle: module-level
        ctx = _make_ctx()  # no advances/declines provided
        on_cycle(ctx)
        assert "market_breadth_score" in ctx
        assert "market_breadth_regime" in ctx
        assert ctx["market_breadth_regime"] == "neutral"

    def test_no_provider(self):
        """No active provider → no volatility_regime signal, logs warning."""
        pass  # on_cycle: module-level
        ctx = _make_ctx(provider_gives_data=False)
        ctx["market_advances"] = [300] * 5
        ctx["market_declines"] = [100] * 5
        result = on_cycle(ctx)
        # breadth keys should still be set
        assert "market_breadth_score" in ctx
        # volatility signal absent (no provider)
        types = [s["type"] for s in result.get("signals", [])]
        assert "volatility_regime" not in types
        # at least one warning in logs
        assert any(log.get("level") == "warning" for log in result.get("logs", []))

    def test_no_provider_tools_key(self):
        """ctx without provider_tools key → breadth still works, vol degrades gracefully."""
        pass  # on_cycle: module-level
        ctx = {
            "config": {},
            "market_advances": [300] * 5,
            "market_declines": [100] * 5,
            "emit_alerts": [],
        }
        result = on_cycle(ctx)
        assert "market_breadth_score" in ctx
        assert isinstance(result, dict)
        assert "signals" in result

    def test_insufficient_index_closes(self):
        """Fewer than 22 index closes → regime returns 'unknown'."""
        from regime import detect_regime
        result = detect_regime(index_closes=[400.0] * 10, vix_value=18.0)
        assert result.regime == "unknown"

    def test_empty_advances_list(self):
        """Empty advances list → neutral breadth."""
        from market_breadth import compute_breadth
        result = compute_breadth(advances=[], declines=[])
        assert result.regime == "neutral"
        assert result.score == 50
