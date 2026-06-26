#!/usr/bin/env bash
# OpenNeoTrader — bootstrap de configuración autónoma (modo paper por default).
# Deja el sistema operando solo: credenciales + plugins + ciclo + ejecución + scheduler.
# Uso:
#   API_URL=http://localhost:8080 ADMIN_USER=admin ADMIN_PASS=secreto \
#   LLM_API_KEY=sk-or-v1-... [ALPACA_KEY=PK... ALPACA_SECRET=...] \
#   [UNIVERSE=AAPL,MSFT,SPY,QQQ,NVDA] [CAPITAL=1000] [REAL=false] \
#   bash scripts/setup.sh
set -euo pipefail

API="${API_URL:?define API_URL (ej http://localhost:8080)}"
U="${ADMIN_USER:?define ADMIN_USER}"; P="${ADMIN_PASS:?define ADMIN_PASS}"
LLM_MODEL="${LLM_MODEL:-nvidia/nemotron-3-super-120b-a12b:free}"
LLM_BASE="${LLM_BASE:-https://openrouter.ai/api/v1}"
UNIVERSE="${UNIVERSE:-AAPL,MSFT,GOOGL,AMZN,NVDA,META,SPY,QQQ}"
CAPITAL="${CAPITAL:-1000}"; REAL="${REAL:-false}"; INTERVAL_MS="${INTERVAL_MS:-3600000}"

j(){ python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }
api(){ curl -sS -m30 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

echo "→ register/login admin"
curl -sS -m15 -XPOST "$API/api/auth/register" -H "Content-Type: application/json" -d "{\"username\":\"$U\",\"password\":\"$P\"}" >/dev/null 2>&1 || true
TOKEN=$(curl -sS -m15 -XPOST "$API/api/auth/login" -H "Content-Type: application/json" -d "{\"username\":\"$U\",\"password\":\"$P\"}" | j access_token)
[ -n "$TOKEN" ] || { echo "login falló"; exit 1; }

echo "→ credenciales LLM + broker"
api -XPOST "$API/api/credentials" -d "{\"env\":\"OPENAI_API_KEY\",\"value\":\"${LLM_API_KEY:-}\"}" >/dev/null
api -XPOST "$API/api/credentials" -d "{\"env\":\"OPENAI_BASE_URL\",\"value\":\"$LLM_BASE\"}" >/dev/null
api -XPOST "$API/api/credentials" -d "{\"env\":\"LLM_BACKEND\",\"value\":\"openai\"}" >/dev/null
api -XPOST "$API/api/credentials" -d "{\"env\":\"LLM_MODEL\",\"value\":\"$LLM_MODEL\"}" >/dev/null
[ -n "${ALPACA_KEY:-}" ] && api -XPOST "$API/api/credentials" -d "{\"env\":\"ALPACA_API_KEY_ID\",\"value\":\"$ALPACA_KEY\"}" >/dev/null || true
[ -n "${ALPACA_SECRET:-}" ] && api -XPOST "$API/api/credentials" -d "{\"env\":\"ALPACA_API_SECRET_KEY\",\"value\":\"$ALPACA_SECRET\"}" >/dev/null || true

echo "→ LLM backend"
api -XPATCH "$API/api/llm/config" -d "{\"backend\":\"openai\",\"model\":\"$LLM_MODEL\"}" >/dev/null

echo "→ activar plugins"
for p in yahoo-finance-provider alpaca-provider universe market-context risk-manager position-sizing trend-following mean-reversion decision; do
  api -XPOST "$API/api/plugins/$p/activate" >/dev/null 2>&1 || true
done

echo "→ config ciclo + ejecución"
UNI_JSON=$(python3 -c "import sys,json;print(json.dumps(sys.argv[1].split(',')))" "$UNIVERSE")
api -XPATCH "$API/api/cycle/config" -d "{\"universe\":$UNI_JSON,\"capital\":$CAPITAL,\"data_provider\":\"yahoo-finance-provider\"}" >/dev/null
EXEC="{\"autonomous\":true,\"max_position_pct\":0.1,\"max_open_positions\":10,\"max_drawdown_halt_pct\":25"
[ "$REAL" = "true" ] && EXEC="$EXEC,\"real\":true,\"broker_plugin_id\":\"alpaca-provider\",\"max_order_notional\":2000"
EXEC="$EXEC}"
api -XPATCH "$API/api/execution/config" -d "$EXEC" >/dev/null

echo "→ prender scheduler (intervalo ${INTERVAL_MS}ms)"
api -XPATCH "$API/api/scheduler/config" -d "{\"enabled\":true,\"override_interval_ms\":$INTERVAL_MS}" >/dev/null

echo "✅ Listo. Estado:"
api "$API/api/scheduler/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print('   scheduler enabled=%s next_run=%s real=%s'%(d.get('enabled'),d.get('next_run'),'$REAL'))"
echo "   Monitoreá: GET /api/trade-intents · GET /api/audit · GET /api/scheduler/status"
