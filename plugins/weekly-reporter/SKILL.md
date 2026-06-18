# Weekly/Monthly Reporter

Plugin de tipo `extra` que genera **resúmenes periódicos de rendimiento** y los envía vía Telegram.

## Métricas incluidas

| Métrica | Fórmula |
|---|---|
| P&L total | Σ(trade.pnl) |
| Win Rate | trades_ganadoras / total_trades |
| Sharpe Ratio | (E[r] / σ[r]) × √252 |
| Max Drawdown | max((peak - trough) / peak) |
| Profit Factor | Σ(ganancias) / Σ(pérdidas) |
| Top 5 señales | Ordenadas por P&L |

## Cuándo se ejecuta

- **Semanal**: el día configurado en `weekly_report_day` (por defecto: lunes)
- **Mensual**: el día del mes configurado en `monthly_report_day` (por defecto: día 1)

## Configuración

```toml
[config]
weekly_report_day   = "monday"
monthly_report_day  = 1
lookback_days       = 30
min_trades          = 5         # mínimo de trades para generar reporte
```

## Credenciales

```toml
[credentials]
TELEGRAM_BOT_TOKEN = ...
TELEGRAM_CHAT_ID   = ...
```

Sin credenciales, el reporte se genera pero no se envía (queda en `ctx.weekly_report`).

## Herramienta disponible

### `generate_and_send`
```json
{
  "trades": [{"symbol": "AAPL", "action": "sell", "pnl": 0.042, "ts": "2026-06-01"}],
  "equity_curve": [1.0, 1.01, 1.005, 1.042],
  "period": "weekly"
}
```
