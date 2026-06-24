"""
on_cycle hook — Market Context (merged market-breadth + volatility-regime).

Sets on ctx (market-breadth output contract, preserved):
  market_breadth_score        : float 0-100
  market_breadth_regime       : "bullish" | "neutral" | "bearish" | "extreme_bullish" | "extreme_bearish"
  market_breadth_divergence   : None | "bearish_divergence" | "bullish_divergence"
  market_breadth_details      : dict with ad_ratio, pct_above_ma, mcclellan_osc, nh_nl_ratio,
                                breadth_thrust, details
  emit_alerts                 : list — may receive CORRELATION_SPIKE entries

Emits in returned signals list (volatility-regime output contract, preserved):
  {"type": "volatility_regime", "regime": "low"|"normal"|"high"|"crisis", ...}

Returns: {"signals": [...], "logs": [...]}

No network calls — data comes exclusively from ctx and provider_tools.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from market_breadth import compute_breadth  # noqa: E402
from regime import detect_regime  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    signals: list[dict] = []
    logs: list[dict] = []

    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    # ── 1. Market Breadth ─────────────────────────────────────────────────────
    advances: list = ctx.get("market_advances", [])
    declines: list = ctx.get("market_declines", [])
    price_history: dict = ctx.get("price_history", {})
    index_prices: list = ctx.get("index_price_history", [])
    new_highs: list = ctx.get("new_highs_history", [])
    new_lows: list = ctx.get("new_lows_history", [])

    # Infer advances/declines from price_history when not provided
    if not advances and price_history:
        adv, dec = 0, 0
        for hist in price_history.values():
            if len(hist) >= 2:
                if hist[-1] > hist[-2]:
                    adv += 1
                elif hist[-1] < hist[-2]:
                    dec += 1
        advances = [adv]
        declines = [dec]

    if not advances:
        ctx["market_breadth_score"] = 50
        ctx["market_breadth_regime"] = "neutral"
        ctx["market_breadth_details"] = {"note": "no A/D data"}
        ctx["market_breadth_divergence"] = None
        logs.append({"level": "debug", "msg": "No advance/decline data; breadth defaulted to neutral"})
    else:
        breadth = compute_breadth(
            advances=list(advances),
            declines=list(declines),
            price_history=price_history if price_history else None,
            index_prices=list(index_prices) if index_prices else None,
            new_highs=list(new_highs) if new_highs else None,
            new_lows=list(new_lows) if new_lows else None,
            config=config,
        )

        ctx["market_breadth_score"] = breadth.score
        ctx["market_breadth_regime"] = breadth.regime
        ctx["market_breadth_divergence"] = breadth.divergence
        ctx["market_breadth_details"] = {
            "ad_ratio": breadth.ad_ratio,
            "pct_above_ma": breadth.pct_above_ma,
            "mcclellan_osc": breadth.mcclellan_osc,
            "nh_nl_ratio": breadth.nh_nl_ratio,
            "breadth_thrust": breadth.breadth_thrust,
            "details": breadth.details,
        }

        emit_alerts = list(ctx.get("emit_alerts", []))
        if breadth.regime == "extreme_bearish":
            emit_alerts.append(
                {
                    "type": "CORRELATION_SPIKE",
                    "severity": "HIGH",
                    "symbol": None,
                    "message": (
                        f"Market Breadth EXTREME BEARISH: score={breadth.score}/100"
                        " — reduce exposure"
                    ),
                    "meta": {"score": breadth.score, "regime": breadth.regime},
                }
            )
        elif breadth.divergence == "bearish_divergence":
            emit_alerts.append(
                {
                    "type": "CORRELATION_SPIKE",
                    "severity": "MEDIUM",
                    "symbol": None,
                    "message": (
                        f"Bearish divergence: index rising but breadth falling"
                        f" (score={breadth.score}/100)"
                    ),
                    "meta": {"score": breadth.score, "divergence": breadth.divergence},
                }
            )
        ctx["emit_alerts"] = emit_alerts

        logs.append(
            {
                "level": "info",
                "msg": (
                    f"Market breadth: score={breadth.score} regime={breadth.regime}"
                    f" divergence={breadth.divergence}"
                ),
            }
        )

    # ── 2. Volatility Regime ──────────────────────────────────────────────────
    index_symbol: str = config.get("index_symbol", "SPY")
    vix_symbol: str = config.get("vix_symbol", "^VIX")
    lookback_days: int = config.get("vol_lookback_days", 252)
    bars_needed: int = lookback_days + 30

    get_ohlcv = provider_tools.get("get_ohlcv") if isinstance(provider_tools, dict) else None

    index_closes: list[float] = []
    vix_value: float | None = None

    if callable(get_ohlcv):
        try:
            bars = get_ohlcv(symbol=index_symbol, timeframe="1d", limit=bars_needed)
            if bars:
                index_closes = [b["close"] for b in bars]
        except Exception as exc:
            logs.append({"level": "warning", "msg": f"Error fetching {index_symbol}: {exc}"})

        try:
            vix_bars = get_ohlcv(symbol=vix_symbol, timeframe="1d", limit=5)
            if vix_bars:
                vix_value = vix_bars[-1]["close"]
        except Exception:
            logs.append(
                {"level": "debug", "msg": "VIX not available; using realized volatility only"}
            )
    else:
        logs.append(
            {"level": "warning", "msg": "No active provider. Volatility regime cannot be determined."}
        )
        return {"signals": signals, "logs": logs}

    if not index_closes:
        logs.append({"level": "warning", "msg": f"No index data for {index_symbol}"})
        return {"signals": signals, "logs": logs}

    result = detect_regime(
        index_closes=index_closes,
        vix_value=vix_value,
        vix_low=config.get("vix_low_threshold", 15.0),
        vix_high=config.get("vix_high_threshold", 25.0),
        vix_crisis=config.get("vix_crisis_threshold", 40.0),
        lookback_days=lookback_days,
    )

    signals.append(
        {
            "type": "volatility_regime",
            "symbol": index_symbol,
            "action": "info",
            "regime": result.regime,
            "vix": result.vix,
            "rv_21d": result.rv_21d,
            "rv_percentile": result.rv_percentile,
            "size_multiplier": result.size_multiplier,
            "preferred_strategies": result.preferred_strategies,
            "avoid_strategies": result.avoid_strategies,
            "market_trend_up": result.market_trend_up,
            "description": result.description,
        }
    )

    level = (
        "critical"
        if result.regime == "crisis"
        else ("warning" if result.regime == "high" else "info")
    )
    logs.append({"level": level, "msg": result.description})

    return {"signals": signals, "logs": logs}
