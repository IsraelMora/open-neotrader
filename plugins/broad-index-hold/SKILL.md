# Broad Index Hold

## Descripción
Skill pasiva de comprar-y-mantener, sin ranking ni filtros. Emite una señal `long` para cada símbolo configurado (default `SPY`) la primera vez que no está en cartera. No rebalancea, no vende, no filtra. Es el "libro base" sobre el que actúan las estrategias de exposición manejada por volatilidad.

## Para qué existe
El valor NO está en qué comprar (es simplemente el índice amplio), sino en **cuánta exposición mantener a lo largo del tiempo**. Esa lógica vive enteramente en `risk-manager` con `exposure_mode="vol_target"`, que emite un `exposure_scalar` que escala la exposición total según la volatilidad reciente del mercado (efecto Moreira-Muir, 2017: bajar exposición antes de que la volatilidad explote → menor drawdown → mejor Sharpe).

Separar responsabilidades así (este plugin = qué mantener; risk-manager = cuánto) mantiene el diseño limpio: el "libro" es trivial y auditable, y toda la inteligencia de riesgo queda en un solo lugar.

## Fundamento (Moreira & Muir, 2017 — "Volatility-Managed Portfolios")
Escalar la exposición inversamente a la volatilidad realizada reciente mejora el retorno ajustado por riesgo frente a comprar-y-mantener. La volatilidad es persistente y tiende a agruparse antes de las caídas, por lo que reducir exposición cuando la vol sube evita los peores días. Validado en este proyecto: vol-managed SPY (target 12%, ventana 20d, sin apalancamiento) → Sharpe 0.95 vs 0.78 del SPY buy-and-hold, con la mitad del max drawdown, sobre el ciclo 2019-2026.

## Configuración
| Clave | Default | Descripción |
|-------|---------|-------------|
| `symbols` | `"SPY"` | Lista separada por comas a mantener. `"SPY"` reproduce el resultado del research; `"SPY,QQQ,IWM"` da una canasta equiponderada de índice amplio. |

## Señal
Para cada símbolo de `symbols` que NO esté ya en cartera, emite una señal `long`. Nada más. Sin lookahead (no lee series de precio). El tamaño real de la posición lo determina la política de fill de la cartera multiplicada por el `exposure_scalar` del risk-manager.
