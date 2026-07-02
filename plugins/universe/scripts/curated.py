"""
Curated symbol lists for the consolidated universe plugin.

Each list is copied verbatim from its original source plugin.
Sources:
  - NASDAQ100: plugins/universe-nasdaq100/hooks/on_activate.py (June 2026)
  - DEFI_TOP20_BASE: plugins/universe-crypto-defi/hooks/on_activate.py (June 2026)
  - ETF_THEMATIC: plugins/universe-etf-thematic/hooks/on_activate.py (June 2026)
  - FOREX_MAJORS / FOREX_CROSSES: plugins/universe-forex-majors/hooks/on_activate.py (June 2026)
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Snapshot vintage — all curated lists below are present-day membership as of
# this date. Backtests over these lists are subject to survivorship bias for
# any period before this date (delisted/removed constituents are absent).
# ---------------------------------------------------------------------------

UNIVERSE_SNAPSHOT_DATE = "2026-06-30"

# ---------------------------------------------------------------------------
# Nasdaq-100 (June 2026, by market cap)
# ---------------------------------------------------------------------------

NASDAQ100 = [
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "META",
    "GOOGL",
    "GOOG",
    "TSLA",
    "AVGO",
    "COST",
    "NFLX",
    "TMUS",
    "AMD",
    "PEP",
    "LIN",
    "ADBE",
    "QCOM",
    "TXN",
    "INTU",
    "AMAT",
    "ISRG",
    "BKNG",
    "CSCO",
    "CMCSA",
    "HON",
    "VRTX",
    "ADP",
    "MU",
    "PANW",
    "LRCX",
    "SBUX",
    "KLAC",
    "MELI",
    "SNPS",
    "CDNS",
    "GILD",
    "MDLZ",
    "REGN",
    "ADI",
    "PYPL",
    "CTAS",
    "MAR",
    "ORLY",
    "FTNT",
    "ASML",
    "MNST",
    "CEG",
    "MRVL",
    "ROP",
    "PCAR",
    "ROST",
    "AZN",
    "CPRT",
    "TTD",
    "NXPI",
    "ODFL",
    "DXCM",
    "CHTR",
    "WDAY",
    "IDXX",
    "FAST",
    "GEHC",
    "EXC",
    "KDP",
    "CCEP",
    "VRSK",
    "BKR",
    "EA",
    "ZS",
    "XEL",
    "FANG",
    "TEAM",
    "ANSS",
    "ON",
    "CDW",
    "GFS",
    "DDOG",
    "BIIB",
    "SMCI",
    "PDD",
    "PAYX",
    "CRWD",
    "ILMN",
    "MDB",
    "MCHP",
    "DLTR",
    "WBD",
    "LCID",
    "RIVN",
    "ALGN",
    "SGEN",
    "ENPH",
    "ZM",
    "DOCU",
    "OKTA",
    "COUP",
    "MTCH",
    "LULU",
    "TSCO",
    "EBAY",
]

# ---------------------------------------------------------------------------
# Crypto DeFi Top 20 (June 2026, excluding BTC and ETH)
# ---------------------------------------------------------------------------

DEFI_TOP20_BASE = [
    "UNI",    # Uniswap — DEX
    "LINK",   # Chainlink — Oracle
    "AAVE",   # Aave — Lending
    "MKR",    # Maker — CDP/Stablecoin
    "CRV",    # Curve — Stablecoin DEX
    "COMP",   # Compound — Lending
    "SNX",    # Synthetix — Derivados sintéticos
    "BAL",    # Balancer — AMM weighted pools
    "YFI",    # Yearn Finance — Yield aggregator
    "SUSHI",  # SushiSwap — DEX
    "1INCH",  # 1inch — DEX aggregator
    "LDO",    # Lido — Liquid staking
    "RPL",    # Rocket Pool — ETH staking
    "CVX",    # Convex Finance — Curve booster
    "FXS",    # Frax — Stablecoin
    "GMX",    # GMX — Perpetual DEX
    "DYDX",   # dYdX — Perps CEX/DEX
    "INJ",    # Injective — Derivatives chain
    "PENDLE", # Pendle — Yield trading
    "ENA",    # Ethena — Synthetic dollar
]

# ---------------------------------------------------------------------------
# ETF Thematic (June 2026)
# ---------------------------------------------------------------------------

ETF_THEMATIC: dict[str, dict] = {
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

ETF_THEMATIC_REFERENCE = ["SPY", "QQQ", "IWM"]

# Default-enabled categories (matches original plugin defaults)
ETF_THEMATIC_DEFAULTS: dict[str, bool] = {
    "ark": True,
    "semis": True,
    "cyber": True,
    "energy": True,
    "ai": True,
    "biotech": False,
    "cloud": True,
    "fintech": False,
}

# ---------------------------------------------------------------------------
# Forex Majors / Crosses (June 2026)
# ---------------------------------------------------------------------------

FOREX_MAJORS = ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "USD/CAD", "NZD/USD"]

FOREX_CROSSES = [
    "EUR/GBP",
    "EUR/JPY",
    "EUR/CHF",
    "EUR/AUD",
    "EUR/CAD",
    "GBP/JPY",
    "GBP/CHF",
    "GBP/AUD",
    "GBP/CAD",
    "AUD/JPY",
    "AUD/CAD",
    "AUD/NZD",
    "CAD/JPY",
    "CHF/JPY",
]


# ---------------------------------------------------------------------------
# Union builder
# ---------------------------------------------------------------------------


def get_universe(markets: list[str], config: dict | None = None) -> list[str]:
    """
    Return the de-duplicated union of symbols for the requested markets.

    Supported market keys:
      - "nasdaq100"
      - "crypto-defi"
      - "etf-thematic"
      - "forex-majors"

    Unknown keys are silently ignored.

    For "crypto-defi": uses raw base tokens (no quote suffix, no format
      transformation) so the merged universe stays format-neutral.
    For "forex-majors": uses slash format (EUR/USD etc.) by default.
    For "etf-thematic": uses the default category selection unless per-category
      config keys (include_ark, include_semis, …) are present in config.
    """
    cfg = config or {}
    seen: set[str] = set()
    result: list[str] = []

    def _add(symbols: list[str]) -> None:
        for s in symbols:
            if s not in seen:
                seen.add(s)
                result.append(s)

    for market in markets:
        if market == "nasdaq100":
            _add(NASDAQ100)

        elif market == "crypto-defi":
            _add(DEFI_TOP20_BASE)

        elif market == "etf-thematic":
            for category, data in ETF_THEMATIC.items():
                key = f"include_{category}"
                enabled = cfg.get(key, ETF_THEMATIC_DEFAULTS.get(category, True))
                if enabled:
                    _add(data["symbols"])

        elif market == "forex-majors":
            _add(FOREX_MAJORS)
            if cfg.get("include_crosses", False):
                _add(FOREX_CROSSES)

        # Unknown market keys are silently ignored

    return result
