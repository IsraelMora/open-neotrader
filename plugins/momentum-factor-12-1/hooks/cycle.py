"""
on_cycle hook — Momentum Factor 12-1.

Recibe el contexto del ciclo, obtiene precios mensuales de cada símbolo
del universo activo, calcula rankings de momentum 12-1 y emite señales.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from momentum import apply_trend_filter, compute_momentum_ranks  # noqa: E402


def _normalize_symbols(raw_symbols) -> list[str]:
    """Comma-separated string OR list of strings -> trimmed/upper/deduped list,
    preserving first-seen order. Mirrors plugins/broad-index-hold's parsing
    convention for its own `symbols` config key."""
    if isinstance(raw_symbols, str):
        candidates = [s.strip().upper() for s in raw_symbols.split(",") if s.strip()]
    elif isinstance(raw_symbols, list):
        candidates = [str(s).strip().upper() for s in raw_symbols if str(s).strip()]
    else:
        candidates = []

    seen: set[str] = set()
    normalized: list[str] = []
    for symbol in candidates:
        if symbol not in seen:
            seen.add(symbol)
            normalized.append(symbol)
    return normalized


def on_cycle(ctx: dict) -> dict:
    """
    Args:
        ctx: CycleContext del SDK de NeuroTrader
             ctx["universe"]  → lista de símbolos activos
             ctx["provider"]  → funciones del proveedor activo (dict de tools)
             ctx["config"]    → config del plugin (top_pct, lookback_months)
             ctx["portfolio"] → posiciones actuales { symbol: cantidad }

    Returns:
        { signals: [...], logs: [...] }
    """
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    portfolio: dict = ctx.get("portfolio", {})

    # Override de universo por portfolio — OPT-IN. Cuando `symbols` está
    # presente y no queda vacío tras normalizar, REEMPLAZA ctx["universe"]
    # para este ciclo. Ausente/vacío -> comportamiento original (usa
    # ctx["universe"] sin modificar).
    symbols_override = _normalize_symbols(config.get("symbols"))
    if symbols_override:
        universe = symbols_override

    top_pct = config.get("top_pct", 20) / 100.0
    lookback_months = config.get("lookback_months", 12)
    market_trend_up: bool = ctx.get("market_trend_up", True)
    # Short-selling es OPT-IN — default False, comportamiento long/exit-only
    # idéntico al original cuando no se activa explícitamente por config.
    enable_short: bool = bool(config.get("enable_short", False))
    short_bottom_pct = config.get("short_bottom_pct", 10) / 100.0
    # Filtro de régimen por amplitud (breadth) — OPT-IN, estilo Antonacci dual
    # momentum. Valor en PORCENTAJE 0-100 (igual que top_pct), 0 = desactivado.
    regime_min_breadth = config.get("regime_min_breadth", 0) or 0

    signals = []
    logs = []

    if len(universe) < 5:
        logs.append(
            {
                "level": "warning",
                "msg": (
                    f"Universo muy pequeño ({len(universe)} símbolos). "
                    "Momentum necesita ≥5 activos."
                ),
            }
        )
        return {"signals": signals, "logs": logs}

    # Recopilar precios mensuales por símbolo
    # En producción el provider inyecta get_ohlcv; aquí preparamos la llamada
    universe_data: dict[str, list[float]] = {}
    provider_tools = ctx.get("provider_tools", {})
    get_ohlcv = provider_tools.get("get_ohlcv")

    for symbol in universe:
        if callable(get_ohlcv):
            try:
                bars = get_ohlcv(symbol=symbol, timeframe="1Month", limit=lookback_months + 2)
                if bars and len(bars) >= lookback_months + 2:
                    closes = [b["close"] for b in bars]
                    universe_data[symbol] = closes
                else:
                    logs.append(
                        {
                            "level": "warning",
                            "msg": f"{symbol}: datos insuficientes ({len(bars or [])} barras)",
                        }
                    )
            except Exception as exc:
                logs.append({"level": "error", "msg": f"{symbol}: error obteniendo OHLCV — {exc}"})
        else:
            # Modo simulación/test: sin provider real
            logs.append(
                {
                    "level": "debug",
                    "msg": f"{symbol}: provider no disponible, usando precio simulado",
                }
            )

    if not universe_data:
        logs.append(
            {
                "level": "warning",
                "msg": (
                    "No se obtuvieron precios. "
                    "Verifica que hay un provider activo con get_ohlcv."
                ),
            }
        )
        return {"signals": signals, "logs": logs}

    current_positions = set(portfolio.keys())
    ranks = compute_momentum_ranks(
        universe_data,
        top_pct,
        lookback_months,
        current_positions=current_positions,
        enable_short=enable_short,
        short_bottom_pct=short_bottom_pct,
    )

    # Filtro de régimen por amplitud (breadth) — Antonacci dual momentum. Se
    # mide ANTES del filtro de tendencia (que solo cancela "long", no altera
    # return_12_1) sobre los símbolos con momentum efectivamente calculado
    # (`ranks` ya excluye los que no tuvieron datos suficientes).
    if regime_min_breadth and ranks:
        positive_count = sum(1 for r in ranks if r.return_12_1 > 0)
        breadth = positive_count / len(ranks)
        if breadth * 100 < regime_min_breadth:
            # RISK-OFF: reemplaza por completo la lógica normal de señales —
            # solo exits de posiciones largas actualmente en cartera (cantidad
            # positiva; una cantidad negativa representa un short abierto y no
            # se toca aquí para no generar señales duplicadas/conflictivas).
            for symbol, quantity in portfolio.items():
                if quantity > 0:
                    signals.append(
                        {
                            "type": "momentum_signal",
                            "symbol": symbol,
                            "action": "exit",
                            "rank": None,
                            "return_12_1": None,
                            "percentile": None,
                            "volatility_12m": None,
                            "vol_adjusted_score": None,
                            "confidence": None,
                        }
                    )
            logs.append(
                {
                    "level": "warning",
                    "msg": (
                        "Filtro de régimen activado: breadth "
                        f"{breadth * 100:.1f}% < mínimo {regime_min_breadth}% — "
                        "modo defensivo, sin nuevas entradas long/short, "
                        "saliendo de posiciones largas existentes."
                    ),
                }
            )
            return {"signals": signals, "logs": logs}

    ranks = apply_trend_filter(ranks, market_trend_up)

    for r in ranks:
        if r.signal in ("long", "exit", "short"):
            signals.append(
                {
                    "type": "momentum_signal",
                    "symbol": r.symbol,
                    "action": r.signal,
                    "rank": r.rank,
                    "return_12_1": r.return_12_1,
                    "percentile": r.percentile,
                    "volatility_12m": r.volatility_12m,
                    "vol_adjusted_score": r.vol_adjusted_score,
                    "confidence": r.percentile,
                }
            )

    long_count = sum(1 for s in signals if s["action"] == "long")
    exit_count = sum(1 for s in signals if s["action"] == "exit")
    short_count = sum(1 for s in signals if s["action"] == "short")
    logs.append(
        {
            "level": "info",
            "msg": (
                f"Momentum 12-1 | universo={len(universe_data)} | "
                f"long={long_count} | exit={exit_count} | short={short_count} | "
                f"trend={'up' if market_trend_up else 'DOWN (filtro activo)'}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    result = on_cycle(ctx)
    print(json.dumps(result))
