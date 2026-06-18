"""
Signal Aggregator — combina señales de múltiples skills en decisiones consenso.

Algoritmo de votación ponderada:
1. Agrupar señales por símbolo
2. Para cada símbolo: contar votos long vs short ponderados por confianza
3. Si el acuerdo supera el umbral → emitir señal consenso
4. Conflicto sin mayoría → ignorar o usar dominante (configurable)

Ventaja vs el LLM para agregación:
- Determinístico y auditable
- Sin costo de tokens para decisiones simples
- Más rápido (no requiere llamada LLM)
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass


@dataclass
class ConsensusSignal:
    symbol: str
    action: str  # "long" | "short" | "exit"
    confidence: float  # confianza del consenso (ponderada)
    vote_long: float  # peso total a favor de long
    vote_short: float  # peso total a favor de short
    vote_exit: float  # peso total a favor de exit
    agreement_pct: float  # % de acuerdo (winning_votes / total_votes)
    contributing_signals: int  # cuántas señales contribuyeron
    sources: list[str]  # plugin IDs que contribuyeron


def _normalize_action(action: str) -> str:
    """Normalizar acciones variantes al estándar long/short/exit/neutral."""
    action = action.lower()
    if action in ("long", "buy", "long_spread", "enter_long"):
        return "long"
    if action in ("short", "sell", "short_spread", "enter_short"):
        return "short"
    if action in ("exit", "close", "exit_long", "exit_short", "stop", "flatten"):
        return "exit"
    return "neutral"


def aggregate_signals(
    signals: list[dict],
    min_confidence: float = 0.6,
    min_agreement_pct: float = 60.0,
    weight_by_confidence: bool = True,
    require_min_signals: int = 2,
    max_signals_per_symbol: int = 10,
    conflict_resolution: str = "skip",
) -> list[ConsensusSignal]:
    """
    Agrega señales de múltiples fuentes en señales consenso por símbolo.

    Args:
        signals:               lista de señales de diferentes plugins
        min_confidence:        confianza mínima para participar en el voto
        min_agreement_pct:     % mínimo de acuerdo (0-100)
        weight_by_confidence:  ponderar voto por confianza vs voto igualitario
        require_min_signals:   señales mínimas para generar consenso
        max_signals_per_symbol: cap de señales por símbolo
        conflict_resolution:   "skip" | "dominant"

    Returns:
        lista de ConsensusSignal (una por símbolo con consenso)
    """
    # Agrupar por símbolo
    by_symbol: dict[str, list[dict]] = {}
    for sig in signals:
        symbol = sig.get("symbol", "")
        if not symbol:
            continue
        action = _normalize_action(sig.get("action", ""))
        if action == "neutral":
            continue
        conf = float(sig.get("confidence", 0.0))
        if conf < min_confidence:
            continue
        if symbol not in by_symbol:
            by_symbol[symbol] = []
        by_symbol[symbol].append({**sig, "_action_normalized": action, "_conf": conf})

    results: list[ConsensusSignal] = []

    for symbol, sym_signals in by_symbol.items():
        # Ordenar por confianza desc, limitar
        sym_signals.sort(key=lambda s: s["_conf"], reverse=True)
        sym_signals = sym_signals[:max_signals_per_symbol]

        if len(sym_signals) < require_min_signals:
            continue

        vote_long = 0.0
        vote_short = 0.0
        vote_exit = 0.0
        sources: list[str] = []

        for s in sym_signals:
            action = s["_action_normalized"]
            weight = s["_conf"] if weight_by_confidence else 1.0
            if action == "long":
                vote_long += weight
            elif action == "short":
                vote_short += weight
            elif action == "exit":
                vote_exit += weight
            plugin_id = s.get("plugin_id") or s.get("type", "unknown")
            if plugin_id not in sources:
                sources.append(plugin_id)

        total = vote_long + vote_short + vote_exit
        if total == 0:
            continue

        # Determinar ganador
        if vote_exit > vote_long and vote_exit > vote_short:
            winner = "exit"
            winning_votes = vote_exit
        elif vote_long >= vote_short:
            winner = "long"
            winning_votes = vote_long
        else:
            winner = "short"
            winning_votes = vote_short

        agreement = (winning_votes / total) * 100

        # Comprobar conflicto
        has_conflict = vote_long > 0 and vote_short > 0
        if has_conflict and conflict_resolution == "skip" and winner in ("long", "short"):
            continue

        if agreement < min_agreement_pct:
            continue

        # Confianza consenso: promedio ponderado de las señales ganadoras
        winning_sigs = [s for s in sym_signals if s["_action_normalized"] == winner]
        if winning_sigs:
            total_w = sum(s["_conf"] for s in winning_sigs)
            conf = total_w / len(winning_sigs)
        else:
            conf = winning_votes / len(sym_signals)

        # Penalizar si hay conflicto pero usamos "dominant"
        if has_conflict:
            conf = round(conf * 0.85, 3)

        results.append(
            ConsensusSignal(
                symbol=symbol,
                action=winner,
                confidence=round(conf, 3),
                vote_long=round(vote_long, 3),
                vote_short=round(vote_short, 3),
                vote_exit=round(vote_exit, 3),
                agreement_pct=round(agreement, 1),
                contributing_signals=len(sym_signals),
                sources=sources,
            )
        )

    # Ordenar por confianza descendente
    results.sort(key=lambda r: r.confidence, reverse=True)
    return results


if __name__ == "__main__":
    data = json.load(sys.stdin)
    results = aggregate_signals(
        signals=data.get("signals", []),
        min_confidence=data.get("min_confidence", 0.6),
        min_agreement_pct=data.get("min_agreement_pct", 60.0),
        weight_by_confidence=data.get("weight_by_confidence", True),
        require_min_signals=data.get("require_min_signals", 2),
        max_signals_per_symbol=data.get("max_signals_per_symbol", 10),
        conflict_resolution=data.get("conflict_resolution", "skip"),
    )
    print(json.dumps({"ok": True, "consensus": [asdict(r) for r in results]}))
