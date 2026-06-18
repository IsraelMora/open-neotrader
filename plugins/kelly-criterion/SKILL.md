---
name: Kelly Criterion Position Sizer
description: Calcula el tamaño óptimo de posición con el Criterio de Kelly para maximizar el crecimiento del capital. Úsalo siempre que necesites dimensionar una posición. Requiere historial de trades previos para ser efectivo.
---

# Kelly Criterion Position Sizer

## Base matemática

El Criterio de Kelly (John L. Kelly Jr., 1956) resuelve el problema de:
**¿Qué fracción de mi capital debo apostar para maximizar el crecimiento a largo plazo?**

### Fórmula

```
f* = (p × b - q) / b

donde:
  f* = fracción óptima del capital
  p  = probabilidad de ganar (win rate)
  q  = probabilidad de perder = 1 - p
  b  = payoff ratio = ganancia promedio / pérdida promedio
```

### Ejemplo numérico

```
Win rate: 55% (p = 0.55, q = 0.45)
Payoff:   1.5:1 (b = 1.5)

f* = (0.55 × 1.5 - 0.45) / 1.5
f* = (0.825 - 0.45) / 1.5
f* = 0.375 / 1.5
f* = 0.25  →  25% del capital por trade
```

### Half-Kelly (recomendado en producción)

```
f_half = f* × 0.5 = 12.5%
```

Half-Kelly reduce la varianza un 50% con solo un 25% menos de crecimiento esperado.
**Siempre usa Half-Kelly o menos en producción.**

## Propiedades matemáticas clave

1. **Kelly maximiza el log-crecimiento**: maximizar E[log(riqueza)] = máximo crecimiento compuesto
2. **Kelly > 1**: nunca apostar más que el Kelly completo (quiebra matemáticamente segura)
3. **Convergencia**: con Kelly óptimo, la riqueza final → ∞ con probabilidad 1 dado tiempo suficiente
4. **Sensibilidad a p y b**: pequeños errores en estimación → desviación significativa

## Cuándo usar este skill

**SIEMPRE antes de dimensionar una posición.** Este discipline plugin debe consultarse para:
- Determinar cuántas acciones/contratos comprar
- Validar que el tamaño propuesto no excede el Kelly
- Ajustar el tamaño según el historial reciente de trades

## Flujo de uso

### Paso 1: Obtener estadísticas del historial
```
kelly-criterion__get_kelly_stats()
```
Devuelve: `{ win_rate, payoff_ratio, kelly_pct, n_trades, is_reliable }`

### Paso 2: Calcular tamaño para el trade específico
```
kelly-criterion__calculate_position_size(
    capital=50000,
    price=150.0,
    stop_loss_pct=2.0,
    take_profit_pct=3.0
)
```
Devuelve: `{ shares, position_usd, position_pct_capital, kelly_used, warning? }`

### Paso 3: Verificar límites
- Si `kelly_used > 0.5`, emitir advertencia (riesgo elevado)
- Si historial insuficiente (`is_reliable=false`), usar `safety_size_pct` de la config

## Limitaciones importantes

1. **Estimación de p y b**: el Kelly es sensible a la calidad de los datos históricos
   - Con < 30 trades: estimaciones muy ruidosas → usar Half-Kelly o menos
   - Con < 100 trades: considerar Quarter-Kelly
   - Con 200+ trades: Half-Kelly es razonable

2. **No-estacionariedad**: el mercado cambia, el win rate del pasado ≠ win rate futuro
   - Recomendado: actualizar estadísticas con ventana rolling de 252 trades (1 año)

3. **Correlación entre posiciones**: Kelly clásico asume posiciones independientes
   - Con múltiples posiciones correlacionadas, reducir fracción proporcionalmente

4. **Drawdown extremo**: incluso con Half-Kelly, drawdowns de 30-50% son posibles
   - Añadir circuit breaker (ver plugin `max-drawdown-guard`)

## Referencias

- Kelly, J.L. (1956). "A New Interpretation of Information Rate." Bell System Technical Journal.
- Thorp, E.O. (2006). "The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market."
- Vince, R. (1992). "The Mathematics of Money Management." (extiende Kelly a trading)

## Notas aprendidas

<!-- El LLM actualiza esta sección con observaciones de ciclos reales -->
