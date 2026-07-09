"""Bucle en segundo plano: recordatorios vencidos -> notificación de escritorio."""
import asyncio
import os
import shutil
import sys
from datetime import date, datetime, timedelta

from . import db, recur

CHECK_INTERVAL_S = 30
MISSED_AFTER = timedelta(hours=24)
AUDIT_DAY_HOUR = 9  # las fechas de auditoría/informe son días completos: avisar sobre las 09:00

TEXTS = {
    "es": {
        "meeting": "Reunión",
        "task": "Tarea",
        "audit_start": "Comienza la auditoría",
        "report_start": "Comienza el periodo de informe",
        "vacation_start": "Comienzan las vacaciones",
        "at": "a las",
        "on": "el",
        "location": "Ubicación",
        "team": "Equipo",
    },
    "en": {
        "meeting": "Meeting",
        "task": "Task",
        "audit_start": "Audit starts",
        "report_start": "Reporting period starts",
        "vacation_start": "Vacation starts",
        "at": "at",
        "on": "on",
        "location": "Location",
        "team": "Team",
    },
}


def _parse_dt(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    if dt.hour == 0 and dt.minute == 0 and "T" not in value:
        dt = dt.replace(hour=AUDIT_DAY_HOUR)
    return dt


def _target_datetime(conn, kind: str, target_id: int) -> datetime | None:
    if kind == "event":
        row = conn.execute(
            "SELECT datetime FROM events WHERE id = ?", (target_id,)
        ).fetchone()
        return _parse_dt(row["datetime"]) if row else None
    if kind == "vacation_start":
        row = conn.execute(
            "SELECT start_date AS d FROM vacations WHERE id = ?", (target_id,)
        ).fetchone()
        return _parse_dt(row["d"]) if row and row["d"] else None
    column = "audit_start" if kind == "audit_start" else "report_start"
    row = conn.execute(
        f"SELECT {column} AS d FROM audits WHERE id = ?", (target_id,)
    ).fetchone()
    return _parse_dt(row["d"]) if row and row["d"] else None


def _build_message(conn, kind: str, target_id: int, lang: str) -> tuple[str, str] | None:
    t = TEXTS.get(lang, TEXTS["es"])
    if kind == "event":
        ev = conn.execute("SELECT * FROM events WHERE id = ?", (target_id,)).fetchone()
        if not ev:
            return None
        when = _parse_dt(ev["datetime"])
        title = f"{t[ev['kind']]}: {ev['title']}"
        body = f"{t['at']} {when.strftime('%H:%M')} · {when.strftime('%d/%m/%Y')}"
        if ev["location"]:
            body += f"\n{t['location']}: {ev['location']}"
        return title, body

    if kind == "vacation_start":
        vac = conn.execute("SELECT * FROM vacations WHERE id = ?", (target_id,)).fetchone()
        if not vac:
            return None
        when = _parse_dt(vac["start_date"])
        title = f"🏖 {t[kind]}: {vac['title']}"
        body = f"{t['on']} {when.strftime('%d/%m/%Y')}"
        if vac["location"]:
            body += f"\n{t['location']}: {vac['location']}"
        return title, body

    audit = conn.execute("SELECT * FROM audits WHERE id = ?", (target_id,)).fetchone()
    if not audit:
        return None
    when = _target_datetime(conn, kind, target_id)
    title = f"{t[kind]}: {audit['title']}"
    body = f"{t['on']} {when.strftime('%d/%m/%Y')}"
    if audit["location"]:
        body += f"\n{t['location']}: {audit['location']}"
    mates = conn.execute(
        "SELECT tm.name FROM audit_teammates at JOIN teammates tm ON tm.id = at.teammate_id "
        "WHERE at.audit_id = ?",
        (target_id,),
    ).fetchall()
    if mates:
        body += f"\n{t['team']}: " + ", ".join(m["name"] for m in mates)
    return title, body


def _is_wsl() -> bool:
    if os.environ.get("WSL_DISTRO_NAME"):
        return True
    try:
        with open("/proc/version", encoding="utf-8", errors="ignore") as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


async def _deliver(title: str, body: str) -> bool:
    """Entrega el aviso por escritorio nativo. Devuelve True solo si lo entregó.

    Si no hay canal de escritorio (WSL, Windows, sin notify-send), devuelve False
    y el aviso lo mostrará el navegador vía /api/reminders/due.
    """
    try:
        if sys.platform == "darwin" and shutil.which("osascript"):
            script = f'display notification {body!r} with title {title!r}'
            proc = await asyncio.create_subprocess_exec("osascript", "-e", script)
            await proc.wait()
            return proc.returncode == 0
        if sys.platform.startswith("linux") and not _is_wsl() and shutil.which("notify-send"):
            proc = await asyncio.create_subprocess_exec(
                "notify-send", "--urgency=critical", "--app-name=Agenda", title, body
            )
            await proc.wait()
            return proc.returncode == 0
    except Exception as exc:  # noqa: BLE001 — un fallo de aviso no debe romper el bucle
        print(f"[notifier] no se pudo notificar por escritorio: {exc}")
    return False


def _mark_stale_on_startup() -> None:
    """No spamear al arrancar: lo vencido hace >24 h se da por perdido."""
    conn = db.connect()
    try:
        now = datetime.now()
        for rem in conn.execute("SELECT * FROM reminders WHERE fired_at IS NULL"):
            target = _target_datetime(conn, rem["target_kind"], rem["target_id"])
            if target is None:
                conn.execute("DELETE FROM reminders WHERE id = ?", (rem["id"],))
            elif now - (target - timedelta(minutes=rem["offset_min"])) > MISSED_AFTER:
                conn.execute(
                    "UPDATE reminders SET fired_at = ? WHERE id = ?",
                    (now.isoformat(timespec="seconds") + " (missed)", rem["id"]),
                )
        conn.commit()
    finally:
        conn.close()


async def _check_once() -> None:
    conn = db.connect()
    try:
        user = db.get_user(conn)
        lang = user["lang"] if user else "es"
        now = datetime.now()
        for rem in conn.execute("SELECT * FROM reminders WHERE fired_at IS NULL").fetchall():
            target = _target_datetime(conn, rem["target_kind"], rem["target_id"])
            if target is None:
                conn.execute("DELETE FROM reminders WHERE id = ?", (rem["id"],))
                conn.commit()
                continue
            if now < target - timedelta(minutes=rem["offset_min"]):
                continue
            msg = _build_message(conn, rem["target_kind"], rem["target_id"], lang)
            # Solo marcamos como entregado si el escritorio lo mostró de verdad.
            # Si no (WSL/Windows), se deja sin marcar y lo recoge el navegador.
            if msg and await _deliver(*msg):
                conn.execute(
                    "UPDATE reminders SET fired_at = ? WHERE id = ?",
                    (now.isoformat(timespec="seconds"), rem["id"]),
                )
                conn.commit()
    finally:
        conn.close()


def _roll_recurring_todos() -> None:
    """Al pasar su periodo, las tareas recurrentes vuelven a pendiente con nueva fecha."""
    conn = db.connect()
    try:
        today = date.today()
        rows = conn.execute(
            "SELECT id, recurrence, rec_interval, due FROM todos"
            " WHERE recurrence IS NOT NULL AND due IS NOT NULL").fetchall()
        for t in rows:
            try:
                d = date.fromisoformat(t["due"])
            except (ValueError, TypeError):
                continue
            changed = False
            guard = 0
            while d < today and guard < 1000:
                d = recur.advance(d, t["recurrence"], t["rec_interval"])
                changed, guard = True, guard + 1
            if changed:
                conn.execute("UPDATE todos SET due = ?, done = 0 WHERE id = ?",
                             (d.isoformat(), t["id"]))
        conn.commit()
    finally:
        conn.close()


async def run_forever() -> None:
    _mark_stale_on_startup()
    while True:
        try:
            _roll_recurring_todos()
            await _check_once()
        except Exception as exc:  # noqa: BLE001 — el bucle nunca debe morir
            print(f"[notifier] error: {exc}")
        await asyncio.sleep(CHECK_INTERVAL_S)
