---
name: Professional Trader Knowledge Base
description: Base de conocimiento de trader profesional. Cubre psicología, gestión de riesgo, lectura de mercado, patrones, macro y lecciones de crisis. Cargar como contexto base en todos los ciclos de análisis para que el agente actúe con criterio de trader experimentado.
---

# Professional Trader Knowledge Base

## Principios fundamentales (no negociables)

### 1. Preservar capital es la única prioridad
> "La primera regla es no perder dinero. La segunda regla es no olvidar la primera regla." — Warren Buffett

Un drawdown del 50% requiere un retorno del 100% para recuperarse. La asimetría del daño hace que proteger el capital sea siempre más importante que maximizar la ganancia.

**Aplicación directa**:
- Nunca arriesgar más del 2% del portfolio por trade
- Reducir posición a 50% cuando el drawdown mensual supere el 5%
- Parar completamente si el drawdown mensual supera el 10%

### 2. Edge pequeño × alta frecuencia = riqueza
No se necesita ganar el 80% de los trades. Un win rate del 45% con payoff ratio de 2:1 es matemáticamente suficiente.

```
Expectancy = (0.45 × 2) - (0.55 × 1) = 0.90 - 0.55 = 0.35 por unidad de riesgo
```

### 3. Consistencia sobre rendimiento puntual
Un trader que gana 15% anual durante 10 años sin quiebra supera al que gana 50% y luego pierde todo. La curva de equity debe ser suave y ascendente, no montaña rusa.

---

## Gestión de riesgo: marco operativo

### Sizing de posición
```
Riesgo por trade = 1-2% del capital total (máximo absoluto)
Tamaño = (Capital × riesgo%) / (precio_entrada - stop_loss)

Ejemplo: $50,000 capital, 1% riesgo, stop a 3% del precio
Riesgo_USD = $500
Si stop_loss = $97 y precio = $100
Shares = $500 / ($100 - $97) = 166 shares
```

### Correlación entre posiciones
- Máximo 3-4 posiciones en el mismo sector
- Si activos tienen correlación > 0.8, contar como 1.5 posiciones a efectos de riesgo
- Diversificar entre sectores/activos no correlacionados

### Gestión dinámica del riesgo
| Estado del Portfolio | Acción |
|----------------------|--------|
| Drawdown < 3% | Operación normal |
| Drawdown 3-5% | Reducir tamaño de posición al 75% |
| Drawdown 5-10% | Reducir al 50%, revisar estrategia |
| Drawdown > 10% | Stop total, análisis post-mortem, volver a 25% |

---

## Psicología de trading: los errores más caros

### Sesgo de disposición
**Problema**: los traders venden ganadores pronto y aguantan perdedores demasiado tiempo.  
**Solución**: stop loss automático (no manual), trailing stop para ganancias.

### Revenge trading
**Problema**: después de una pérdida grande, se aumenta el riesgo para "recuperar".  
**Solución**: regla de circuit breaker — 2 pérdidas consecutivas = pausa de 1 día.

### FOMO (Fear of Missing Out)
**Problema**: entrar tarde en un movimiento ya hecho porque "sigue subiendo".  
**Solución**: si el setup ya no es válido (cruce ya pasó 3+ barras), esperar siguiente oportunidad.

### Overconfidence después de una racha ganadora
**Problema**: aumentar el riesgo después de 5-10 trades ganadores.  
**Solución**: el sizing se calcula siempre igual, sin importar la racha previa.

### Ancla al precio de entrada
**Problema**: gestionar una posición basado en el precio de compra ("no vendo hasta estar en positivo").  
**Solución**: cada decisión debe basarse en el análisis actual, no en el P&L no realizado.

---

## Lectura de mercado: señales de régimen

### Mercado en tendencia alcista
- Precio > EMA(200)
- Máximos y mínimos crecientes en gráfico diario
- Volumen aumenta en subidas y disminuye en correcciones
- RSI mantiene zona 50-80 durante correcciones

### Mercado en distribución (riesgo alto)
- Precio lateral tras una subida prolongada
- Volumen elevado sin avance de precio (manos fuertes distribuyendo)
- Divergencia RSI: precio hace nuevo máximo pero RSI no
- Amplitud de mercado deteriorándose (más acciones bajando que subiendo)

### Mercado en pánico/capitulación (posible oportunidad)
- VIX > 40 (mercados USA)
- Volumen extremadamente alto en velas bajistas
- RSI < 20 en múltiples activos del sector
- Noticias dominadas por miedo (señal contrarian)

### Señales macro a monitorear
| Indicador | Señal alcista | Señal bajista |
|-----------|---------------|---------------|
| Fed tasa interés | Bajando | Subiendo rápido |
| Curva de rendimiento | Normal (10y>2y) | Invertida |
| PMI manufacturero | > 50 | < 45 |
| Desempleo | Estable/bajando | Subiendo rápido |
| Dólar (DXY) | Bajando (beneficia commodities/EM) | Subiendo fuerte |

---

## Patrones de precio de alta probabilidad

### Bandera (Flag Pattern)
```
Setup: fuerte movimiento inicial (mástil) → consolidación lateral de 5-15 barras
Entrada: ruptura del canal de consolidación con volumen
Target: altura del mástil proyectada desde la ruptura
Stop: por debajo del mínimo de la bandera
Probabilidad histórica de éxito: ~65%
```

### Pull-back a EMA tras ruptura
```
Setup: precio rompe resistencia → sube → vuelve a tocar la resistencia rota (ahora soporte)
Entrada: rebote desde EMA(20) o la zona de resistencia anterior
Stop: cierre por debajo de la zona de soporte
Razón: segundo punto de entrada con mejor R/R que la ruptura inicial
```

### Squeeze de volatilidad (Bollinger Band Squeeze)
```
Setup: bandas de Bollinger se comprimen (σ mínima en 20 periodos)
Señal: dirección del rompimiento
Stop: otro extremo de la contracción
Contexto: mejor en activos sin tendencia reciente
```

---

## Lecciones de crisis y crashes

### Crisis 2008-2009
- **Lección clave**: correlaciones se van a 1 en crisis — la diversificación falla cuando más se necesita
- **Acción**: mantener siempre 10-20% en cash o bonos del gobierno para liquidez
- **Oportunidad**: las mejores compras ocurren cuando el pánico es máximo (marzo 2009)

### Flash Crash 2010 / Agosto 2015
- **Lección**: órdenes market en apertura pueden ejecutarse a precios extremos
- **Acción**: usar siempre órdenes limit, nunca market en aperturas volátiles

### COVID Crash 2020
- **Lección**: los mercados pueden caer 35% en 3 semanas — sin stop loss automático, posible desastre
- **Oportunidad**: recuperación total en 5 meses — el que compró en el caos ganó enormemente

### Crypto Bear Markets 2018, 2022
- **Lección**: activos con correlación alta al BTC caen juntos, diversificar dentro de crypto no protege
- **Lección**: proyectos sin fundamentales pueden caer 95%+ y no recuperarse

---

## Checklist pre-trade

Antes de ejecutar cualquier señal verificar:

- [ ] ¿El setup técnico es válido y fresco (no hace 5 barras)?
- [ ] ¿Dónde está el stop loss exacto?
- [ ] ¿Cuánto se pierde si salta el stop? ¿Es < 2% del portfolio?
- [ ] ¿Cuál es el target? ¿R/R ≥ 1.5:1?
- [ ] ¿El mercado general está en tendencia favorable o en downtrend?
- [ ] ¿Hay eventos macro en las próximas 24h (earnings, FOMC, inflación)?
- [ ] ¿El activo tiene liquidez suficiente (volumen > 1M USD diario)?
- [ ] ¿El sector está fuerte o débil relativo al mercado?

Solo operar si todas las respuestas son favorables.

---

## Métricas de seguimiento obligatorias

| Métrica | Frecuencia | Benchmark saludable |
|---------|------------|---------------------|
| Win rate | Por lote de 20 trades | > 40% |
| Payoff ratio | Por lote de 20 trades | > 1.5 |
| Sharpe ratio | Mensual | > 0.8 anualizado |
| Max drawdown | Continuo | < 15% |
| Profit factor | Por mes | > 1.3 |
| Calmar ratio | Trimestral | > 0.5 |

```
Profit Factor = suma_ganancias / suma_pérdidas   (debe ser > 1 para ser rentable)
Calmar Ratio  = retorno_anual / max_drawdown      (mide calidad del retorno)
```

---

## Notas aprendidas

<!-- El LLM actualiza esta sección con observaciones y correcciones de ciclos reales -->
