---
name: S&P 500 Universe
description: Universo de los 500 activos del índice S&P 500. Filtrado por liquidez y capitalización. Usar como universo base para estrategias de equity USA (momentum, EMA crossover, etc.).
---

# S&P 500 Universe

## Descripción

El S&P 500 es el benchmark estándar de renta variable americana. Incluye las 500 empresas de mayor capitalización cotizadas en NYSE/NASDAQ, representando ~80% del mercado americano por capitalización.

## Por qué es un buen universo para algoritmos

- **Alta liquidez**: todos los componentes tienen volumen diario > $10M — costos de transacción mínimos
- **Diversificación**: 11 sectores, sin concentración excesiva en ninguno
- **Datos de calidad**: histórico limpio, ajustado por splits y dividendos
- **Benchmark conocido**: fácil comparar alpha generado vs el índice

## Componentes por sector (aproximado)

| Sector | % del índice | Ejemplos |
|--------|-------------|---------|
| Tecnología | ~30% | AAPL, MSFT, NVDA |
| Salud | ~13% | JNJ, UNH, PFE |
| Financiero | ~13% | JPM, BAC, WFC |
| Consumo discrecional | ~10% | AMZN, TSLA |
| Industriales | ~9% | CAT, HON |
| Comunicaciones | ~9% | GOOGL, META |
| Consumo básico | ~6% | PG, KO |
| Energía | ~4% | XOM, CVX |
| Utilities | ~2% | NEE, DUK |
| Materiales | ~2% | LIN, APD |
| Inmobiliario | ~2% | AMT, PLD |

## Filtros aplicados automáticamente

```
1. Excluir empresas en proceso de delisting o bancarrota
2. Liquidez mínima: volumen diario > promedio de 20 días × 0.5
3. Precio > $5 (excluir penny stocks)
4. Cap de mercado > config.min_market_cap_b (default: $1B)
```

## Uso con otras estrategias

- **Momentum 12-1**: ideal — universo suficientemente grande para ranking cross-sectional
- **EMA Crossover**: funciona bien — alta liquidez, stops ejecutables
- **Bollinger Squeeze**: excelente — datos de calidad, squeezes significativos
- **RSI Mean Reversion**: funciona con ciclos diarios

## Notas operativas

- Rebalanceo del S&P 500 ocurre ~trimestral — actualizar lista de componentes
- En crisis, las correlaciones del universo aumentan — menor beneficio de diversificación
- Considerar usar sectores SPDR (XLK, XLF, etc.) para estrategias de sector rotation

## Notas aprendidas

<!-- El LLM actualiza con observaciones -->
