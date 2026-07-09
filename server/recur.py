"""Helpers de recurrencia: avanzar fechas según frecuencia/intervalo."""
import calendar
from datetime import date, timedelta

FREQS = ("daily", "weekly", "monthly")


def advance(d: date, freq: str, interval: int) -> date:
    interval = max(1, int(interval or 1))
    if freq == "daily":
        return d + timedelta(days=interval)
    if freq == "weekly":
        return d + timedelta(weeks=interval)
    if freq == "monthly":
        m0 = d.month - 1 + interval
        year = d.year + m0 // 12
        month = m0 % 12 + 1
        day = min(d.day, calendar.monthrange(year, month)[1])
        return date(year, month, day)
    raise ValueError(f"frecuencia desconocida: {freq}")
