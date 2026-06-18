"""
Universe ETF Temáticos — activación.
Construye la lista de ETFs según la configuración.
"""

UNIVERSE = {
    "ark": {
        "symbols": ["ARKK", "ARKW", "ARKG", "ARKF", "ARKX"],
        "description": "ARK Innovation ETFs — disrupción tecnológica (Cathie Wood)",
    },
    "semis": {
        "symbols": ["SOXX", "SMH", "SOXQ"],
        "description": "Semiconductores — chips, fabs, EDA; altamente cíclico",
    },
    "cyber": {
        "symbols": ["HACK", "CIBR", "BUG"],
        "description": "Ciberseguridad — demanda secular creciente",
    },
    "energy": {
        "symbols": ["ICLN", "QCLN", "TAN", "FAN"],
        "description": "Clean Energy — solar, eólica, transición energética",
    },
    "ai": {
        "symbols": ["BOTZ", "ROBO", "AIQ", "QTUM"],
        "description": "Inteligencia Artificial y robótica",
    },
    "biotech": {
        "symbols": ["XBI", "IBB", "LABU"],
        "description": "Biotecnología — muy volátil; LABU es 3x leveraged",
    },
    "cloud": {
        "symbols": ["WCLD", "SKYY"],
        "description": "Cloud computing — SaaS, IaaS; múltiplos elevados",
    },
    "fintech": {
        "symbols": ["FINX", "ARKF"],
        "description": "Fintech — pagos digitales, neobancos, criptoinfrastructura",
    },
}

# ETFs de referencia (benchmark de mercado)
REFERENCE = ["SPY", "QQQ", "IWM"]


def on_activate(ctx):
    cfg = ctx.get("config", {})

    symbols = []
    enabled_categories = []

    for category, data in UNIVERSE.items():
        key = f"include_{category}"
        if cfg.get(key, category not in ("biotech", "fintech")):
            symbols.extend(data["symbols"])
            enabled_categories.append(f"{category.upper()}: {', '.join(data['symbols'])}")

    if not symbols:
        return {"ok": False, "error": "No hay categorías habilitadas. Activa al menos una."}

    # Eliminar duplicados manteniendo orden
    seen = set()
    unique_symbols = []
    for s in symbols:
        if s not in seen:
            seen.add(s)
            unique_symbols.append(s)

    return {
        "ok": True,
        "symbols": unique_symbols,
        "reference": REFERENCE,
        "count": len(unique_symbols),
        "categories": enabled_categories,
        "message": (
            f"Universo ETF Temáticos activado: {len(unique_symbols)} ETFs en "
            f"{len(enabled_categories)} categorías. "
            "NOTA: ETFs temáticos tienen alta correlación entre sí; "
            "usar con Correlation Guard activo."
        ),
    }
