# Ensemble Signal Voting + Vol-Targeting

## Resumen

Plugin de tipo `skill` que combina **12 variantes de señal** en una votación consolidada, escala la posición por volatilidad y genera `pending_signals` listos para el `risk-envelope`.

## Base matemática

| Componente | Referencia |
|---|---|
| EMA Cross (× 4 lookbacks) | Elder (1993) *Trading for a Living* |
| Donchian Channel Breakout (× 4) | Richard Donchian (1970s), Turtle Traders |
| Time-Series Momentum (× 4) | Moskowitz, Ooi & Pedersen (2012) *JFE* |
| Vol-Targeting | AQR Capital Management (2012) |

## Configuración (manifest.toml)

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `lookbacks` | `[20, 60, 120, 250]` | Horizontes: 1m, 3m, 6m, 12m |
| `vol_target_annual` | `0.10` | Objetivo de volatilidad anual (10%) |
| `vol_lookback` | `21` | Días para calcular vol. realizada |
| `min_votes` | `7` | Mínimo de votos coincidentes para señal (de 12) |
| `use_ema` | `true` | Habilitar señales EMA Cross |
| `use_donchian` | `true` | Habilitar señales Donchian |
| `use_tsmom` | `true` | Habilitar señales TSMOM |

## Lógica de votación

```
Para cada lookback L ∈ {20, 60, 120, 250}:
  EMA Cross:    precio[-1] > EMA(L) → +1   |   < EMA(L) → -1
  Donchian:     precio[-1] > max(L) → +1   |   < min(L) → -1
  TSMOM:        ret(L días) > 0.1% → +1    |   < -0.1%  → -1

Señal ensemble:
  if votes_long  >= min_votes: signal = +1 (LONG)
  if votes_short >= min_votes: signal = -1 (SHORT)
  else:                        signal =  0 (NEUTRAL)

Conviction = |votes_long - votes_short| / 12
```

## Vol-Targeting

```
vol_realizada = std(log_retornos[21d]) × √252

position_scale = min(vol_target / vol_realizada, 2.0)
```

El `position_scale` se pasa junto con la señal al `risk-envelope`, que lo usa para ajustar el tamaño final de posición.

## Integración con el ciclo

1. El hook `hooks/cycle.py` lee `price_data` del contexto.
2. Calcula el ensemble para cada símbolo.
3. Escribe `ensemble_signals` (detalle) y `pending_signals` (para el risk-envelope).
4. El `risk-envelope` aplica las 5 reglas de control y emite las señales finales.

## Herramienta disponible

### `analyze_ensemble`
```json
{
  "symbol": "AAPL",
  "prices": [150.0, 151.2, ...],
  "config": { "min_votes": 8 }
}
```

**Respuesta:**
```json
{
  "symbol": "AAPL",
  "signal": 1,
  "votes_long": 9,
  "votes_short": 1,
  "votes_neutral": 2,
  "total_variants": 12,
  "conviction": 0.667,
  "vol_annual": 0.182,
  "position_scale": 0.549,
  "variants": [
    { "type": "ema", "lookback": 20, "signal": 1 },
    ...
  ]
}
```

## Limitaciones conocidas

- Requiere datos OHLC diarios (al menos `max(lookbacks) + 2` puntos = 252 días).
- No aplica filtros de liquidez ni spreads (responsabilidad del proveedor de datos).
- El `position_scale` está cappado en 2× para evitar apalancamiento excesivo.
- Señales no contempladas para posiciones cortas si `risk-envelope.allow_shorts = false`.
