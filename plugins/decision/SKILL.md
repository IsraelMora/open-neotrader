# Decision — herramienta de acción del orquestador

Este plugin es la **superficie de acción** del LLM. Después de leer el contexto
(noticias/eventos) y las **señales** que los plugins pasivos emitieron en el ciclo,
el orquestador expresa **una** decisión llamando a `emit_trade_intent`.

## Cuándo usarlo

- Una vez por decisión, al final de tu razonamiento del ciclo.
- Sobre un símbolo que esté en el universo activo y respaldado por las señales/contexto.

## Contrato

`emit_trade_intent(symbol, action, confidence, rationale, timeframe="1d")`

- `symbol`: ticker, ej. `AAPL`.
- `action`: `long` | `short` | `exit` | `hold`.
- `confidence`: número en `[0, 1]`.
- `rationale`: por qué tomás la decisión, anclado en el contexto/señales.
- `timeframe` (opcional): horizonte, ej. `1d`.

Devuelve `{ ok: true, result: { ...intención normalizada, status: "recorded" } }`
o `{ ok: false, error: "..." }` si la validación falla.

## Límites (por diseño del kernel)

- **No recibís precios.** El LLM nunca ve series de precio; decidís sobre texto y
  señales. Si pasás campos de precio, se ignoran.
- **No ejecuta órdenes.** Registra la intención; la auditoría y la memoria del
  kernel la capturan (los args llevan `symbol` + `action`). El **veto-gate** ya
  filtró, antes de esta llamada, qué señales viste.
- La ejecución real contra un broker, el veto post-decisión y la aprobación
  humana (HITL) son una capa aparte que consumiría esta intención.
