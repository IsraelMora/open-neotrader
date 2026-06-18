# Risk Envelope (AI-First)

Plugin de disciplina que actúa como firewall matemático inviolable entre las propuestas de la IA y la ejecución real. **La IA propone, el envelope dispone.**

## Principio fundamental

La IA puede cometer errores: proponer posiciones oversized, ignorar correlaciones, o alucinar trades. El Risk Envelope intercepta TODAS las propuestas antes de ejecutarlas y aplica frenos duros configurados por el usuario.

```
LLM propone trades → Risk Envelope → trades aprobados/reescalados/vetados → Ejecución
```

## Reglas (en orden de aplicación)

1. **Cortos prohibidos** (si `allow_shorts=false`): Ningún `short` o `sell_short` pasa
2. **Tamaño por trade** (≤ `max_single_trade_pct`): Un solo trade no puede superar el X% del portafolio
3. **Límite por activo** (≤ `max_position_pct`): La posición total en un símbolo no puede superar el 40% — reescala proporcional si supera
4. **Posiciones abiertas** (≤ `max_open_positions`): No se abren nuevas posiciones si ya hay 10 activas
5. **Exposición total** (≤ `max_total_exposure`): La exposición total nunca supera el 95% — reescala proporcional

## Configuración

```toml
[config]
max_position_pct     = 0.40   # 40% máximo por activo
max_total_exposure   = 0.95   # 95% exposición máxima total
allow_shorts         = false  # cortos desactivados
max_single_trade_pct = 0.10   # 10% máximo por trade individual
max_open_positions   = 10     # 10 posiciones máximo
```

## Output de ejemplo

```json
{
  "approved": 3,
  "vetoed": 1,
  "rescaled": 1,
  "summary": "3 aprobadas (1 reescalada), 1 vetada de 4 propuestas",
  "proposals": [
    { "approved": true, "adjusted_qty": 45.2, "adjusted_notional": 4520.0 },
    { "approved": false, "veto_reason": "Cortos prohibidos (allow_shorts=false)" }
  ]
}
```

## Cuándo usar

**SIEMPRE** — antes de cualquier ejecución real. Este plugin es la última línea de defensa. La secuencia recomendada:

1. Ejecutar skills de señales (MACD, RSI, etc.)
2. Agregar señales (Signal Aggregator)
3. **Aplicar Risk Envelope** — veta/reescala propuestas
4. Ejecutar trades aprobados
5. Registrar en auditoría

## Diferencia con Portfolio Risk Manager

| Plugin | Rol |
|--------|-----|
| `portfolio-risk-manager` | Monitorea el portafolio existente, emite alertas |
| `risk-envelope` | **Intercepta proposals antes de ejecución**, aplica veto duro |

Úsalos juntos: Risk Manager para monitoreo continuo, Risk Envelope para gate de ejecución.
