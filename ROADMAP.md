# NeuroTrader — Roadmap

> Local & Secure First · Plugin-driven · Community-grown

---

## ✅ Completado

### Plataforma core
- [x] NestJS v11 + Fastify + Prisma + SQLite (mejor-sqlite3)
- [x] Auth: JWT + TOTP (2FA) + backup codes
- [x] Plugin system con manifest.toml (estándar unificado)
- [x] SKILL.md — instrucciones para el LLM (Anthropic Agent Skills standard)
- [x] tools.json — funciones Python llamables por el LLM
- [x] Bus de eventos tipado (plugin.activated, cycle.started, plugin.skill_updated, etc.)
- [x] SSE gateway — push en tiempo real al frontend sin polling
- [x] Rate limiting (@nestjs/throttler) — 120 req/min global, 10/min en auth
- [x] Correlation ID middleware — trazabilidad en logs
- [x] Health check endpoint (/api/health)
- [x] Graceful shutdown (SIGTERM/SIGINT)
- [x] Lifecycle hooks: on_activate, on_deactivate (via sandbox Python)
- [x] Cycle events: cycle.started → cycle.completed → cycle.failed (via SSE)
- [x] Prisma ORM + better-sqlite3 (mismo stack que trading-store)
- [x] Credenciales dinámicas desde manifest.toml (no hardcoded)
- [x] Config schema validado contra manifest.toml
- [x] Plugin scaffold: `node tools/create-plugin.mjs <nombre> --type <tipo>`
- [x] Closed learning loop: write_skill tool (LLM mejora sus propios SKILL.md)
- [x] Plugin types: skill | provider | discipline | universe | stack | extra
- [x] Multi-turn LLM con carga progresiva de skills (read_skill / read_skill_resource)
- [x] Plugin install via git clone (--depth 1) + git pull para updates
- [x] Sandbox Python sin acceso a red (execFile, no exec)
- [x] Swagger UI en /api/docs (solo desarrollo)
- [x] runner.py con run_hook (on_cycle/on_activate/on_deactivate) y emit_signal
- [x] SandboxGateway.runPluginCycleHook() para hooks individuales por plugin
- [x] **Plugin hot-reload** — PluginWatcherService con fs.watch; recarga SKILL.md y manifest.toml sin restart; emite plugin.skill_updated / plugin.manifest_updated
- [x] **Plugin tools API** — GET /plugins/tools (todos los tools de plugins activos) + GET /plugins/:id/tools (tools de un plugin)
- [x] **Config merge endpoint** — PATCH /plugins/:id/config fusiona config parcial sin borrar campos existentes
- [x] **getProviderTools expandido** — ahora carga tools.json de TODOS los tipos de plugin (antes solo provider/discipline); soporta campo `parameters` además de `input_schema`
- [x] **ProviderGateway /news** — GET /providers/:id/news → noticias normalizadas desde NewsAPI; soporta query, hours_back, limit
- [x] **OhlcvCacheService** — caché en memoria con TTL por timeframe (1m=1min, 1d=4h, etc.); evita martillar APIs; GET /providers/cache/stats; DELETE /providers/cache
- [x] **Yahoo Finance normalización** — parseo de estructura `chart.result[0]` con timestamps Unix y adjclose; normalización de quote via `meta.regularMarketPrice`

### Providers — Gateway de red
- [x] **ProviderGatewayService** — único punto de salida a internet para todos los plugins de tipo provider; cada plugin declara su API en manifest.toml [api]; no hay un servicio NestJS por provider
- [x] **Alpaca Provider** — manifest.toml con [api] declarativo (endpoints, auth headers, formato); hooks de validación de credenciales en sandbox
- [x] **Tiingo Provider** — alternativa gratuita a Yahoo Finance; misma arquitectura declarativa

### Seguridad
- [x] Secretos solo via .env (nunca en BD ni logs)
- [x] Sandbox Python sin shell interpolation (execFile + args array)
- [x] Sandbox sin acceso a internet (manifest.toml permissions.network = false)
- [x] CORS restringido por entorno
- [x] Helmet (security headers)
- [x] JWT guard global + TOTP guard
- [x] .env escrito con modo 0o600 (solo lectura del propietario)

### Scheduler
- [x] **Cycle scheduler** — plugin-aware: cada plugin declara su frecuencia en manifest.toml [scheduler]; el platform usa el intervalo más exigente entre activos; override manual disponible
- [x] Modos de scheduler: polling | reactive | none (por plugin)
- [x] Config de frecuencia editable desde la UI (campo scheduler_interval_ms en plugin config)

### Observabilidad
- [x] **Audit log persistente** — tabla AuditEntry en BD; GET /audit con filtros por event_type, plugin, fecha; exportación NDJSON vía GET /audit/export (hasta 10k entradas); GET /audit/stats; **DELETE /audit/prune?days=90** (retención configurable, requiere TOTP)
- [x] **Sandbox resource limits** — CPU, memoria, archivos; configurables via SANDBOX_CPU_SECONDS y SANDBOX_MEM_MB
- [x] **NAV Snapshot / Equity Curve** — `SnapshotService`; tabla NavSnapshot en BD; POST /snapshot (manual); GET /snapshot/history | /snapshot/latest | /snapshot/equity-curve | /snapshot/stats; datos de equity curve disponibles para plugins (weekly-reporter, walk-forward, etc.)
- [x] **Alert Engine (plugin-driven)** — `AlertsService` como repositorio puro; plugins emiten alertas via clave `emit_alerts` en contexto del ciclo; `AgentsService` las persiste automáticamente tras cada hook; GET /alerts | /alerts/active | /alerts/stats; POST /alerts/:id/resolve | /alerts/resolve-all; tipos: DRAWDOWN / FLASH_CRASH / CORRELATION_SPIKE / VOLUME_ANOMALY / MACRO_EVENT / CUSTOM
- [x] **Health Check enriquecido** — GET /health (público, mínimo para load balancers); GET /health/detailed (auth): uptime, memoria RSS/heap, active_plugins, pending_alerts, audit_entries, active_pretests, last_cycle_at + minutos_hace
- [x] **Circuit Breaker** — `CycleSchedulerService` rastrea fallos consecutivos del LLM; abre el breaker tras 3 fallos; pausa ciclos 5 min antes de half-open retry; GET /scheduler/circuit-breaker; POST /scheduler/circuit-breaker/reset

### Notificaciones
- [x] **Telegram Notifier** — plugin de tipo "extra"; implementado como NestJS service suscrito al bus de eventos; notifica ciclos, señales, errores

### Plugins — Skills
- [x] RSI Mean Reversion (Wilder RSI, oversold/overbought, divergencia)
- [x] Momentum Factor 12-1 (Jegadeesh & Titman 1993, trend filter, vol-scaling)
- [x] EMA Crossover 9/21 (trend following, ATR stop dinámico)
- [x] Bollinger Band Squeeze (TTM Squeeze, Keltner + BB, momentum regression)
- [x] Professional Trader Knowledge Base (psicología, riesgo, macro, checklist)
- [x] VWAP Reversion (2σ del VWAP → reversión; win rate ~62%)
- [x] Opening Range Breakout (primeros 15min; confirmación volumen; win rate ~55%)
- [x] Volatility Regime Detection (VIX + RV percentil, 4 regímenes, adapta estrategias)
- [x] Sector Rotation (Faber 2007 GTAA — 11 SPDRs, momentum 12m + MA 10m)
- [x] **Mean Reversion Z-Score** — Jegadeesh (1990); |Z|>2σ → reversión; lookback configurable; señales long/short/exit
- [x] **Earnings Drift PEAD** — Ball & Brown (1968); post-earnings drift 30-60 días; sorpresa EPS + gap de precio; win rate ~70% en large_beat
- [x] **Pairs Trading** — Engle-Granger (1987); spread cointegrado; market-neutral; test ADF; señales long/short spread por Z-Score
- [x] **Carry Trade** — diferencial de tasas de interés forex; filtro momentum + VIX risk-off; AUD/JPY, NZD/JPY, USD/MXN

### Plugins — Disciplines
- [x] Kelly Criterion (tamaño óptimo de posición + historial de trades)
- [x] ATR Stop Loss (stop inicial + trailing stop dinámico)
- [x] Max Drawdown Circuit Breaker (3 niveles: warning/danger/breaker, pérdida diaria, recovery)
- [x] Correlation Guard (cancela señales con correlación > 0.7 con posiciones abiertas)
- [x] **Position Sizing Pyramid** — Van Tharp; entrada en tranches; añade a ganadoras; coste medio nunca supera el de entrada
- [x] **Portfolio Risk Manager** — límites globales de cartera: exposición total, concentración por activo, nº de posiciones, liquidez mínima; actúa como último filtro antes de ejecución
- [x] **Signal Aggregator** — votación ponderada multi-skill; consensus signal; pass-through para señales de pairs/pead/pyramid

### Plugins — Universes
- [x] S&P 500 (500 components, filtros liquidez/cap)
- [x] Crypto Top 50 (excluye stablecoins, configurable)
- [x] **Nasdaq-100** — 100 activos; sesgo tech/growth; incluye ETF QQQ como referencia
- [x] **Forex Majors** — 7 pares principales + cruces opcionales; formato configurable (slash/nodash/underscore)
- [x] **Crypto DeFi Top 20** — 20 tokens DeFi (DEX, lending, derivados, liquid staking, yield agg); sin BTC/ETH

---

## 📋 Pendiente — Plataforma

### Alta prioridad
- [x] **Plugin Dependency Resolution** — `activate()` lee campo `requires = [...]` del manifest.toml de cualquier plugin; falla con mensaje claro si las dependencias no están activas; `deactivate()` bloquea si otros plugins activos dependen de él; stacks siguen usando `stack.requires` como siempre
- [x] **Startup Migration Runner** — `MigrationRunnerService`; aplica migraciones SQL pendientes de `prisma/migrations/` al arrancar; tabla `_migration_history` para rastrear; transaccional; elimina necesidad de `prisma migrate deploy`
- [x] **Pretest de Carteras** — `PretestModule`; permite crear N portfolios virtuales independientes con distintos sets de plugins y configuraciones; ejecutar ciclos de agente en modo virtual (sin órdenes reales); comparativa de rendimiento entre portfolios vía GET /pretest/compare; POST /pretest/run-all ejecuta todos en paralelo; reset individual; tabla `pretest_portfolios` en BD
- [x] **WebSocket bidireccional** — `@WebSocketGateway` con `@nestjs/platform-ws`; puerto `WS_PORT` (default 3001); auth JWT via query `?token=`; mensajes: `agent:message` → `agent:response`; push de todos los eventos de la plataforma a clientes conectados
- [x] **Portfolio/Posiciones en ProviderGateway** — `getPortfolio(pluginId)` normaliza equity/cash/buying_power/positions para Alpaca (Futures) y Binance; `GET /providers/:id/portfolio`; manifests Alpaca y Binance actualizados con endpoints `portfolio` y `positions`
- [ ] **Providers reactivos** — modo `scheduler.mode="reactive"` con WebSocket al exchange; no polling
- [ ] **Prisma migrations** — gestión de schema en producción (actualmente solo push)
- [x] **Backup/restore** — AES-256-GCM + PBKDF2 (210k iters); incluye BD + .env cifrados; POST /backup/create | /backup/restore | GET /backup

### Media prioridad
- [x] **Plugin registry** — `GET/POST /registry` consume catálogo de la tienda (`apps/store`); install via `git clone` del repositorio declarado en `[plugin].repository`
- [ ] **Plugin signature verification** — GPG signing para plugins externos
- [x] **Monousuario enforced** — `UsersService.create()` rechaza si ya existe un usuario; `GET /users/me` devuelve perfil del usuario activo; diseño local-first sin multiusuario
- [x] **Onboarding flow** — `GET /onboarding/status` (público); `POST /onboarding/admin` crea primer admin sin auth; 4 pasos: create_admin / configure_llm / install_plugin / setup_2fa; auto-complete cuando todos los pasos requeridos están hechos

### Baja prioridad
- [ ] **OpenTelemetry** — métricas y trazas distribuidas
- [x] **Plugin CI/CD** — GitHub Actions template para testear plugins (`.github/workflows/plugin-ci.yml`; validación manifest + sintaxis Python + smoke tests + security scan; fix inyección de comandos con env vars)
- [x] **KvService** — servicio de persistencia key-value sobre `ConfigEntry` (Prisma); desacopla el scheduler del `StoreService` del marketplace
- [x] **neurotrader-store en monorepo** — `apps/store` (antes proyecto independiente); servicio de negocio privado; `StoreService` apunta a `https://store.neurotrader.app` por defecto
- [x] **Multi-LLM** — Anthropic (tool use + learning loop) + OpenAI + Gemini + **Custom OpenAI-compatible** (el usuario añade su propio provider con name/base_url/api_key_env/model); GET /llm/providers; POST /llm/providers; DELETE /llm/providers/:id; PATCH /llm/config
- [x] **Plugin versioning** — semver X.Y.Z requerido; `install()` valida formato + major version mismatch; `update()` aborta si major cambia; `min_platform_version` en manifest bloquea si la plataforma es antigua; PLATFORM_VERSION=1.0.0

---

## 📋 Pendiente — Plugins

### Providers
- [x] **Binance** (crypto, testnet/live) — manifest.toml declarativo; normalización klines; HMAC SHA256 para órdenes
- [x] **Tiingo** — datos OHLCV diarios/intraday + quotes; formato query_param; fallback gratuito
- [x] **CCXT universal** — manifest.toml con format="ccxt"; 200+ exchanges; hooks de validación; configurable por exchange
- [x] **Yahoo Finance fallback** — API no oficial; sin API key; normalización chart/result Yahoo; ajustado por dividendos; marcado como fallback_only
- [ ] **Interactive Brokers** (institucional)

### Skills
- [x] **Funding Rate Arbitrage** — plugin `funding-rate-arb` tipo skill; arbitraje delta-neutral long spot / short perp; detecta APR ≥20%; clasifica calidad: excellent/good/marginal; 15-40% APR histórico en BTC; sin exposición direccional al precio
- [x] **Ensemble Signal Voting + Vol-Targeting** — plugin `ensemble-signal-voting` tipo skill; 12 variantes (EMA+Donchian+TSMOM × 4 lookbacks); votación mayoría; position_scale por vol-targeting
- [x] **Ornstein-Uhlenbeck Mean Reversion** — plugin `ornstein-uhlenbeck` tipo skill; estima θ/μ/σ por OLS (modelo Vasicek discreto); Z-score con σ estacionaria; half-life bounds; R² mínimo; superior al Z-score simple
- [x] **Kalman Filter Trend Following** — plugin `kalman-filter` tipo skill; filtro óptimo MMSE; ganancia K adaptativa por Q/R; señal en dirección de tendencia con threshold; superior al EMA
- [x] **MACD Signal** — cruce EMA 12/26/9 + detección de divergencias precio/histograma; win rate ~54% en tendencias; configurable fast/slow/signal; require_crossover mode
- [x] **Ichimoku Cloud** — sistema completo Tenkan/Kijun/Senkou A-B/Chikou; puntuación multi-confirmación (hasta 5/5); veto fuera de nube; win rate ~58% con 4/5 confirmaciones
- [x] **Relative Strength vs Index** — Levy (1968)/O'Neil CANSLIM; RS compuesto ponderado 4 períodos (3m 40%, 6m/9m/12m 20%); ranking percentil; win rate ~62% en mercados alcistas
- [x] **Sentiment Analysis** — NewsAPI + LLM evalúa titulares semánticamente; score compuesto -1 a +1; señal long/short con umbral configurable; fallback heurístico — NewsAPI + LLM evalúa titulares semánticamente; score compuesto -1 a +1; señal long/short con umbral configurable; fallback heurístico
- [x] **Gap Opening Strategy** — Toby Crabel; gap fade (>2% = mean reversion) + gap and go (<2% en tendencia); win rate 58-65%
- [x] **Volatility Rank (HV Percentile)** — proxy de IV Rank; percentil 0-100 de HV actual vs historia 1 año; señal sell_premium (>80%) o buy_premium (<20%)
- [x] **Macro Calendar Guard** — discipline: suprime/reduce señales en ventanas FOMC/CPI/NFP/ECB; calendario 2026 embebido; LLM puede inyectar eventos extra

### Disciplines
- [x] **Param Discipline** — plugin `param-discipline` tipo discipline; journal de cambios de parámetros con hipótesis testeable; lock de N ciclos tras cada cambio; `max_changes_per_week`; hook avanza contadores y expone `param_lock_status`
- [x] **Paper Trading** — portafolio virtual; simula señales con precios reales; PnL, win rate, profit factor; intercept_live mode; sin riesgo real
- [x] **Dollar Cost Averaging (DCA)** — importe fijo periódico; media armónica garantiza coste medio < precio medio (Vanguard 2012); volatility_boost ×2 en caídas >5%; estado persistente por posición

### Universes
- [x] **ETF Temáticos** — ARK, semis, ciberseguridad, clean energy, IA, biotech, cloud, fintech; configurable por categoría

### Stacks
- [x] **Stack Trend Following** — consenso de MACD + EMA Crossover + Ichimoku + Momentum Factor + Volatility Regime; 3/5 señales = acción; veto VIX > 30; exit en reversión ≥2 contra

### Extras
- [x] **Backtester** — motor ligero con numpy; señales históricas → Sharpe/drawdown/win rate/equity curve; sin deps externas
- [x] **Doctor** — diagnóstico al inicio del ciclo: archivos de plugins, credenciales, salud del contexto; `cycle_abort` si faltan credenciales críticas
- [x] **Weekly Reporter** — resúmenes periódicos P&L/Sharpe/maxDD/win-rate/profit-factor; envío vía Telegram; configurable por día de la semana/mes
- [x] **claude-subscription** — plugin `extra`; al activarlo (o con `LLM_BACKEND=subscription`) la plataforma usa `claude -p` con la sesión OAuth en vez de `ANTHROPIC_API_KEY`; `completeViaSubscription` ahora respeta `--model` y `--append-system-prompt`

---

## ⚠️ Gaps detectados vs trading-test (prototipo previo)

Revisión de `trading-test/` revela funcionalidades pendientes de migrar al sistema de plugins:

- [x] **Risk envelope (AI-first)** — plugin `risk-envelope` tipo discipline; 5 reglas en cadena: cortos prohibidos, max por trade, max por activo (reescala proporcional), max posiciones, exposición total máxima; `apply_risk_envelope` + `check_portfolio_health`
- [x] **Agent loop con auditoría/veto** — `AgentsService._executeCycle()`: skill hooks → discipline veto (por plugins, no hardcoded) → LLM con señales filtradas → ejecución → audit en cada fase; `VetoSummary` en resultado del ciclo
- [x] **Ensemble de señales + vol-targeting** — plugin `ensemble-signal-voting` tipo skill; 12 variantes (EMA+Donchian+TSMOM × 4 lookbacks); votación mayoría + vol-targeting (σ_real vs σ_objetivo); position_scale 0-2x; hook/cycle.py → pending_signals para risk-envelope
- [x] **Context Memory inter-ciclos** — `ContextMemoryModule`; almacena observaciones LLM, flags, señales históricas en KvService; `toContextString()` inyecta contexto al inicio de cada `runCycle()`; GET/POST/DELETE /context-memory
- [x] **Evidence audit JSON-L** — `AuditService.exportJsonL()` + GET /audit/export; stream NDJSON hasta 10k entradas; Content-Disposition para git-friendly download; GET /audit/stats
- [x] **Param discipline (journal + lock)** — plugin `param-discipline` tipo discipline; `journal_entry(hypothesis, params_before/after)` → lock N ciclos; `check_lock`; `max_changes_per_week`; hook/cycle.py avanza contadores y expone `param_lock_status` al contexto
- [x] **Doctor/diagnóstico** — plugin `doctor` tipo extra; `run_diagnostics`: verifica archivos de plugins, credenciales requeridas y salud del contexto; hook inyecta `doctor_report` al inicio del ciclo; opción `cycle_abort` si faltan credenciales
- [x] **Weekly/monthly reporting** — plugin `weekly-reporter` tipo extra; P&L, Sharpe, maxDD, win rate, profit factor, top 5 señales; formato Telegram; hook detecta día de reporte (configurable); envío solo si TELEGRAM_BOT_TOKEN configurado
- [x] **NAV Snapshot** — `SnapshotService`; tabla NavSnapshot; equity curve persistente para retroalimentación; disponible como herramienta para plugins via GET /snapshot/equity-curve
- [x] **Alert Engine plugin-driven** — plugins emiten `emit_alerts` en contexto; `AgentsService` persiste en `AlertEntry`; plataforma no detecta riesgos por sí misma (shell philosophy); GET /alerts con historial completo
- [x] **Shadow Portfolio / Veto Outcomes** — cubierto por el sistema Pretest: el usuario puede crear un pretest con los mismos skills pero sin discipline plugins (sin veto), y comparar vía GET /pretest/compare contra uno con discipline activo
- [x] **Data Quality (cross-provider)** — plugin `data-quality` tipo discipline; valida precios antes de permitir señales: ZERO_PRICE/STALE_PRICE/OUTLIER(4σ)/HISTORY_GAP/INSUFFICIENT/CROSS_PROVIDER; veta señales de símbolos con datos sospechosos; emite alertas; configurable via manifest.toml

---

## 💡 Ideas futuras

- **IV Rank skill** — Implied Volatility Rank/Percentile para opciones; identifica cuándo la IV está cara/barata (requiere datos de opciones)
- **Earnings Call NLP** — analizar transcripciones de earnings calls con el LLM; señales sobre guidance, tono del CEO
- **Options Greeks Monitor** — delta, gamma, theta, vega por posición; calcular exposición real delta-equivalente
- **ML Feature Extractor** — scikit-learn on-device; entrena modelo con señales históricas para mejorar el signal aggregator
- **Paper trading automático** — simula ejecución en tiempo real con reporte diario vía Telegram
- **Federación de señales** — compartir consenso de señales entre instancias con privacidad (solo señales, no datos ni credenciales)
- [x] **Walk-Forward Backtester** — plugin `walk-forward-backtester` tipo extra; Pardo (2008) walk-forward anchored; robustness ratio = Sharpe_OOS/Sharpe_IS; veredicto ROBUSTO/SOBREAJUSTADO/INSUFICIENTE_DATOS
- [x] **KAMA Adaptive Moving Average** — plugin `kama-adaptive` tipo skill; Kaufman (1995); ER (Efficiency Ratio) adapta velocidad al régimen; solo señales en tendencia (ER>0.6); elimina whipsaws vs EMA fija; históricamente supera buy-and-hold en 15 de 20 años
- [x] **Wyckoff Volume Analysis** — plugin `wyckoff-volume` tipo skill; detecta acumulación/distribución institucional; Spring/Upthrust/SOS/SOW; win rate ~65-70%
- [x] **Market Breadth** — plugin `market-breadth` tipo skill; A/D Ratio, % sobre MA200, McClellan Oscillator, NH/NL Ratio, Breadth Thrust Zweig (1986); score 0-100 + régimen; detecta divergencias precio/breadth; inyecta `market_breadth_regime` en contexto para que discipline plugins escalen posiciones; detecta acumulación/distribución institucional; Spring (falsa ruptura soporte, vol bajo → bullish) y Upthrust (falsa ruptura resistencia, vol alto → bearish); SOS/SOW; win rate ~65-70% en Springs confirmados
- **Adaptive parameters** — el LLM ajusta parámetros de skills según el régimen de volatilidad actual
- **WebSocket bidireccional** — migrar de SSE a WS para chat en tiempo real con el agente
- **Prisma migrations** — gestión de schema versionado para producción

---

## 📐 Decisiones de arquitectura

| Decisión | Justificación |
|----------|--------------|
| Un solo ProviderGatewayService para todos los providers | No duplicar código NestJS; cada provider declara su API en manifest.toml |
| Sandbox sin red + ProviderGateway con red | Seguridad: el LLM y el código plugin no pueden exfiltrar datos; solo el gateway accede a internet |
| Plugin hot-reload solo fuera de producción | En producción los cambios deben pasar por CI; en dev permite iteración rápida |
| Frecuencia de ciclo por plugin (no global) | Cada estrategia tiene su propio timeframe; polling mínimo innecesario para estrategias lentas |
| Telegram Notifier como NestJS service (no sandbox) | Necesita acceso a red y suscripción permanente al bus de eventos |
