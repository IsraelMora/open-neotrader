# NeuroTrader — Instalación y operación autónoma

Guía para dejar el sistema operando solo en **modo paper** (sin dinero real) en minutos.
Stack auto-contenido: `docker compose up` levanta API + panel + sandbox.

> ⚠️ **Expectativa de rentabilidad (honesta, con datos medidos):** esto es un marco de
> research/automatización, **no** una máquina de ingresos. En backtests rigurosos (con
> gestión de posición — flip en señal opuesta — y métricas correctas), las estrategias
> incluidas sobre activos líquidos rinden aprox **3–8% CAGR con alpha NEGATIVO** (rinden
> MENOS que comprar y aguantar un índice) y win-rate 35–45%. Ningún ajuste de parámetros
> revierte ese alpha negativo — es estructural de las estrategias técnicas retail.
> Para "ingresos pasivos" reales, un ETF de índice (SPY/QQQ) rinde más con menos riesgo.
> Usá esto para investigar/operar con disciplina, empezá SIEMPRE en paper, y no inviertas
> lo que no puedas perder. Verificá vos mismo con `POST /api/backtest` y `/backtest/walk-forward`.

## 1. Requisitos
- Docker + Docker Compose.
- Una API key de LLM (recomendado: [OpenRouter](https://openrouter.ai), tiene modelos **free**).
- (Opcional, para ejecutar órdenes) una cuenta **paper** de [Alpaca](https://alpaca.markets).

## 2. Instalar
```bash
git clone https://github.com/IsraelMora/open-neotrader && cd open-neotrader
cp .env.example .env
# Editá .env: poné JWT_SECRET (genéralo) y, si querés, la key del LLM.
docker compose up -d
```
El panel queda detrás del proxy; la API en `/api`. Verificá: `curl http://localhost:8080/api/health`.

## 3. Configurar (todo por API — "configurá y listo")
Reemplazá `$T` por tu token de login.
```bash
# Crear admin + login
curl -s -XPOST .../api/auth/register -d '{"username":"admin","password":"<fuerte>"}'  # primera vez
T=$(curl -s -XPOST .../api/auth/login -d '{"username":"admin","password":"<fuerte>"}' | jq -r .access_token)

# 1) Credenciales (LLM + broker) — persisten en el volumen
curl -s -XPOST .../api/credentials -H "Authorization: Bearer $T" -d '{"env":"OPENAI_API_KEY","value":"sk-or-v1-..."}'
curl -s -XPOST .../api/credentials -H "Authorization: Bearer $T" -d '{"env":"ALPACA_API_KEY_ID","value":"PK..."}'
curl -s -XPOST .../api/credentials -H "Authorization: Bearer $T" -d '{"env":"ALPACA_API_SECRET_KEY","value":"..."}'

# 2) LLM (modelo free con tool-calling)
curl -s -XPATCH .../api/llm/config -H "Authorization: Bearer $T" -d '{"backend":"openai","model":"nvidia/nemotron-3-super-120b-a12b:free"}'

# 3) Activar plugins (estrategias + riesgo + datos + decisión)
for p in yahoo-finance-provider alpaca-provider universe market-context risk-manager position-sizing trend-following mean-reversion decision; do
  curl -s -XPOST .../api/plugins/$p/activate -H "Authorization: Bearer $T"; done

# 4) Config del ciclo (universo, capital) y de ejecución (paper por default)
curl -s -XPATCH .../api/cycle/config      -H "Authorization: Bearer $T" -d '{"universe":["AAPL","MSFT","SPY","QQQ","NVDA"],"capital":1000}'
curl -s -XPATCH .../api/execution/config  -H "Authorization: Bearer $T" -d '{"autonomous":true,"max_position_pct":0.1,"max_drawdown_halt_pct":25}'
# Para ejecutar en Alpaca paper: agregá  "real":true,"broker_plugin_id":"alpaca-provider","max_order_notional":2000

# 5) Prender el scheduler → opera solo
curl -s -XPATCH .../api/scheduler/config -H "Authorization: Bearer $T" -d '{"enabled":true,"override_interval_ms":3600000}'
```

## 4. Operar y monitorear
- `GET /api/scheduler/status` — estado del loop + circuit breaker.
- `GET /api/trade-intents` — decisiones del agente (pending/executed/rejected).
- `GET /api/audit` — señales, decisiones y errores por ciclo.
- Backtest de una estrategia: `POST /api/backtest {strategy, symbols, capital, provider_id:"yahoo-finance-provider"}`.

## 5. Pasar a dinero real (deliberado)
Solo después de validar en paper. Poné las keys reales del broker y `execution.real=true`.
**Riesgo:** la ejecución autónoma con fondos reales puede perder capital; usá `max_order_notional`
y `max_drawdown_halt_pct` conservadores y empezá con poco.
