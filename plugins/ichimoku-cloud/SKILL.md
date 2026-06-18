# Ichimoku Kinko Hyo

## Descripción
Sistema técnico completo creado por Goichi Hosoda (publicado en 1969). "Ichimoku" significa "a primera vista" — el sistema proporciona niveles de soporte/resistencia, dirección de tendencia y momentum en un solo gráfico. Especialmente popular en Japón, criptomonedas y forex.

## Los 5 componentes

| Componente | Fórmula | Significado |
|-----------|---------|-------------|
| **Tenkan-sen** (9 periodos) | (max_9 + min_9) / 2 | Tendencia a corto plazo (=conversion line) |
| **Kijun-sen** (26 periodos) | (max_26 + min_26) / 2 | Tendencia media / soporte-resistencia principal |
| **Senkou Span A** | (Tenkan + Kijun) / 2 → +26 | Borde 1 de la nube (desplazado al futuro) |
| **Senkou Span B** | (max_52 + min_52) / 2 → +26 | Borde 2 de la nube (desplazado al futuro) |
| **Chikou Span** | Precio actual → -26 | Confirmación lagging (precio vs precio hace 26 barras) |

## La Nube (Kumo)

- **Nube verde** (Span A > Span B): zona de soporte alcista
- **Nube roja** (Span B > Span A): zona de resistencia bajista
- **Precio sobre la nube**: tendencia alcista
- **Precio bajo la nube**: tendencia bajista
- **Precio dentro de la nube**: consolidación/indecisión

## Señales de alta probabilidad

### Sistema de puntuación (hasta 5 puntos)
1. +2 precio sobre/bajo nube (confirmación principal)
2. +1 Tenkan > Kijun (cruce TK)
3. +1 cruce TK ocurrido recientemente
4. +1 Chikou confirma dirección
5. +0.5 color de nube alineado

**Long**: ≥3.5 puntos + precio sobre nube + chikou alcista
**Short**: ≥3.5 puntos + precio bajo nube + chikou bajista

### Win rates reportados
- Con 3/5 confirmaciones: ~52%
- Con 4/5 confirmaciones: ~58%
- Con 5/5 confirmaciones: ~64% (señales menos frecuentes)

## Mejores mercados para Ichimoku
- **Crypto 24/7**: excelente porque no hay gaps entre sesiones
- **Forex**: muy usado institucionalmente, funciona bien en pares mayores
- **Acciones**: funciona, pero gaps de apertura afectan al Kijun

## Configuración recomendada

| Mercado | Tenkan | Kijun | Senkou B |
|---------|--------|-------|----------|
| Estándar | 9 | 26 | 52 |
| Crypto (adaptado) | 20 | 60 | 120 |
| Swing trading | 7 | 22 | 44 |

## Integración con otros plugins
- Se combina bien con `volatility-regime` para filtrar en alta volatilidad
- `stack-trend-following` usa Ichimoku como uno de sus 5 componentes
- `macro-calendar-guard` suprime señales antes de eventos macroeconómicos
- `atr-stop-loss`: stop lógico en el Kijun o borde inferior de la nube

## Parámetros configurables
- `tenkan_period` (default: 9)
- `kijun_period` (default: 26)
- `senkou_b_period` (default: 52)
- `require_cloud_confirmation` (default: true)
- `require_chikou_confirmation` (default: true)
