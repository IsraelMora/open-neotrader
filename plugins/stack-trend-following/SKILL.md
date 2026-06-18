# Stack: Trend Following

## Descripción
Stack de seguimiento de tendencia que combina 5 plugins independientes y genera una señal de consenso. Reduce falsos positivos requiriendo acuerdo entre múltiples sistemas con enfoques diferentes.

## Componentes del stack

| Plugin | Tipo | Enfoque | Win rate individual |
|--------|------|---------|-------------------|
| `macd-signal` | Momentum | Cruce de EMAs + divergencias | ~54% |
| `ema-crossover-9-21` | Tendencia | Cruce de medias móviles | ~52% |
| `ichimoku-cloud` | Completo | Nube + TK cross + Chikou | ~58% |
| `momentum-factor-12-1` | Factor | Jegadeesh-Titman 12-1 month | ~60% |
| `volatility-regime` | Filtro | VIX + RV percentil | N/A (filtro) |

## Lógica de consenso

```
señales_alcistas = count(plugins que emiten "long")
señales_bajistas = count(plugins que emiten "short")

if señales_alcistas >= required_consensus (3):
    acción = "long" con fuerza = señales_alcistas / 5
elif señales_bajistas >= required_consensus:
    acción = "short" con fuerza = señales_bajistas / 5
else:
    acción = "hold"
```

### Mejora estadística por consenso
- 1 de 5 señalando: win rate base (~52%)
- 3 de 5 de acuerdo: win rate ~62% (reducción de falsos positivos)
- 4 de 5 de acuerdo: win rate ~68% (señales menos frecuentes pero más fiables)
- 5 de 5 de acuerdo: win rate ~74% (señales raras pero de alta convicción)

## Veto por volatilidad
Si `veto_on_high_vix=true` y `volatility-regime` detecta VIX > 30:
- Stack entra en modo defensivo
- Solo permite señales "exit" (cierre de posiciones)
- No abre nuevas posiciones hasta que el VIX baje de 25

## Exit de emergencia
Si `exit_on_reverse_consensus = 2` y ≥2 plugins señalan dirección opuesta a posición abierta:
- Señal de salida inmediata sin esperar consenso completo
- Reduce drawdown en reversiones rápidas

## Cuándo funciona mejor
- Mercados con tendencias sostenidas (>6 semanas)
- Activos con liquidez suficiente para spreads pequeños
- Condiciones macro estables (sin FOMC cercano)

## Cuándo falla
- Mercados laterales de alta frecuencia (whipsaw)
- Eventos binarios inesperados (earnings, noticias)
- Baja liquidez (crypto small-cap)

## Integración con otros plugins
- `portfolio-risk-manager`: el stack respeta los límites de exposición globales
- `macro-calendar-guard`: suprime señales del stack antes de eventos de alto impacto
- `signal-aggregator`: el stack puede ser un "super-plugin" con peso 2.0x
- `paper-trading`: simular el stack antes de activar en live

## Parámetros configurables
- `required_consensus` (default: 3/5)
- `min_signal_strength` (default: 0.6)
- `veto_on_high_vix` (default: true)
- `exit_on_reverse_consensus` (default: 2)
