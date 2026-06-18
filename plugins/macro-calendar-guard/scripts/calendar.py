"""
Macro Calendar Guard — lógica de eventos macro de alta volatilidad.

Fuente de eventos: calendario embebido (actualizado manualmente cada trimestre)
+ lógica para calcular eventos regulares (NFP = primer viernes del mes).

No hace peticiones de red — el LLM puede enriquecer ctx con eventos futuros
usando read_skill + emit_signal o la herramienta inject_event.
"""

import contextlib
from dataclasses import dataclass
from datetime import date, datetime, timedelta


@dataclass
class MacroEvent:
    name: str
    event_date: date
    event_time_utc: str  # "HH:MM"
    category: str  # fed | cpi | nfp | ecb | other
    impact: str  # high | medium
    affected: str  # all | equities | forex | crypto


@dataclass
class BlackoutWindow:
    event: MacroEvent
    window_start: datetime
    window_end: datetime
    is_blackout: bool  # True = bloqueo total; False = zona gris (reducción)
    reason: str


def first_friday(year: int, month: int) -> date:
    """Primer viernes del mes (fecha de NFP)."""
    d = date(year, month, 1)
    while d.weekday() != 4:  # 4 = Friday
        d += timedelta(days=1)
    return d


def get_nfp_dates(year: int) -> list[date]:
    """NFP: primer viernes de cada mes excepto enero (se suele publicar el segundo)."""
    dates = []
    for month in range(1, 13):
        fri = first_friday(year, month)
        dates.append(fri)
    return dates


# Eventos fijos del calendario 2026 (actualizables manualmente cada trimestre)
FIXED_EVENTS_2026: list[tuple] = [
    # (name, date_str YYYY-MM-DD, time_utc HH:MM, category, impact, affected)
    # FOMC 2026
    ("FOMC Meeting", "2026-01-28", "19:00", "fed", "high", "all"),
    ("FOMC Meeting", "2026-03-18", "18:00", "fed", "high", "all"),
    ("FOMC Meeting", "2026-05-06", "18:00", "fed", "high", "all"),
    ("FOMC Meeting", "2026-06-17", "18:00", "fed", "high", "all"),
    ("FOMC Meeting", "2026-07-29", "18:00", "fed", "high", "all"),
    ("FOMC Meeting", "2026-09-16", "18:00", "fed", "high", "all"),
    ("FOMC Meeting", "2026-11-04", "19:00", "fed", "high", "all"),
    ("FOMC Meeting", "2026-12-16", "19:00", "fed", "high", "all"),
    # CPI US 2026 (aproximado — BLS publica ~segundo o tercer miércoles)
    ("US CPI", "2026-01-15", "13:30", "cpi", "high", "all"),
    ("US CPI", "2026-02-12", "13:30", "cpi", "high", "all"),
    ("US CPI", "2026-03-12", "13:30", "cpi", "high", "all"),
    ("US CPI", "2026-04-10", "12:30", "cpi", "high", "all"),
    ("US CPI", "2026-05-13", "12:30", "cpi", "high", "all"),
    ("US CPI", "2026-06-10", "12:30", "cpi", "high", "all"),
    ("US CPI", "2026-07-14", "12:30", "cpi", "high", "all"),
    ("US CPI", "2026-08-13", "12:30", "cpi", "high", "all"),
    ("US CPI", "2026-09-11", "12:30", "cpi", "high", "all"),
    ("US CPI", "2026-10-14", "12:30", "cpi", "high", "all"),
    ("US CPI", "2026-11-12", "13:30", "cpi", "high", "all"),
    ("US CPI", "2026-12-10", "13:30", "cpi", "high", "all"),
    # ECB 2026
    ("ECB Rate Decision", "2026-01-30", "13:15", "ecb", "high", "forex"),
    ("ECB Rate Decision", "2026-03-05", "13:15", "ecb", "high", "forex"),
    ("ECB Rate Decision", "2026-04-16", "12:15", "ecb", "high", "forex"),
    ("ECB Rate Decision", "2026-06-04", "12:15", "ecb", "high", "forex"),
    ("ECB Rate Decision", "2026-07-23", "12:15", "ecb", "high", "forex"),
    ("ECB Rate Decision", "2026-09-10", "12:15", "ecb", "high", "forex"),
    ("ECB Rate Decision", "2026-10-29", "13:15", "ecb", "high", "forex"),
    ("ECB Rate Decision", "2026-12-17", "13:15", "ecb", "high", "forex"),
]


def build_event_calendar(year: int, cfg: dict) -> list[MacroEvent]:
    """Construye el calendario de eventos para el año dado."""
    events: list[MacroEvent] = []

    # Eventos fijos
    for row in FIXED_EVENTS_2026:
        name, date_str, time_utc, category, impact, affected = row
        if category == "fed" and not cfg.get("fed_events", True):
            continue
        if category == "cpi" and not cfg.get("cpi_events", True):
            continue
        if category == "ecb" and not cfg.get("ecb_events", True):
            continue

        event_date = date.fromisoformat(date_str)
        if event_date.year != year:
            continue

        events.append(
            MacroEvent(
                name=name,
                event_date=event_date,
                event_time_utc=time_utc,
                category=category,
                impact=impact,
                affected=affected,
            )
        )

    # NFP: primer viernes de cada mes
    if cfg.get("nfp_events", True):
        for nfp_date in get_nfp_dates(year):
            events.append(
                MacroEvent(
                    name="Non-Farm Payrolls",
                    event_date=nfp_date,
                    event_time_utc="12:30",
                    category="nfp",
                    impact="high",
                    affected="all",
                )
            )

    return events


def get_active_blackouts(
    now: datetime,
    cfg: dict,
    extra_events: list[dict] | None = None,
) -> list[BlackoutWindow]:
    """
    Devuelve las ventanas de blackout activas en `now`.
    `extra_events` permite inyectar eventos desde el LLM/ctx.
    """
    hours_before = cfg.get("blackout_hours_before", 4)
    hours_after = cfg.get("blackout_hours_after", 2)
    affected_filter = cfg.get("affected_assets", "all")

    events = build_event_calendar(now.year, cfg)

    # Incluir eventos del año siguiente si estamos a final de año
    if now.month == 12:
        events += build_event_calendar(now.year + 1, cfg)

    # Eventos inyectados por el LLM/ctx
    if extra_events:
        for ev in extra_events:
            with contextlib.suppress(Exception):
                events.append(
                    MacroEvent(
                        name=ev["name"],
                        event_date=date.fromisoformat(ev["date"]),
                        event_time_utc=ev.get("time_utc", "12:00"),
                        category=ev.get("category", "other"),
                        impact=ev.get("impact", "high"),
                        affected=ev.get("affected", "all"),
                    )
                )

    active: list[BlackoutWindow] = []

    for event in events:
        # Filtrar por tipo de activo
        if (
            affected_filter != "all"
            and event.affected != "all"
            and event.affected != affected_filter
        ):
            continue

        h, m = map(int, event.event_time_utc.split(":"))
        event_dt = datetime(
            event.event_date.year,
            event.event_date.month,
            event.event_date.day,
            h,
            m,
        )

        win_start = event_dt - timedelta(hours=hours_before)
        win_end = event_dt + timedelta(hours=hours_after)

        # Ventana de blackout total (1h antes hasta 1h después)
        blackout_start = event_dt - timedelta(hours=1)
        blackout_end = event_dt + timedelta(hours=1)

        if win_start <= now <= win_end:
            is_blackout = blackout_start <= now <= blackout_end
            active.append(
                BlackoutWindow(
                    event=event,
                    window_start=win_start,
                    window_end=win_end,
                    is_blackout=is_blackout,
                    reason=(
                        f"{event.name} el {event.event_date} {event.event_time_utc} UTC "
                        f"({'blackout total' if is_blackout else 'zona de precaución'})"
                    ),
                )
            )

    return active


def filter_signals(
    signals: list[dict],
    blackouts: list[BlackoutWindow],
    cfg: dict,
) -> tuple[list[dict], list[dict]]:
    """
    Divide señales en (aprobadas, suprimidas/ajustadas).
    Ajusta position_size en zona gris si warn_only=False.
    """
    warn_only = cfg.get("warn_only", False)
    reduce_pct = cfg.get("reduce_size_pct", 50)
    affected_filter = cfg.get("affected_assets", "all")

    if not blackouts:
        return signals, []

    approved: list[dict] = []
    suppressed: list[dict] = []

    for sig in signals:
        asset_class = sig.get("asset_class", "all")
        relevant = [
            b
            for b in blackouts
            if b.event.affected == "all"
            or affected_filter == "all"
            or b.event.affected == asset_class
        ]

        if not relevant:
            approved.append(sig)
            continue

        in_blackout = any(b.is_blackout for b in relevant)
        reasons = [b.reason for b in relevant]

        if warn_only:
            sig = dict(sig)
            sig.setdefault("warnings", [])
            sig["warnings"].extend(reasons)
            approved.append(sig)
        elif in_blackout:
            sig = dict(sig)
            sig["suppressed"] = True
            sig["suppress_reason"] = "; ".join(reasons)
            suppressed.append(sig)
        else:
            # Zona gris: reducir tamaño
            sig = dict(sig)
            if "position_size" in sig:
                original = sig["position_size"]
                sig["position_size"] = round(original * (1 - reduce_pct / 100), 4)
                sig["size_reduced_reason"] = f"Zona macro ({'; '.join(reasons)}) → -{reduce_pct}%"
            approved.append(sig)

    return approved, suppressed
