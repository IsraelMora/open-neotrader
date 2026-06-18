# Market Breadth — Salud del Mercado Amplio

## Por qué importa la amplitud
Un índice puede subir mientras la mayoría de sus componentes caen, simplemente porque las megacaps pesan mucho. La amplitud mide si el movimiento es amplio y sostenible o estrecho y frágil.

**Regla fundamental**: Tendencias sostenibles requieren participación amplia. Cuando solo las 5 empresas más grandes suben, el mercado es frágil.

## Indicadores implementados

### 1. Advance/Decline Ratio (A/D)
```
A/D = Nº activos que suben / Nº activos que bajan
```
- A/D > 2.0 → mercado sano
- A/D < 0.7 → distribución generalizada

### 2. % Activos sobre MA200
El porcentaje del universo por encima de su media de 200 días.
- > 70% → bull market sano
- < 30% → bear market generalizado
- 40-60% → mercado mixto / transición

### 3. McClellan Oscillator
EMA(19) − EMA(39) del Net Advance (Advances − Declines).
- Oscila normalmente entre -150 y +150
- Por encima de 0 y subiendo → impulso alcista
- Por debajo de 0 y cayendo → impulso bajista
- Lecturas extremas (+500/-500) → sobrecompra/sobreventa de breadth

### 4. New Highs / New Lows Ratio
Activos en máximos de 52 semanas vs mínimos de 52 semanas.
- NH/(NH+NL) > 70% → tendencia alcista robusta
- < 30% → deterioro avanzado

### 5. Breadth Thrust de Zweig (1986)
**La señal más potente**: cuando en 10 sesiones el A/D pasa de <40% a >61.5%.
- Solo ocurrió ~14 veces desde 1945
- Siempre precedió rallies sustanciales (+24% promedio a 12 meses)
- Sin falsas señales históricas

### 6. Divergencias Precio/Breadth
- **Bearish Divergence**: índice sube pero breadth deteriora → posible techo
- **Bullish Divergence**: índice cae pero breadth mejora → capitulación terminando

## Breadth Score Compuesto (0-100)

| Score | Régimen | Implicación |
|-------|---------|-------------|
| 80-100 | extreme_bullish | Amplificar señales +20% tamaño |
| 70-79 | bullish | Sesgo long, condiciones favorables |
| 30-69 | neutral | Estrategias selectivas, tamaño normal |
| 20-29 | bearish | Reducir exposición, favorecer short/cash |
| 0-19 | extreme_bearish | Máxima cautela, mínima exposición |

## Cómo usar en el ciclo
El plugin inyecta `market_breadth_regime` en el contexto. Puedes usar esto en discipline plugins o en el razonamiento del LLM para escalar posiciones:
```
if market_breadth_regime == "extreme_bullish":
    position_scale = 1.2   # +20% en rallies con breadth sano
elif market_breadth_regime == "bearish":
    position_scale = 0.5   # -50% en mercados deteriorados
```

## Referencias académicas
McClellan, S. & McClellan, T. (1970). McClellan Oscillator — originalmente publicado en newsletter.
Zweig, M. (1986). *Winning on Wall Street*. Warner Books.
Murphy, J.J. (1999). *Technical Analysis of Financial Markets*. Capítulo 18: Breadth Indicators.
