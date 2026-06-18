"""
on_cycle — Market Breadth

Inyecta en el contexto del ciclo:
  - market_breadth_score: 0-100
  - market_breadth_regime: bullish | neutral | bearish | extreme_*
  - market_breadth_details: dict con todos los indicadores
  - market_breadth_divergence: None o "bearish_divergence" / "bullish_divergence"

El LLM y los discipline plugins pueden leer market_breadth_regime para ajustar
el tamaño de posición o suprimir señales en mercados débiles.

Claves esperadas en el contexto:
  market_advances:    list[int]  — activos que subieron hoy y en días anteriores
  market_declines:    list[int]  — activos que bajaron
  price_history:      dict[symbol, list[float]]  — para calcular % sobre MA200
  index_price_history: list[float]  — para detectar divergencias
  new_highs_history:  list[int]  (opcional)
  new_lows_history:   list[int]  (opcional)
"""

import json
import sys


def main():
    raw = sys.stdin.read().strip()
    ctx: dict = json.loads(raw) if raw else {}
    config: dict = ctx.get("__plugin_config__", {})

    advances: list = ctx.get("market_advances", [])
    declines: list = ctx.get("market_declines", [])
    price_history: dict = ctx.get("price_history", {})
    index_prices: list = ctx.get("index_price_history", [])
    new_highs: list = ctx.get("new_highs_history", [])
    new_lows: list = ctx.get("new_lows_history", [])

    # Sin datos de advance/decline, inferir desde price_history
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
        ctx["market_breadth_details"] = {"note": "sin datos A/D"}
        print(json.dumps(ctx))
        return

    from market_breadth import compute_breadth

    result = compute_breadth(
        advances=list(advances),
        declines=list(declines),
        price_history=price_history if price_history else None,
        index_prices=list(index_prices) if index_prices else None,
        new_highs=list(new_highs) if new_highs else None,
        new_lows=list(new_lows) if new_lows else None,
        config=config,
    )

    ctx["market_breadth_score"] = result.score
    ctx["market_breadth_regime"] = result.regime
    ctx["market_breadth_divergence"] = result.divergence
    ctx["market_breadth_details"] = {
        "ad_ratio": result.ad_ratio,
        "pct_above_ma": result.pct_above_ma,
        "mcclellan_osc": result.mcclellan_osc,
        "nh_nl_ratio": result.nh_nl_ratio,
        "breadth_thrust": result.breadth_thrust,
        "details": result.details,
    }

    # Si el mercado está muy deteriorado, emitir alerta
    emit_alerts = list(ctx.get("emit_alerts", []))
    if result.regime == "extreme_bearish":
        emit_alerts.append(
            {
                "type": "CORRELATION_SPIKE",
                "severity": "HIGH",
                "symbol": None,
                "message": (
                    f"Market Breadth EXTREMO BAJISTA: score={result.score}/100"
                    " — reducir exposición"
                ),
                "meta": {"score": result.score, "regime": result.regime},
            }
        )
    elif result.divergence == "bearish_divergence":
        emit_alerts.append(
            {
                "type": "CORRELATION_SPIKE",
                "severity": "MEDIUM",
                "symbol": None,
                "message": (
                    f"Divergencia bearish: índice sube pero breadth cae"
                    f" (score={result.score}/100)"
                ),
                "meta": {"score": result.score, "divergence": result.divergence},
            }
        )
    ctx["emit_alerts"] = emit_alerts

    print(json.dumps(ctx))


if __name__ == "__main__":
    main()
