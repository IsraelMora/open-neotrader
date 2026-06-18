# Dollar Cost Averaging (DCA)

## Descripción
Disciplina de inversión periódica de importe fijo independiente del precio de mercado. Matemáticamente superior al "lump sum" en mercados volátiles para reducir el coste medio de adquisición.

## Fundamento matemático
**Vanguard (2012)**: en mercados con tendencia alcista a largo plazo, DCA reduce el coste medio de adquisición porque:

Sea P₁, P₂, ..., Pₙ los precios en n ciclos e I el importe fijo:
- Shares compradas = I/P₁ + I/P₂ + ... + I/Pₙ
- Coste medio DCA = n·I / Σ(I/Pᵢ) = n / Σ(1/Pᵢ) = **media armónica de precios**

La **media armónica siempre es menor o igual a la media aritmética** (desigualdad AM-HM):
- HM(P) ≤ AM(P)
- Esto significa que el DCA siempre compra a un precio medio MEJOR que el precio medio de mercado

## Ventaja en mercados volátiles
En mayor volatilidad, la diferencia HM < AM se amplía:
- Volatilidad 0%: DCA = comprar todo al mismo precio
- Volatilidad 20%: DCA reduce coste medio ~2-4%
- Volatilidad 40%: DCA reduce coste medio ~8-12%

## Modo Volatility Boost
Cuando `volatility_boost=true`, se duplica el importe en caídas >5%:
- Aumenta la ventaja matemática comprando más en los mínimos
- Históricamente S&P500: caídas >5% recuperadas en promedio en 47 días
- Win rate de comprar en caídas >5%: ~78% a 6 meses

## Aplicación en este plugin
- El plugin no genera señales basadas en análisis técnico
- Genera órdenes `long` periódicas de importe fijo para activos del universo activo
- Estado persistente en `data/dca_state.json` (posición acumulada, coste medio, último ciclo)
- Compatible con paper-trading para simulación

## Cuándo usar DCA
**Ideal para:**
- Activos con sesgo alcista a largo plazo (índices, BTC, ETF de calidad)
- Inversores con flujo de caja regular (salario mensual)
- Mercados con alta volatilidad (crypto)

**No recomendado para:**
- Activos en tendencia bajista estructural
- Posiciones a corto plazo (<3 meses)
- Shorting (no aplica matemáticamente)

## Integración con otros plugins
- `paper-trading`: el modo paper simula todas las compras DCA sin riesgo real
- `portfolio-risk-manager`: limita la exposición total del DCA a un porcentaje del portafolio
- `signal-aggregator`: las señales DCA tienen peso fijo 0.7 (no competitivo con señales técnicas)
- `macro-calendar-guard`: opcionalmente pausar DCA durante eventos de alto impacto

## Parámetros configurables
- `amount_per_cycle` (default: 100.0 USD)
- `frequency_days` (default: 7 — semanal)
- `max_positions` (default: 5 — activos máximos en DCA simultáneo)
- `min_dip_pct` (default: 0.0 — 0 = comprar siempre, 5.0 = solo en caídas ≥5%)
- `volatility_boost` (default: false)
- `volatility_multiplier` (default: 2.0)
