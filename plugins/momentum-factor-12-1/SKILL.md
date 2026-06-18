---
name: Momentum Factor 12-1
description: Estrategia de momentum cross-sectional. Clasifica activos por retorno de 12 meses (omitiendo el último) y compra el quintil superior. Uno de los factores más replicados en finanzas empíricas. Úsalo para selección mensual de activos dentro de un universo definido.
---

# Momentum Factor 12-1

## Base académica

**Jegadeesh & Titman (1993)**: "Returns to Buying Winners and Selling Losers". *Journal of Finance*.

Descubrimiento: los activos con mejor rendimiento en los últimos 3-12 meses tienden a seguir superando al mercado en los próximos 3-12 meses. El efecto es robusto, se ha replicado en 50+ años de datos y en múltiples mercados.

### Por qué funciona (hipótesis)

1. **Underreaction**: los inversores reaccionan lento a buenas noticias → el precio sube gradualmente
2. **Momentum de earnings**: empresas con buenos resultados tienden a seguir reportando bien
3. **Flujos de capital**: fondos con mandato de momentum amplifican el efecto
4. **Sesgo de disposición**: los inversores venden ganadores demasiado pronto → frenando el alza

### Evidencia empírica

| Período | Mercado | Retorno anual excess | Sharpe |
|---------|---------|---------------------|--------|
| 1927-2023 | US equities | +5.2% vs market | 0.52 |
| 1990-2023 | Europa | +6.1% vs market | 0.61 |
| 1990-2023 | Japón | +2.1% vs market | 0.23 |
| 1990-2023 | EM | +4.8% vs market | 0.48 |

*Fuente: AQR Factor Library, Ken French Data Library*

**Advertencia**: momentum tiene **crashes severos** (~50-70% drawdown) al inicio de recuperaciones bruscas (marzo 2009, abril 2020). Mitigación: añadir filtro de tendencia de mercado.

## Fórmula

```
Retorno_momentum(activo_i) = precio_actual / precio_hace_(12-1)_meses - 1

# Omitimos el último mes para evitar el efecto de reversión de 1 mes
# que va en contra del momentum de mediano plazo
```

## Flujo de análisis mensual

### Paso 1: Recopilar retornos del universo
Para cada activo en el universo:
```
proveedor__get_ohlcv(symbol=X, timeframe="1Month", limit=14)
# Necesitamos 13 meses: 12 + 1 de skip + 1 extra para precios de apertura
```

### Paso 2: Calcular retorno 12-1
```
retorno_12_1 = precio_cierre_mes_0 / precio_cierre_mes_(-13) - 1
# Nota: mes_0 = mes actual, mes_(-1) = hace 1 mes (se omite), mes_(-13) = hace 13 meses
```

### Paso 3: Rankear y seleccionar
```
rankings = sorted(activos, key=lambda x: x.retorno_12_1, reverse=True)
top_20pct = rankings[:int(len(rankings) * 0.20)]  # configurable
```

### Paso 4: Generar señales
- **LONG**: activos en el top 20% del ranking
- **SALIR**: activos que salieron del top 20% en el rebalanceo anterior
- Emitir señal `momentum_signal` para cada activo

## Gestión de riesgo específica de momentum

### Momentum Crash Mitigation (Daniel & Moskowitz, 2016)

El momentum crashea cuando el mercado cae mucho y luego rebota. Para mitigarlo:

```
Filtro de tendencia:
  Si precio_índice > MA200_índice → aplicar momentum normal
  Si precio_índice < MA200_índice → reducir exposición al 50% o salir

Volatility scaling:
  peso_i = retorno_momentum_i / volatilidad_12m_i
  (activos más estables reciben más peso)
```

### Señales de salida

- Activo sale del top quintil → salir en siguiente rebalanceo (no inmediatamente)
- Retorno rolling de 1 mes del activo < -10% → salida preventiva (stop de momentum)
- Mercado en downtrend (precio < MA200) → reducir exposición

## Combinaciones probadas

| Combinación | Efecto |
|-------------|--------|
| Momentum + Quality factor | +15% Sharpe, -30% crashes |
| Momentum + Low Volatility | +8% Sharpe, -25% crashes |
| Momentum + Trend filter | -20% retorno bruto, -40% drawdown |
| Momentum + Value (contrarian) | Neutro — se cancelan |

## Cuándo NO usar este skill

- Universe < 20 activos: insuficiente para diversificación cross-sectional
- Mercados muy ilíquidos: costos de transacción eliminan el alpha
- Crisis sistémica activa: momentum crashea — pasar a efectivo

## Referencias clave

- Jegadeesh & Titman (1993). "Returns to Buying Winners and Selling Losers." JoF.
- Asness, Moskowitz & Pedersen (2013). "Value and Momentum Everywhere." JoF.
- Daniel & Moskowitz (2016). "Momentum Crashes." JFE.
- AQR (2012). "Fact, Fiction and Momentum Investing."

## Notas aprendidas

<!-- El LLM actualiza esta sección con observaciones de ciclos reales -->
