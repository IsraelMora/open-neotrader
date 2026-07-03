"""
Hook on_cycle del Telegram Notifier.
Filtra senales del ciclo segun los umbrales configurados en el manifest [config]
y emite notify_intents para que el kernel's NotifierBridge despache los mensajes.
Este hook NO realiza llamadas de red — es pura politica de filtrado y formato.
"""

from __future__ import annotations

import json
import sys
from typing import Any

# Default thresholds (mirror manifest [config] defaults)
_DEFAULT_MIN_CONFIDENCE = 0.7
_DEFAULT_MAX_MESSAGES = 10


def _format_signal_message(signal: dict[str, Any]) -> str:
    """Format a single trading signal into a Telegram message string."""
    symbol = signal.get("symbol", "UNKNOWN")
    action = signal.get("action", "signal").upper()
    confidence = signal.get("confidence", 0.0)
    confidence_pct = f"{confidence:.0%}"

    parts = [f"[{action}] {symbol} — confidence: {confidence_pct}"]

    price = signal.get("price")
    if price is not None:
        parts.append(f"Price: {price}")

    reason = signal.get("reason") or signal.get("rationale")
    if reason:
        parts.append(f"Reason: {reason}")

    return "\n".join(parts)


def on_cycle(ctx: dict) -> dict:
    """Read cycle signals, apply policy thresholds, emit notify_intents."""
    config = ctx.get("plugin_config", {})

    # Read thresholds from plugin config (injected by runner from manifest [config])
    min_confidence: float = float(config.get("min_confidence", _DEFAULT_MIN_CONFIDENCE))
    max_messages: int = int(config.get("max_messages_per_cycle", _DEFAULT_MAX_MESSAGES))

    signals: list[dict] = ctx.get("signals", [])

    if not signals:
        return {}

    # Filter signals that meet the confidence threshold
    qualifying = [
        s for s in signals
        if float(s.get("confidence", 0.0)) >= min_confidence
    ]

    if not qualifying:
        return {}

    # Respect max_messages_per_cycle cap
    capped = qualifying[:max_messages]

    intents: list[dict] = ctx.get("notify_intents", [])
    for signal in capped:
        text = _format_signal_message(signal)
        intents.append({"channel": "telegram", "text": text})

    return {"notify_intents": intents}


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = on_cycle(ctx)
    print(json.dumps(out))
