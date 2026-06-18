---
name: Pairs Trading (Statistical Arbitrage)
description: Arbitraje estadístico entre pares cointegrados. Cuando el spread entre dos activos correlacionados diverge >2σ, compra el rezagado y vende el adelantado. Market-neutral — beneficio independiente de la dirección del mercado. Engle-Granger (1987).
---

# Pairs Trading (Statistical Arbitrage)

## Base académica

**Engle & Granger (1987)**: "Co-integration and Error Correction" (*Econometrica*).
Premio Nobel de Economía 2003. Dos series no-estacionarias pueden tener una combinación lineal estacionaria — eso es cointegración.

**Vidyamurthy (2004)**: "Pairs Trading: Quantitative Methods and Analysis".
Primer libro dedicado exclusivamente a pairs trading aplicado en mercados financieros.

**Gatev, Goetzmann & Rouwenhorst (2006)**: "Pairs Trading: Performance of a Relative Value Strategy". (*Review of Financial Studies*)
Documentan retornos anuales de 11% con Sharpe ~1.0 en 1962-2002.

## Por qué funciona

```
Pares cointegrados comparten el mismo "conductor" económico:
  Coca-Cola / PepsiCo       → misma industria, mismos consumidores
  GLD / SLV                 → precio de metales preciosos
  ExxonMobil / Chevron      → precio del petróleo
  EUR/USD / GBP/USD         → movimientos del USD

Cuando uno diverge del otro temporalmente:
  ✅ No es un cambio fundamental → vuelve a la media
  ✅ El spread es estacionario (media-revertiente)
  ✅ El retorno no depende del mercado (market-neutral)
```

## Matemáticas

### Beta (hedge ratio)

```
OLS: log(P_A) = α + β × log(P_B) + ε
β = covarianza(logA, logB) / varianza(logB)
```

### Spread

```
spread_t = log(P_A_t) - β × log(P_B_t)
```

### Z-Score del spread

```
Z_t = (spread_t - μ_spread) / σ_spread

Señal long_spread:  Z < -2.0  → A barato, B caro → long A + short B
Señal short_spread: Z > +2.0  → A caro, B barato → short A + long B
Salida:             |Z| < 0.5 → spread volvió a media
Stop:               |Z| > 3.5 → spread diverge, pérdida controlada
```

### Test de cointegración (ADF)

```
ADF < -2.5 → rechazar hipótesis de raíz unitaria → spread estacionario
```

## Gestión de tamaño

```
Long en A: comprar N acciones
Short en B: vender N × β acciones

→ El valor monetario de ambas piernas es igual (dollar-neutral)
→ El beta de mercado del par ≈ 0 (market-neutral)
```

## Mejores pares por clase de activo

### Acciones
- Coca-Cola / PepsiCo (KO/PEP)
- Visa / Mastercard (V/MA)
- Boeing / Airbus (BA/EADSY)
- JPMorgan / Bank of America (JPM/BAC)
- Gold ETF / Silver ETF (GLD/SLV)

### ETFs sectoriales
- XLK / QQQ (Technology ETFs)
- XLE / VDE (Energy ETFs)
- GLD / GDX (Gold vs Gold Miners)

### Forex
- EUR/USD / GBP/USD (USD driver)
- AUD/USD / NZD/USD (Pacific currencies)

## Cuándo NO usar pairs trading

❌ Cuando hay un evento fundamental que rompe la relación (fusión, quiebra)
❌ Si la correlación < 0.70 — el par no comparte el mismo driver
❌ En activos con baja liquidez — difícil ejecutar ambas piernas a la vez
❌ Períodos de crisis sistémica — las correlaciones se rompen

## Señales que emite

```
pairs_signal:
  action: "long_spread" | "short_spread" | "exit" | "stop"
  pair: "SYM_A/SYM_B"
  leg_a: { symbol, direction: "long"|"short"|"exit" }
  leg_b: { symbol, direction: "long"|"short"|"exit" }
  beta: hedge ratio
  z_score: valor actual
  confidence: 0.65 - 0.88
```

## Combinaciones

| Con plugin | Efecto |
|------------|--------|
| + Correlation Guard | Innecesario — pairs trading ya maneja correlaciones |
| + Kelly Criterion | Tamaño basado en win rate histórico del par |
| + Volatility Regime | En régimen "crisis" reducir tamaño (spreads se amplían) |

## Notas aprendidas

<!-- El LLM actualiza con observaciones de ciclos reales -->
