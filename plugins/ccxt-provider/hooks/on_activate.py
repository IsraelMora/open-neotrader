"""
CCXT Provider — validación de activación.
Verifica que las credenciales tengan el formato correcto y que el exchange configurado sea conocido.
La conexión real al exchange se realiza desde ProviderGatewayService (acceso a red).
"""

KNOWN_EXCHANGES = [
    "binance",
    "kraken",
    "kucoin",
    "okx",
    "bybit",
    "coinbase",
    "bitfinex",
    "huobi",
    "gateio",
    "bitget",
    "mexc",
    "phemex",
    "deribit",
    "bitmex",
    "poloniex",
    "bitstamp",
    "gemini",
    "ftx",
    "upbit",
    "bithumb",
    "hitbtc",
    "lbank",
    "bitmart",
    "probit",
    "whitebit",
    "latoken",
]

VALID_MARKET_TYPES = {"spot", "future", "swap", "option"}
VALID_SYMBOL_FMTS = {"slash", "nodash", "underscore"}


def on_activate(ctx):
    cfg = ctx.get("config", {})
    creds = ctx.get("credentials", {})

    errors = []
    warnings = []

    exchange = cfg.get("exchange", "kraken").lower()
    if exchange not in KNOWN_EXCHANGES:
        warnings.append(
            f"Exchange '{exchange}' no está en la lista conocida. "
            "Puede funcionar si CCXT lo soporta, pero verifica el ID exacto."
        )

    market_type = cfg.get("market_type", "spot")
    if market_type not in VALID_MARKET_TYPES:
        errors.append(f"market_type debe ser uno de: {', '.join(VALID_MARKET_TYPES)}")

    symbol_fmt = cfg.get("symbol_fmt", "slash")
    if symbol_fmt not in VALID_SYMBOL_FMTS:
        errors.append("symbol_fmt debe ser: slash, nodash o underscore")

    rate_limit = cfg.get("rate_limit", 1200)
    if not isinstance(rate_limit, int) or rate_limit < 100:
        errors.append("rate_limit debe ser entero >= 100 ms")

    api_key = creds.get("api_key", "")
    api_secret = creds.get("api_secret", "")

    if not api_key or not api_secret:
        warnings.append(
            "Sin credenciales: solo se podrán hacer peticiones públicas "
            "(OHLCV, quotes). Para órdenes se necesita api_key + api_secret."
        )
    elif len(api_key) < 8 or len(api_secret) < 8:
        errors.append("api_key y api_secret parecen demasiado cortos")

    if errors:
        return {"ok": False, "errors": errors, "warnings": warnings}

    return {
        "ok": True,
        "message": (
            f"CCXT provider configurado: exchange={exchange}, "
            f"market_type={market_type}, "
            f"auth={'yes' if api_key else 'public-only'}"
        ),
        "warnings": warnings,
    }
