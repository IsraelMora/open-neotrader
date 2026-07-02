"""
decision — the orchestrator LLM's trade-intent ACTION tool.

After reasoning over the textual context and the passive plugins' signals, the
LLM calls emit_trade_intent(...) to express exactly ONE trade decision. This is
the LLM's working action surface (it has a plugin.py, so runner.cmd_call_plugin
can dispatch it — unlike the price-driven strategy tools, which are passive by
design and were never LLM-callable).

Boundaries (by kernel design):
  - NEVER receives or returns prices (the LLM only sees text/news/events).
  - NEVER places a broker order. It records a structured INTENT. The kernel
    captures it (the args carry symbol+action) into audit + memory, and the
    veto-gate filtered which signals the LLM saw BEFORE this call.
  - Actual execution, a post-decision veto, and human-in-the-loop approval are a
    separate, deliberately-unbuilt layer (needs a TradeIntent store + broker
    wiring + HITL). This tool is the clean entry point those would consume.
"""
from __future__ import annotations

_VALID_ACTIONS = {"long", "short", "exit", "hold"}


def emit_trade_intent(
    symbol=None,
    action=None,
    confidence=None,
    rationale=None,
    timeframe=None,
    _context=None,
    **_ignored,  # absorb any stray args (e.g. accidental price fields) — never crash
) -> dict:
    """Record one trade intent. Returns {"ok": True, "result": {...}} or
    {"ok": False, "error": "..."} on a validation failure."""
    if not isinstance(symbol, str) or not symbol.strip():
        return {"ok": False, "error": "symbol requerido (string no vacío)"}

    if action not in _VALID_ACTIONS:
        return {
            "ok": False,
            "error": f"action inválida: {action!r}. Válidas: {sorted(_VALID_ACTIONS)}",
        }

    # "exit"/"hold" only need symbol+action to act (close a position / do nothing).
    # Cosmetic malformed confidence/rationale on these must NOT hard-reject the intent —
    # a rejected exit never reaches TradeIntentService and a real position can never be
    # closed. Instead, clamp confidence into [0, 1] and default an empty rationale.
    # Strict validation below stays UNCHANGED for "long"/"short" entries.
    if action in ("exit", "hold"):
        try:
            conf = float(confidence)
        except (TypeError, ValueError):
            conf = 1.0
        conf = max(0.0, min(1.0, conf))

        if not isinstance(rationale, str) or not rationale.strip():
            rationale = "position close" if action == "exit" else "hold — no position change"

        return {
            "ok": True,
            "result": {
                "symbol": symbol.strip().upper(),
                "action": action,
                "confidence": round(conf, 4),
                "rationale": rationale.strip(),
                "timeframe": timeframe or "1d",
                "status": "recorded",
            },
        }

    try:
        conf = float(confidence)
    except (TypeError, ValueError):
        return {"ok": False, "error": "confidence debe ser numérico en [0, 1]"}
    if not 0.0 <= conf <= 1.0:
        return {"ok": False, "error": "confidence fuera de rango [0, 1]"}

    if not isinstance(rationale, str) or not rationale.strip():
        return {"ok": False, "error": "rationale requerido (explicá el porqué de la decisión)"}

    return {
        "ok": True,
        "result": {
            "symbol": symbol.strip().upper(),
            "action": action,
            "confidence": round(conf, 4),
            "rationale": rationale.strip(),
            "timeframe": timeframe or "1d",
            "status": "recorded",
        },
    }
