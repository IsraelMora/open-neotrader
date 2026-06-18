# Relative Strength vs Index

## Descripción
Indicador de fuerza relativa de Levy (1968) popularizado por William O'Neil en el sistema CANSLIM. Mide el rendimiento de un activo comparado con su benchmark en múltiples horizontes temporales ponderados. Los activos con RS > 1.0 tienden a continuar outperformando.

## Fundamento matemático (Jegadeesh & Titman, 1993)
Las carteras de acciones con los mejores retornos en los últimos 3-12 meses continúan outperformando a las peores en los siguientes 3-12 meses. El efecto momentum es robusto y persiste en:
- Acciones US (Jegadeesh & Titman, 1993)
- Mercados internacionales (Rouwenhorst, 1998)
- Criptomonedas (Liu et al., 2022)

## Cálculo del RS compuesto (estilo IBD)

| Período | Peso | Justificación |
|---------|------|--------------|
| 3 meses (63d) | 40% | Mayor peso al momentum reciente |
| 6 meses (126d) | 20% | Tendencia intermedia |
| 9 meses (189d) | 20% | Tendencia consolidada |
| 12 meses (252d) | 20% | Momentum anual de largo plazo |

**RS ratio** = (1 + retorno_activo) / (1 + retorno_benchmark)
- RS = 1.0 → igual al benchmark
- RS = 1.10 → outperforma un 10%
- RS = 0.90 → underperforma un 10%

## Señal de compra
Se genera cuando:
1. RS compuesto ponderado ≥ `rs_threshold` (default: 1.05)
2. Activo en el percentil ≥ `top_percentile` (default: 80%) del universo

**Win rate histórico**: ~62% en mercados alcistas, ~44% en bajistas

## Uso estratégico

### Selección de acciones (estilo IBD)
- RS ≥ 80 (percentil) es el criterio de O'Neil para "leading stocks"
- En mercados alcistas, comprar solo activos con RS > 85th percentile
- En mercados bajistas, usar RS para vender primero los más débiles

### Rotación de activos (Meb Faber GTAA)
- Cada mes, comprar los activos con mayor RS relativo al universo
- Rebalancear el top-N del ranking (configurable)

### Factor de calidad
- Combinar RS con momentum de beneficios (PEAD plugin) mejora el win rate
- RS alto + fundamental sólido = CANSLIM completo

## Proceso de ranking
1. Calcular RS compuesto de todo el universo
2. Ordenar de mayor a menor
3. Señal long solo para top percentile (reducir exposición a underperformers)

## Integración con otros plugins
- `sector-rotation`: usa RS para rotar entre sectores/ETFs
- `momentum-factor-12-1`: RS es la versión individual del momentum factor
- `signal-aggregator`: peso alto porque RS tiene base académica robusta
- `universe-etf-thematic`: RS para seleccionar los mejores ETFs temáticos

## Parámetros configurables
- `periods` (default: [63, 126, 189, 252])
- `weights` (default: [0.4, 0.2, 0.2, 0.2])
- `benchmark` (default: "SPY")
- `rs_threshold` (default: 1.05)
- `top_percentile` (default: 80)
