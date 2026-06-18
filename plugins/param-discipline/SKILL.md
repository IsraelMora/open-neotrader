# Param Discipline — Journal y Lock de Parámetros

Plugin de tipo `discipline` que implementa **gobernanza de parámetros** para evitar el overfitting accidental.

## Problema que resuelve

El optimizador de parámetros más peligroso es el humano que ajusta parámetros hasta que el backtest mejora. Este plugin impone un flujo estructurado:

```
hipótesis → journal_entry → cambio → lock(N ciclos) → validación
```

## Flujo de uso

1. **Antes de cambiar un parámetro**, el LLM debe llamar `journal_entry`:
   - Documentar el estado anterior y el nuevo
   - Escribir una razón concreta
   - Escribir una **hipótesis testeable** (≥50 chars): *"Reducir el lookback de 60 a 20 días debería capturar mejor la volatilidad intraday en cripto porque..."*

2. El plugin activa un **lock de N ciclos** (por defecto 3) durante los que no se puede cambiar ese parámetro de nuevo.

3. El LLM puede llamar `check_lock` para saber si puede proponer un cambio.

## Configuración

```toml
[config]
lock_after_change_cycles = 3      # ciclos de espera entre cambios
require_hypothesis       = true
min_hypothesis_length    = 50
max_changes_per_week     = 5
```

## Herramientas disponibles

### `journal_entry` — Registrar cambio
```json
{
  "plugin_id": "rsi-mean-reversion",
  "params_before": { "rsi_oversold": 30 },
  "params_after":  { "rsi_oversold": 25 },
  "reason": "Mercado más volátil; los niveles estándar generan pocas señales",
  "hypothesis": "Bajar el umbral de oversold a 25 debería aumentar la frecuencia de señales en cripto sin degradar el win rate porque el RSI tarda más en recuperarse en activos con alta volatilidad.",
  "cycle_id": "abc-123"
}
```

### `check_lock` — Verificar lock
```json
{ "plugin_id": "rsi-mean-reversion" }
```

### `get_journal` — Ver historial
```json
{ "plugin_id": "rsi-mean-reversion" }
```
