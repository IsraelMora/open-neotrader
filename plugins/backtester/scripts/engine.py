"""
Motor de backtesting ligero — sin dependencias externas, solo numpy/statistics.

Diseño:
- Recibe lista de señales históricas (fecha, símbolo, acción, precio_entrada, precio_salida)
- Simula ejecución con comisiones y slippage
- Calcula métricas de rendimiento

Compatibilidad: señales del formato NeuroTrader (emit_signal output).
"""

import math
import statistics
from dataclasses import dataclass, field


@dataclass
class Trade:
    symbol: str
    direction: str  # long | short
    entry_date: str
    exit_date: str
    entry_price: float
    exit_price: float
    shares: float
    commission: float
    slippage: float
    pnl: float  # neto de comisiones y slippage
    pnl_pct: float
    duration_days: int


@dataclass
class BacktestResult:
    # Métricas resumen
    total_return_pct: float
    cagr_pct: float
    sharpe_ratio: float
    sortino_ratio: float
    max_drawdown_pct: float
    calmar_ratio: float

    # Estadísticas de trades
    total_trades: int
    win_rate_pct: float
    profit_factor: float
    avg_win_pct: float
    avg_loss_pct: float
    avg_duration_days: float
    largest_win_pct: float
    largest_loss_pct: float

    # Exposición
    time_in_market_pct: float
    avg_positions: float

    # Curva de equity (opcional)
    equity_curve: list[dict] = field(default_factory=list)
    trades: list[dict] = field(default_factory=list)


def run_backtest(
    signals: list[dict],
    prices: dict[str, list[dict]],  # symbol → [{date, open, high, low, close, volume}]
    cfg: dict,
) -> BacktestResult:
    """
    Ejecuta backtest sobre señales históricas.

    signals: [
      {symbol, action (long|short|exit), date, confidence, ...},
      ...
    ]
    prices: {
      "AAPL": [
        {date: "2024-01-02", open: 185.0, high: 186.0, low: 184.0, close: 185.5, volume: 1e6},
        ...
      ],
      ...
    }
    """
    capital = cfg.get("initial_capital", 10_000)
    commission = cfg.get("commission_pct", 0.001)
    slippage = cfg.get("slippage_pct", 0.0005)
    risk_per_trade = cfg.get("risk_per_trade", 0.01)
    max_positions = cfg.get("max_positions", 5)

    # Construir índice de precios por fecha
    price_index: dict[str, dict[str, dict]] = {}  # symbol → date → bar
    for symbol, bars in prices.items():
        price_index[symbol] = {b["date"]: b for b in bars}

    # Orden de fechas por símbolo. Ejecución realista: una señal generada con el
    # cierre de la barra i se ejecuta en la APERTURA de la barra i+1 (nunca al
    # cierre de la misma barra, que sería información imposible de conocer).
    date_order: dict[str, list[str]] = {sym: sorted(idx.keys()) for sym, idx in price_index.items()}
    date_pos: dict[str, dict[str, int]] = {
        sym: {d: i for i, d in enumerate(dates)} for sym, dates in date_order.items()
    }

    def _next_fill(symbol: str, sig_date: str) -> dict | None:
        """Barra de ejecución = primera barra POSTERIOR a la fecha de la señal."""
        dates = date_order.get(symbol, [])
        pos = date_pos.get(symbol, {}).get(sig_date)
        if pos is None or pos + 1 >= len(dates):
            return None
        return price_index[symbol][dates[pos + 1]]

    # Span de calendario (para CAGR y exposición), en días.
    from datetime import date as _date

    _all_dates = sorted({d for idx in price_index.values() for d in idx})
    if len(_all_dates) >= 2:
        span_days = max((_date.fromisoformat(_all_dates[-1]) - _date.fromisoformat(_all_dates[0])).days, 1)
    else:
        span_days = 1

    # Ordenar señales por fecha
    signals_sorted = sorted(signals, key=lambda s: s.get("date", ""))

    equity = capital
    equity_curve = [
        {"date": signals_sorted[0]["date"] if signals_sorted else "start", "equity": equity}
    ]
    open_positions: dict[str, dict] = {}  # symbol → position info
    completed_trades: list[Trade] = []
    daily_returns: list[float] = []

    prev_equity = equity

    for sig in signals_sorted:
        symbol = sig.get("symbol", "")
        action = sig.get("action", "")
        sig_date = sig.get("date", "")

        if not symbol or not sig_date:
            continue

        fill_bar = _next_fill(symbol, sig_date)
        if not fill_bar:
            # Sin barra siguiente no hay ejecución posible (no usar el cierre actual,
            # que sería lookahead). Señales en la última barra quedan sin ejecutar.
            continue
        price = fill_bar["open"]
        exec_date = fill_bar["date"]

        # Abrir posición
        if action in ("long", "short") and symbol not in open_positions:
            if len(open_positions) >= max_positions:
                continue

            # Tamaño por riesgo fijo
            risk_amount = equity * risk_per_trade
            shares = risk_amount / (price * (commission + slippage + 0.001))
            shares = max(0.01, shares)

            cost = shares * price * (1 + commission + slippage)
            if cost > equity:
                shares = equity / (price * (1 + commission + slippage))
                cost = equity

            equity -= cost
            open_positions[symbol] = {
                "direction": action,
                "entry_date": exec_date,
                "entry_price": price,
                "shares": shares,
                "cost": cost,
            }

        # Cerrar posición
        elif action == "exit" and symbol in open_positions:
            pos = open_positions.pop(symbol)
            exit_price = price

            gross = pos["shares"] * exit_price
            comm_cost = gross * (commission + slippage)
            proceeds = gross - comm_cost

            pnl = proceeds - pos["cost"] if pos["direction"] == "long" else pos["cost"] - proceeds

            pnl_pct = pnl / pos["cost"] * 100

            # Calcular duración en días aproximado
            try:
                d1 = _date.fromisoformat(pos["entry_date"])
                d2 = _date.fromisoformat(exec_date)
                duration = (d2 - d1).days
            except Exception:
                duration = 0

            equity += pos["cost"] + pnl

            completed_trades.append(
                Trade(
                    symbol=symbol,
                    direction=pos["direction"],
                    entry_date=pos["entry_date"],
                    exit_date=sig_date,
                    entry_price=pos["entry_price"],
                    exit_price=exit_price,
                    shares=pos["shares"],
                    commission=comm_cost,
                    slippage=0,
                    pnl=pnl,
                    pnl_pct=pnl_pct,
                    duration_days=duration,
                )
            )

            # Registrar retorno diario
            daily_return = (equity - prev_equity) / prev_equity if prev_equity > 0 else 0
            daily_returns.append(daily_return)
            prev_equity = equity

            equity_curve.append({"date": exec_date, "equity": round(equity, 2)})

    # Cerrar posiciones abiertas al precio del último bar disponible
    for symbol, pos in list(open_positions.items()):
        last_bars = price_index.get(symbol, {})
        if last_bars:
            last_date = sorted(last_bars.keys())[-1]
            last_price = last_bars[last_date]["close"]
            exit_price = last_price

            gross = pos["shares"] * exit_price
            comm_cost = gross * (commission + slippage)
            proceeds = gross - comm_cost

            pnl = proceeds - pos["cost"] if pos["direction"] == "long" else pos["cost"] - proceeds

            equity += pos["cost"] + pnl
            completed_trades.append(
                Trade(
                    symbol=symbol,
                    direction=pos["direction"],
                    entry_date=pos["entry_date"],
                    exit_date=last_date,
                    entry_price=pos["entry_price"],
                    exit_price=exit_price,
                    shares=pos["shares"],
                    commission=comm_cost,
                    slippage=0,
                    pnl=pnl,
                    pnl_pct=pnl / pos["cost"] * 100,
                    duration_days=0,
                )
            )
            equity_curve.append({"date": last_date, "equity": round(equity, 2)})

    # ── Calcular métricas ────────────────────────────────────────────────────

    total_return = (equity - capital) / capital * 100

    # Calcular CAGR — anualizado sobre el span de calendario real de los datos,
    # no sobre el número de trades.
    n_years = max(span_days / 365.25, 0.01)
    cagr = ((equity / capital) ** (1 / n_years) - 1) * 100 if capital > 0 and equity > 0 else 0

    # Max drawdown
    peak = capital
    max_dd = 0.0
    running = capital
    for point in equity_curve:
        running = point["equity"]
        if running > peak:
            peak = running
        dd = (peak - running) / peak * 100 if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd

    # Sharpe (asume rf=2% anual, diario=2/252)
    rf_daily = 0.02 / 252
    if len(daily_returns) > 1:
        mean_r = statistics.mean(daily_returns) - rf_daily
        std_r = statistics.stdev(daily_returns)
        sharpe = (mean_r / std_r) * math.sqrt(252) if std_r > 0 else 0
    else:
        sharpe = 0

    # Sortino (solo downside deviation)
    downside = [r - rf_daily for r in daily_returns if r < rf_daily]
    if len(downside) > 1:
        dd_std = math.sqrt(sum(d**2 for d in downside) / len(downside))
        mean_r = statistics.mean(daily_returns) - rf_daily
        sortino = (mean_r / dd_std) * math.sqrt(252) if dd_std > 0 else 0
    else:
        sortino = 0

    calmar = cagr / max_dd if max_dd > 0 else 0

    # Estadísticas de trades
    wins = [t for t in completed_trades if t.pnl > 0]
    losses = [t for t in completed_trades if t.pnl <= 0]

    win_rate = len(wins) / len(completed_trades) * 100 if completed_trades else 0

    total_wins = sum(t.pnl for t in wins)
    total_losses = abs(sum(t.pnl for t in losses))
    profit_factor = total_wins / total_losses if total_losses > 0 else float("inf")

    avg_win = statistics.mean([t.pnl_pct for t in wins]) if wins else 0
    avg_loss = statistics.mean([t.pnl_pct for t in losses]) if losses else 0

    largest_win = max((t.pnl_pct for t in wins), default=0)
    largest_loss = min((t.pnl_pct for t in losses), default=0)

    avg_duration = (
        statistics.mean([t.duration_days for t in completed_trades]) if completed_trades else 0
    )

    # Time in market — fracción del calendario con exposición real:
    # suma de las duraciones de los trades sobre el span total (acotado a 100%).
    position_days = sum(t.duration_days for t in completed_trades)
    time_in_mkt = min(100.0, position_days / span_days * 100)

    include_curve = cfg.get("output_equity_curve", True)

    return BacktestResult(
        total_return_pct=round(total_return, 2),
        cagr_pct=round(cagr, 2),
        sharpe_ratio=round(sharpe, 2),
        sortino_ratio=round(sortino, 2),
        max_drawdown_pct=round(max_dd, 2),
        calmar_ratio=round(calmar, 2),
        total_trades=len(completed_trades),
        win_rate_pct=round(win_rate, 2),
        profit_factor=round(profit_factor, 2) if math.isfinite(profit_factor) else 999,
        avg_win_pct=round(avg_win, 2),
        avg_loss_pct=round(avg_loss, 2),
        avg_duration_days=round(avg_duration, 1),
        largest_win_pct=round(largest_win, 2),
        largest_loss_pct=round(largest_loss, 2),
        time_in_market_pct=round(time_in_mkt, 1),
        avg_positions=round(position_days / span_days, 2),
        equity_curve=equity_curve if include_curve else [],
        trades=[
            {
                "symbol": t.symbol,
                "direction": t.direction,
                "entry_date": t.entry_date,
                "exit_date": t.exit_date,
                "entry_price": round(t.entry_price, 4),
                "exit_price": round(t.exit_price, 4),
                "pnl": round(t.pnl, 2),
                "pnl_pct": round(t.pnl_pct, 2),
                "duration_days": t.duration_days,
            }
            for t in completed_trades
        ]
        if include_curve
        else [],
    )


def format_result(result: BacktestResult) -> str:
    """Formatea el resultado del backtest para mostrarlo al LLM."""
    return f"""
=== BACKTEST RESULTS ===

Performance:
  Total Return:    {result.total_return_pct:+.2f}%
  CAGR:            {result.cagr_pct:+.2f}%
  Sharpe Ratio:    {result.sharpe_ratio:.2f}
  Sortino Ratio:   {result.sortino_ratio:.2f}
  Max Drawdown:    -{result.max_drawdown_pct:.2f}%
  Calmar Ratio:    {result.calmar_ratio:.2f}

Trade Stats:
  Total Trades:    {result.total_trades}
  Win Rate:        {result.win_rate_pct:.1f}%
  Profit Factor:   {result.profit_factor:.2f}
  Avg Win:         {result.avg_win_pct:+.2f}%
  Avg Loss:        {result.avg_loss_pct:.2f}%
  Avg Duration:    {result.avg_duration_days:.0f} days
  Largest Win:     {result.largest_win_pct:+.2f}%
  Largest Loss:    {result.largest_loss_pct:.2f}%

Exposure:
  Time in Market:  {result.time_in_market_pct:.1f}%
  Avg Positions:   {result.avg_positions:.1f}
"""
