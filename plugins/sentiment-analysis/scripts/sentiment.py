"""
Sentiment Analysis — procesamiento de noticias en sandbox.

El LLM hace la evaluación semántica del sentimiento.
Este módulo: extrae texto relevante, normaliza scores, aplica reglas heurísticas
y prepara el output para el LLM.
"""

from dataclasses import dataclass

# Palabras positivas financieras (score base +0.1 cada una, max boost +0.3)
BULLISH_KEYWORDS = [
    "beat",
    "beats",
    "surpasses",
    "record",
    "growth",
    "profit",
    "upgrade",
    "outperform",
    "buy",
    "strong",
    "rally",
    "surge",
    "soar",
    "gain",
    "bullish",
    "positive",
    "upside",
    "momentum",
    "partnership",
    "deal",
    "revenue growth",
    "earnings beat",
    "raised guidance",
    "stock split",
    "buyback",
    "dividend increase",
]

# Palabras negativas financieras (score base -0.1 cada una)
BEARISH_KEYWORDS = [
    "miss",
    "misses",
    "disappoints",
    "loss",
    "decline",
    "downgrade",
    "sell",
    "weak",
    "crash",
    "plunge",
    "drop",
    "fall",
    "bearish",
    "negative",
    "downside",
    "cut",
    "layoffs",
    "lawsuit",
    "investigation",
    "fraud",
    "miss guidance",
    "revenue miss",
    "lowered guidance",
    "bankruptcy",
    "default",
    "recall",
    "fine",
    "penalty",
]

# Señales de alta urgencia (amplifican el score x1.5)
HIGH_URGENCY = [
    "breaking",
    "just in",
    "urgent",
    "emergency",
    "fda approval",
    "merger",
    "acquisition",
    "takeover",
    "sec charges",
    "ceo resign",
]


@dataclass
class ArticleSentiment:
    title: str
    source: str
    published: str
    score: float  # -1.0 (muy negativo) a +1.0 (muy positivo)
    magnitude: float  # 0.0 a 1.0 (certeza del score)
    keywords: list[str]  # palabras clave detectadas
    urgent: bool


@dataclass
class SymbolSentiment:
    symbol: str
    articles_analyzed: int
    composite_score: float  # promedio ponderado por magnitud
    bullish_count: int
    bearish_count: int
    neutral_count: int
    top_headlines: list[str]
    signal: str  # "bullish" | "bearish" | "neutral"
    confidence: float  # 0.0 - 1.0


def analyze_text_heuristic(title: str, description: str = "") -> ArticleSentiment:
    """
    Análisis heurístico rápido del texto (backup si el LLM no está disponible).
    El LLM reemplaza o mejora este análisis.
    """
    text = (title + " " + description).lower()

    bull_hits = [kw for kw in BULLISH_KEYWORDS if kw in text]
    bear_hits = [kw for kw in BEARISH_KEYWORDS if kw in text]
    urgent = any(u in text for u in HIGH_URGENCY)

    bull_score = min(len(bull_hits) * 0.15, 0.9)
    bear_score = min(len(bear_hits) * 0.15, 0.9)

    raw_score = bull_score - bear_score
    raw_score = max(-1.0, min(1.0, raw_score))

    if urgent:
        raw_score *= 1.5
        raw_score = max(-1.0, min(1.0, raw_score))

    magnitude = min((len(bull_hits) + len(bear_hits)) * 0.1, 1.0)

    return ArticleSentiment(
        title=title,
        source="",
        published="",
        score=round(raw_score, 3),
        magnitude=round(magnitude, 3),
        keywords=bull_hits + bear_hits,
        urgent=urgent,
    )


def aggregate_articles(articles: list[ArticleSentiment]) -> tuple[float, float]:
    """
    Agrega múltiples artículos en un score compuesto ponderado por magnitud.
    Retorna (composite_score, confidence).
    """
    if not articles:
        return 0.0, 0.0

    weighted_sum = sum(a.score * max(a.magnitude, 0.1) for a in articles)
    weight_total = sum(max(a.magnitude, 0.1) for a in articles)

    composite = weighted_sum / weight_total if weight_total > 0 else 0.0

    # Confidence aumenta con nº artículos y magnitud media
    n = len(articles)
    avg_mag = weight_total / n
    confidence = min(avg_mag * (1 + n * 0.1), 1.0)

    return round(composite, 3), round(confidence, 3)


def build_symbol_sentiment(
    symbol: str,
    articles: list[dict],
    llm_scores: list[float] | None = None,
) -> SymbolSentiment:
    """
    Construye el análisis de sentimiento para un símbolo.

    articles: [{"title": ..., "description": ..., "source": ..., "publishedAt": ...}]
    llm_scores: si el LLM provee scores, se usan; si no, se usa heurística
    """
    sentiments: list[ArticleSentiment] = []

    for i, art in enumerate(articles):
        if llm_scores and i < len(llm_scores):
            score = max(-1.0, min(1.0, float(llm_scores[i])))
            sent = ArticleSentiment(
                title=art.get("title", ""),
                source=art.get("source", {}).get("name", "")
                if isinstance(art.get("source"), dict)
                else str(art.get("source", "")),
                published=art.get("publishedAt", ""),
                score=score,
                magnitude=min(abs(score) + 0.3, 1.0),
                keywords=[],
                urgent=any(u in art.get("title", "").lower() for u in HIGH_URGENCY),
            )
        else:
            sent = analyze_text_heuristic(
                art.get("title", ""),
                art.get("description", ""),
            )
            sent.source = (
                art.get("source", {}).get("name", "") if isinstance(art.get("source"), dict) else ""
            )
            sent.published = art.get("publishedAt", "")

        sentiments.append(sent)

    composite, confidence = aggregate_articles(sentiments)

    bullish = sum(1 for s in sentiments if s.score > 0.1)
    bearish = sum(1 for s in sentiments if s.score < -0.1)
    neutral = len(sentiments) - bullish - bearish

    if composite > 0.15:
        signal = "bullish"
    elif composite < -0.15:
        signal = "bearish"
    else:
        signal = "neutral"

    top_headlines = [
        s.title for s in sorted(sentiments, key=lambda x: abs(x.score), reverse=True)[:3]
    ]

    return SymbolSentiment(
        symbol=symbol,
        articles_analyzed=len(sentiments),
        composite_score=composite,
        bullish_count=bullish,
        bearish_count=bearish,
        neutral_count=neutral,
        top_headlines=top_headlines,
        signal=signal,
        confidence=confidence,
    )


def format_for_llm(symbol: str, articles: list[dict]) -> str:
    """
    Formatea artículos para que el LLM los evalúe y devuelva scores.
    """
    lines = [
        f"Analiza el sentimiento de estas noticias para {symbol}"
        " (escala -1.0 muy negativo a +1.0 muy positivo):"
    ]
    for i, art in enumerate(articles[:10]):
        title = art.get("title", "Sin título")[:200]
        desc = art.get("description", "")[:200] if art.get("description") else ""
        lines.append(f"\n[{i + 1}] {title}")
        if desc:
            lines.append(f"    {desc}")
    lines.append(
        "\nDevuelve SOLO una lista de números, uno por artículo, en el mismo orden. "
        "Ejemplo: [-0.7, 0.3, 0.1, ...]"
    )
    return "\n".join(lines)
