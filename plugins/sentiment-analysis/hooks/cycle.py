"""
Sentiment Analysis — hook de ciclo.

Flujo:
1. Obtiene universo de símbolos activos (limitado a symbols_per_cycle)
2. Para cada símbolo, obtiene noticias via get_news (tool → ProviderGatewayService → NewsAPI)
3. El LLM evalúa el sentimiento de los titulares
4. Si el score supera min_score, emite señal de sentimiento
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from sentiment import build_symbol_sentiment, format_for_llm


def on_cycle(ctx):
    cfg = ctx.get("config", {})
    universe = ctx.get("universe", [])
    news_by_symbol = ctx.get("news_by_symbol", {})  # {symbol: [articles]}
    llm_scores = ctx.get("llm_sentiment_scores", {})  # {symbol: [scores]}

    min_score = cfg.get("min_score", 0.6)
    min_articles = cfg.get("min_articles", 3)
    max_symbols = cfg.get("symbols_per_cycle", 5)

    if not universe:
        return {"signals": [], "logs": ["Sin universo activo"]}

    symbols = universe[:max_symbols]
    signals = []
    logs = []
    llm_requests = []

    for symbol in symbols:
        articles = news_by_symbol.get(symbol, [])

        if not articles:
            logs.append(f"{symbol}: sin noticias disponibles")
            continue

        if len(articles) < min_articles:
            logs.append(f"{symbol}: solo {len(articles)} artículos (min {min_articles})")
            continue

        scores = llm_scores.get(symbol)

        if not scores:
            # Solicitar al LLM que evalúe — se incluye en logs para que el orquestador lo atienda
            llm_requests.append(
                {
                    "symbol": symbol,
                    "prompt": format_for_llm(symbol, articles),
                    "articles": len(articles),
                }
            )
            logs.append(f"{symbol}: solicitando evaluación LLM de {len(articles)} artículos")
            continue

        analysis = build_symbol_sentiment(symbol, articles, scores)

        logs.append(
            f"{symbol}: score={analysis.composite_score:+.2f} "
            f"({analysis.bullish_count}↑ {analysis.bearish_count}↓ {analysis.neutral_count}=) "
            f"→ {analysis.signal.upper()} (conf={analysis.confidence:.2f})"
        )

        if analysis.signal == "neutral":
            continue

        abs_score = abs(analysis.composite_score)
        if abs_score < min_score or analysis.confidence < 0.3:
            logs.append("  ↳ score/conf por debajo del umbral, sin señal")
            continue

        signals.append(
            {
                "plugin_id": "sentiment-analysis",
                "symbol": symbol,
                "action": "long" if analysis.signal == "bullish" else "short",
                "confidence": round(analysis.confidence, 3),
                "sentiment_score": analysis.composite_score,
                "signal_type": "sentiment",
                "articles_analyzed": analysis.articles_analyzed,
                "top_headlines": analysis.top_headlines,
                "metadata": {
                    "bullish_articles": analysis.bullish_count,
                    "bearish_articles": analysis.bearish_count,
                },
            }
        )

    return {
        "signals": signals,
        "llm_requests": llm_requests,  # el orquestador debe procesar estas peticiones
        "logs": logs,
    }
