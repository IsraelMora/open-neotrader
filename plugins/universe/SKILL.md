---
name: Universe — Multi-Market
description: Proveedor de universo configurable que consolida Nasdaq-100, Crypto DeFi Top 20, ETFs Temáticos y Forex Majors en un único plugin. Activar con config.markets para seleccionar qué mercados incluir.
---

# Universe — Multi-Market

## Descripción

Plugin de universo único que reemplaza los cuatro proveedores individuales
(`universe-nasdaq100`, `universe-crypto-defi`, `universe-etf-thematic`,
`universe-forex-majors`). La lista activa se construye como la unión
sin duplicados de los mercados seleccionados.

## Mercados disponibles

| Clave `markets` | Descripción | Símbolos aprox. |
|----------------|-------------|-----------------|
| `nasdaq100` | Nasdaq-100 por capitalización (jun 2026) | 100 |
| `crypto-defi` | DeFi Top 20 por liquidez (base tokens) | 20 |
| `etf-thematic` | ETFs temáticos de alto crecimiento | 17–25 (según categorías) |
| `forex-majors` | 7 pares de divisas principales (+ cruces opcionales) | 7–21 |

## Configuración

```toml
[config]
markets = "nasdaq100"                     # uno o más, separados por coma
# markets = "nasdaq100,crypto-defi"       # unión de dos mercados
# markets = "etf-thematic,forex-majors"  # unión de ETFs y forex

# ETF Thematic — categorías (sólo aplica si "etf-thematic" está en markets)
include_ark     = true
include_semis   = true
include_cyber   = true
include_energy  = true
include_ai      = true
include_biotech = false   # alta volatilidad; deshabilitado por defecto
include_cloud   = true
include_fintech = false

# Forex — cruces opcionales (sólo aplica si "forex-majors" está en markets)
include_crosses = false   # añade 14 pares cruzados (EUR/GBP, GBP/JPY, etc.)
```

## Contrato de retorno

```json
{
  "ok": true,
  "universe": ["AAPL", "MSFT", "..."],
  "count": 100,
  "message": "Universe activado: 100 símbolos [nasdaq100]"
}
```

## Combinaciones recomendadas

| Configuración | Uso ideal |
|--------------|-----------|
| `nasdaq100` | Estrategias momentum/growth, EMA crossover |
| `crypto-defi` | DeFi 24/7, trading de tokens en Binance |
| `etf-thematic` | Rotación sectorial tech con ETFs |
| `forex-majors` | Mean reversion y macro trading intradiario |
| `nasdaq100,etf-thematic` | Cobertura amplia de equity tech |
| `crypto-defi,forex-majors` | Multi-asset 24h sin renta variable |

## Notas

- La unión elimina duplicados manteniendo el orden de inserción por mercado.
- Keys desconocidas en `markets` se ignoran silenciosamente.
- El formato de crypto-defi son base tokens (`UNI`, `LINK`…), sin sufijo de par.
  Si tu provider requiere `UNIUSDT`, adapta con un plugin de normalización downstream.
- Forex usa formato slash (`EUR/USD`) por defecto.

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre combinaciones en ciclos reales -->
