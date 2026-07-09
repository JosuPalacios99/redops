"""API de la agenda + servidor de estáticos."""
import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, db, notifier, recur

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    task = asyncio.create_task(notifier.run_forever())
    yield
    task.cancel()


app = FastAPI(title="RedOps", lifespan=lifespan)
app.include_router(auth.router)

protected = Depends(auth.require_session)


# ---------------------------------------------------------------- modelos

class AuditIn(BaseModel):
    title: str
    type_id: int
    location: str | None = None
    audit_start: str
    audit_end: str
    report_start: str | None = None
    report_end: str | None = None
    status: str = "planned"
    notes: str | None = None
    teammate_ids: list[int] = []
    reminder_offsets: list[int] | None = None  # None => usar los por defecto


class EventIn(BaseModel):
    title: str
    kind: str
    audit_id: int | None = None
    datetime: str
    duration_min: int | None = None
    location: str | None = None
    notes: str | None = None
    done: bool = False
    reminder_offsets: list[int] | None = None
    # Recurrencia (solo al crear): freq daily/weekly/monthly, fin por fecha o nº de veces
    recurrence: str | None = None
    rec_interval: int = 1
    rec_until: str | None = None
    rec_count: int | None = None


class VacationIn(BaseModel):
    title: str
    start_date: str
    end_date: str
    location: str | None = None
    notes: str | None = None
    reminder_offsets: list[int] | None = None


class NoteIn(BaseModel):
    content: str


class TodoIn(BaseModel):
    content: str
    done: bool = False
    group_id: int | None = None
    recurrence: str | None = None
    rec_interval: int = 1
    due: str | None = None


class TaskGroupIn(BaseModel):
    name: str


class TodoRecurrenceIn(BaseModel):
    recurrence: str | None = None
    rec_interval: int = 1
    due: str | None = None


class TeammateIn(BaseModel):
    name: str
    color: str = "#8b949e"


class AuditTypeIn(BaseModel):
    name_es: str
    name_en: str
    color: str


class ReminderIn(BaseModel):
    target_kind: str
    target_id: int
    offset_min: int


class AckIn(BaseModel):
    ids: list[int] = []


class SettingsIn(BaseModel):
    lang: str | None = None
    default_reminders: list[int] | None = None


class TimeCategoryIn(BaseModel):
    name: str
    color: str = "#8b949e"


class TimeEntryIn(BaseModel):
    day: str
    audit_id: int | None = None
    category_id: int | None = None
    event_id: int | None = None
    hours: float
    note: str | None = None


# ---------------------------------------------------------------- helpers

def _audit_dict(conn, row) -> dict:
    audit = dict(row)
    audit["teammate_ids"] = [
        r["teammate_id"]
        for r in conn.execute(
            "SELECT teammate_id FROM audit_teammates WHERE audit_id = ?", (row["id"],)
        )
    ]
    return audit


def _set_audit_teammates(conn, audit_id: int, teammate_ids: list[int]) -> None:
    conn.execute("DELETE FROM audit_teammates WHERE audit_id = ?", (audit_id,))
    conn.executemany(
        "INSERT OR IGNORE INTO audit_teammates (audit_id, teammate_id) VALUES (?, ?)",
        [(audit_id, tid) for tid in teammate_ids],
    )


def _replace_reminders(conn, target_kind: str, target_id: int, offsets: list[int]) -> None:
    conn.execute(
        "DELETE FROM reminders WHERE target_kind = ? AND target_id = ? AND fired_at IS NULL",
        (target_kind, target_id),
    )
    conn.executemany(
        "INSERT INTO reminders (target_kind, target_id, offset_min) VALUES (?, ?, ?)",
        [(target_kind, target_id, o) for o in offsets],
    )


# ---------------------------------------------------------------- auditorías

@app.get("/api/audits", dependencies=[protected])
def list_audits():
    conn = db.connect()
    try:
        rows = conn.execute("SELECT * FROM audits ORDER BY audit_start DESC").fetchall()
        return [_audit_dict(conn, r) for r in rows]
    finally:
        conn.close()


@app.post("/api/audits", dependencies=[protected])
def create_audit(body: AuditIn):
    conn = db.connect()
    try:
        cur = conn.execute(
            "INSERT INTO audits (title, type_id, location, audit_start, audit_end,"
            " report_start, report_end, status, notes) VALUES (?,?,?,?,?,?,?,?,?)",
            (body.title, body.type_id, body.location, body.audit_start, body.audit_end,
             body.report_start, body.report_end, body.status, body.notes),
        )
        audit_id = cur.lastrowid
        _set_audit_teammates(conn, audit_id, body.teammate_ids)
        offsets = (
            body.reminder_offsets
            if body.reminder_offsets is not None
            else db.default_reminder_offsets(conn)
        )
        _replace_reminders(conn, "audit_start", audit_id, offsets)
        if body.report_start:
            _replace_reminders(conn, "report_start", audit_id, offsets)
        conn.commit()
        return _audit_dict(conn, conn.execute(
            "SELECT * FROM audits WHERE id = ?", (audit_id,)).fetchone())
    finally:
        conn.close()


@app.put("/api/audits/{audit_id}", dependencies=[protected])
def update_audit(audit_id: int, body: AuditIn):
    conn = db.connect()
    try:
        if not conn.execute("SELECT 1 FROM audits WHERE id = ?", (audit_id,)).fetchone():
            raise HTTPException(status_code=404)
        conn.execute(
            "UPDATE audits SET title=?, type_id=?, location=?, audit_start=?, audit_end=?,"
            " report_start=?, report_end=?, status=?, notes=? WHERE id=?",
            (body.title, body.type_id, body.location, body.audit_start, body.audit_end,
             body.report_start, body.report_end, body.status, body.notes, audit_id),
        )
        _set_audit_teammates(conn, audit_id, body.teammate_ids)
        if body.reminder_offsets is not None:
            _replace_reminders(conn, "audit_start", audit_id, body.reminder_offsets)
            if body.report_start:
                _replace_reminders(conn, "report_start", audit_id, body.reminder_offsets)
        if not body.report_start:
            conn.execute(
                "DELETE FROM reminders WHERE target_kind='report_start' AND target_id=?",
                (audit_id,),
            )
        conn.commit()
        return _audit_dict(conn, conn.execute(
            "SELECT * FROM audits WHERE id = ?", (audit_id,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/audits/{audit_id}", dependencies=[protected])
def delete_audit(audit_id: int):
    conn = db.connect()
    try:
        conn.execute(
            "DELETE FROM reminders WHERE target_kind IN ('audit_start','report_start')"
            " AND target_id = ?", (audit_id,))
        conn.execute("DELETE FROM audits WHERE id = ?", (audit_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- eventos

@app.get("/api/events", dependencies=[protected])
def list_events():
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM events ORDER BY datetime").fetchall()]
    finally:
        conn.close()


MAX_OCCURRENCES = 366  # tope de seguridad para recurrencias sin fin razonable


def _occurrence_datetimes(body: EventIn) -> list[str]:
    """Lista de 'datetime' (YYYY-MM-DDTHH:MM) para la serie a partir de body."""
    if not body.recurrence or body.recurrence not in recur.FREQS:
        return [body.datetime]
    base = datetime.fromisoformat(body.datetime)
    time_part = base.strftime("T%H:%M") if "T" in body.datetime else ""
    until = date.fromisoformat(body.rec_until) if body.rec_until else None
    count = body.rec_count if body.rec_count and body.rec_count > 0 else None
    out = [body.datetime]
    cur_d = base.date()
    while len(out) < (count or MAX_OCCURRENCES):
        cur_d = recur.advance(cur_d, body.recurrence, body.rec_interval)
        if until and cur_d > until:
            break
        out.append(cur_d.isoformat() + time_part)
    return out


@app.post("/api/events", dependencies=[protected])
def create_event(body: EventIn):
    if body.kind not in ("meeting", "task"):
        raise HTTPException(status_code=400, detail="bad_kind")
    conn = db.connect()
    try:
        offsets = (
            body.reminder_offsets
            if body.reminder_offsets is not None
            else db.default_reminder_offsets(conn)
        )
        datetimes = _occurrence_datetimes(body)
        series_id = uuid.uuid4().hex if len(datetimes) > 1 else None
        first_id = None
        for dt in datetimes:
            cur = conn.execute(
                "INSERT INTO events (title, kind, audit_id, datetime, duration_min,"
                " location, notes, done, series_id) VALUES (?,?,?,?,?,?,?,?,?)",
                (body.title, body.kind, body.audit_id, dt, body.duration_min,
                 body.location, body.notes, int(body.done), series_id),
            )
            _replace_reminders(conn, "event", cur.lastrowid, offsets)
            if first_id is None:
                first_id = cur.lastrowid
        conn.commit()
        return dict(conn.execute("SELECT * FROM events WHERE id = ?", (first_id,)).fetchone())
    finally:
        conn.close()


@app.put("/api/events/{event_id}", dependencies=[protected])
def update_event(event_id: int, body: EventIn):
    conn = db.connect()
    try:
        if not conn.execute("SELECT 1 FROM events WHERE id = ?", (event_id,)).fetchone():
            raise HTTPException(status_code=404)
        conn.execute(
            "UPDATE events SET title=?, kind=?, audit_id=?, datetime=?, duration_min=?,"
            " location=?, notes=?, done=? WHERE id=?",
            (body.title, body.kind, body.audit_id, body.datetime, body.duration_min,
             body.location, body.notes, int(body.done), event_id),
        )
        if body.reminder_offsets is not None:
            _replace_reminders(conn, "event", event_id, body.reminder_offsets)
        conn.commit()
        return dict(conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/events/{event_id}", dependencies=[protected])
def delete_event(event_id: int, scope: str = "one"):
    """scope='series' borra todas las ocurrencias de la misma serie."""
    conn = db.connect()
    try:
        ids = [event_id]
        if scope == "series":
            row = conn.execute(
                "SELECT series_id FROM events WHERE id = ?", (event_id,)).fetchone()
            if row and row["series_id"]:
                ids = [r["id"] for r in conn.execute(
                    "SELECT id FROM events WHERE series_id = ?", (row["series_id"],))]
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"DELETE FROM reminders WHERE target_kind='event' AND target_id IN ({placeholders})",
            ids)
        conn.execute(f"DELETE FROM events WHERE id IN ({placeholders})", ids)
        conn.commit()
        return {"ok": True, "deleted": len(ids)}
    finally:
        conn.close()


# ---------------------------------------------------------------- vacaciones

@app.get("/api/vacations", dependencies=[protected])
def list_vacations():
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM vacations ORDER BY start_date DESC")]
    finally:
        conn.close()


@app.post("/api/vacations", dependencies=[protected])
def create_vacation(body: VacationIn):
    conn = db.connect()
    try:
        cur = conn.execute(
            "INSERT INTO vacations (title, start_date, end_date, location, notes)"
            " VALUES (?,?,?,?,?)",
            (body.title, body.start_date, body.end_date, body.location, body.notes))
        vac_id = cur.lastrowid
        offsets = (
            body.reminder_offsets
            if body.reminder_offsets is not None
            else db.default_reminder_offsets(conn)
        )
        _replace_reminders(conn, "vacation_start", vac_id, offsets)
        conn.commit()
        return dict(conn.execute("SELECT * FROM vacations WHERE id = ?",
                                 (vac_id,)).fetchone())
    finally:
        conn.close()


@app.put("/api/vacations/{vac_id}", dependencies=[protected])
def update_vacation(vac_id: int, body: VacationIn):
    conn = db.connect()
    try:
        if not conn.execute("SELECT 1 FROM vacations WHERE id = ?", (vac_id,)).fetchone():
            raise HTTPException(status_code=404)
        conn.execute(
            "UPDATE vacations SET title=?, start_date=?, end_date=?, location=?, notes=?"
            " WHERE id=?",
            (body.title, body.start_date, body.end_date, body.location, body.notes, vac_id))
        if body.reminder_offsets is not None:
            _replace_reminders(conn, "vacation_start", vac_id, body.reminder_offsets)
        conn.commit()
        return dict(conn.execute("SELECT * FROM vacations WHERE id = ?",
                                 (vac_id,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/vacations/{vac_id}", dependencies=[protected])
def delete_vacation(vac_id: int):
    conn = db.connect()
    try:
        conn.execute("DELETE FROM reminders WHERE target_kind='vacation_start'"
                     " AND target_id = ?", (vac_id,))
        conn.execute("DELETE FROM vacations WHERE id = ?", (vac_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- notas rápidas

@app.get("/api/notes", dependencies=[protected])
def list_notes():
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM notes ORDER BY COALESCE(updated_at, created_at) DESC, id DESC")]
    finally:
        conn.close()


@app.post("/api/notes", dependencies=[protected])
def create_note(body: NoteIn):
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="empty_note")
    conn = db.connect()
    try:
        cur = conn.execute("INSERT INTO notes (content) VALUES (?)",
                           (body.content.strip(),))
        conn.commit()
        return dict(conn.execute("SELECT * FROM notes WHERE id = ?",
                                 (cur.lastrowid,)).fetchone())
    finally:
        conn.close()


@app.put("/api/notes/{note_id}", dependencies=[protected])
def update_note(note_id: int, body: NoteIn):
    conn = db.connect()
    try:
        if not conn.execute("SELECT 1 FROM notes WHERE id = ?", (note_id,)).fetchone():
            raise HTTPException(status_code=404)
        conn.execute(
            "UPDATE notes SET content=?, updated_at=datetime('now','localtime') WHERE id=?",
            (body.content.strip(), note_id))
        conn.commit()
        return dict(conn.execute("SELECT * FROM notes WHERE id = ?",
                                 (note_id,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/notes/{note_id}", dependencies=[protected])
def delete_note(note_id: int):
    conn = db.connect()
    try:
        conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- grupos de tareas

@app.get("/api/task-groups", dependencies=[protected])
def list_task_groups():
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT id, name, slug, position, builtin FROM task_groups"
            " ORDER BY position, id")]
    finally:
        conn.close()


@app.post("/api/task-groups", dependencies=[protected])
def create_task_group(body: TaskGroupIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="empty_name")
    conn = db.connect()
    try:
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM task_groups").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO task_groups (name, position) VALUES (?, ?)", (name, pos))
        conn.commit()
        return dict(conn.execute(
            "SELECT id, name, slug, position, builtin FROM task_groups WHERE id = ?",
            (cur.lastrowid,)).fetchone())
    finally:
        conn.close()


@app.put("/api/task-groups/{group_id}", dependencies=[protected])
def update_task_group(group_id: int, body: TaskGroupIn):
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT builtin FROM task_groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
        if row["builtin"]:
            raise HTTPException(status_code=400, detail="builtin_group")
        conn.execute("UPDATE task_groups SET name = ? WHERE id = ?",
                     (body.name.strip(), group_id))
        conn.commit()
        return dict(conn.execute(
            "SELECT id, name, slug, position, builtin FROM task_groups WHERE id = ?",
            (group_id,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/task-groups/{group_id}", dependencies=[protected])
def delete_task_group(group_id: int):
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT builtin FROM task_groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
        if row["builtin"]:
            raise HTTPException(status_code=400, detail="builtin_group")
        # Las tareas del grupo pasan a 'Hoy' en vez de borrarse.
        conn.execute("UPDATE todos SET group_id = ? WHERE group_id = ?",
                     (db.hoy_group_id(conn), group_id))
        conn.execute("DELETE FROM task_groups WHERE id = ?", (group_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- lista de tareas

@app.get("/api/todos", dependencies=[protected])
def list_todos():
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM todos ORDER BY done, id DESC")]
    finally:
        conn.close()


@app.post("/api/todos", dependencies=[protected])
def create_todo(body: TodoIn):
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="empty_todo")
    conn = db.connect()
    try:
        group_id = body.group_id if body.group_id is not None else db.hoy_group_id(conn)
        recurrence = body.recurrence if body.recurrence in recur.FREQS else None
        rec_interval = max(1, body.rec_interval or 1) if recurrence else 1
        due = (body.due or date.today().isoformat()) if recurrence else None
        cur = conn.execute(
            "INSERT INTO todos (content, done, group_id, recurrence, rec_interval, due)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (body.content.strip(), int(body.done), group_id, recurrence, rec_interval, due))
        conn.commit()
        return dict(conn.execute("SELECT * FROM todos WHERE id = ?",
                                 (cur.lastrowid,)).fetchone())
    finally:
        conn.close()


@app.put("/api/todos/{todo_id}/recurrence", dependencies=[protected])
def set_todo_recurrence(todo_id: int, body: TodoRecurrenceIn):
    """Fija/quita la recurrencia de una tarea sin tocar su contenido/estado."""
    conn = db.connect()
    try:
        if not conn.execute("SELECT 1 FROM todos WHERE id = ?", (todo_id,)).fetchone():
            raise HTTPException(status_code=404)
        recurrence = body.recurrence if body.recurrence in recur.FREQS else None
        if recurrence:
            rec_interval = max(1, body.rec_interval or 1)
            due = body.due or date.today().isoformat()
        else:
            rec_interval, due = 1, None
        conn.execute("UPDATE todos SET recurrence=?, rec_interval=?, due=? WHERE id=?",
                     (recurrence, rec_interval, due, todo_id))
        conn.commit()
        return dict(conn.execute("SELECT * FROM todos WHERE id = ?",
                                 (todo_id,)).fetchone())
    finally:
        conn.close()


@app.put("/api/todos/{todo_id}", dependencies=[protected])
def update_todo(todo_id: int, body: TodoIn):
    conn = db.connect()
    try:
        existing = conn.execute(
            "SELECT group_id FROM todos WHERE id = ?", (todo_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404)
        group_id = body.group_id if body.group_id is not None else existing["group_id"]
        conn.execute("UPDATE todos SET content=?, done=?, group_id=? WHERE id=?",
                     (body.content.strip(), int(body.done), group_id, todo_id))
        conn.commit()
        return dict(conn.execute("SELECT * FROM todos WHERE id = ?",
                                 (todo_id,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/todos/{todo_id}", dependencies=[protected])
def delete_todo(todo_id: int):
    conn = db.connect()
    try:
        conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.post("/api/todos/clear-done", dependencies=[protected])
def clear_done_todos():
    conn = db.connect()
    try:
        conn.execute("DELETE FROM todos WHERE done = 1")
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- compañeros

@app.get("/api/teammates", dependencies=[protected])
def list_teammates():
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM teammates ORDER BY name")]
    finally:
        conn.close()


@app.post("/api/teammates", dependencies=[protected])
def create_teammate(body: TeammateIn):
    conn = db.connect()
    try:
        cur = conn.execute("INSERT INTO teammates (name, color) VALUES (?, ?)",
                           (body.name.strip(), body.color))
        conn.commit()
        return {"id": cur.lastrowid, "name": body.name.strip(), "color": body.color}
    finally:
        conn.close()


@app.put("/api/teammates/{teammate_id}", dependencies=[protected])
def update_teammate(teammate_id: int, body: TeammateIn):
    conn = db.connect()
    try:
        conn.execute("UPDATE teammates SET name=?, color=? WHERE id=?",
                     (body.name.strip(), body.color, teammate_id))
        conn.commit()
        return {"id": teammate_id, "name": body.name.strip(), "color": body.color}
    finally:
        conn.close()


@app.delete("/api/teammates/{teammate_id}", dependencies=[protected])
def delete_teammate(teammate_id: int):
    conn = db.connect()
    try:
        conn.execute("DELETE FROM teammates WHERE id = ?", (teammate_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- tipos

@app.get("/api/audit-types", dependencies=[protected])
def list_audit_types():
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM audit_types ORDER BY id")]
    finally:
        conn.close()


@app.post("/api/audit-types", dependencies=[protected])
def create_audit_type(body: AuditTypeIn):
    conn = db.connect()
    try:
        cur = conn.execute(
            "INSERT INTO audit_types (name_es, name_en, color) VALUES (?,?,?)",
            (body.name_es, body.name_en, body.color))
        conn.commit()
        return dict(conn.execute("SELECT * FROM audit_types WHERE id = ?",
                                 (cur.lastrowid,)).fetchone())
    finally:
        conn.close()


@app.put("/api/audit-types/{type_id}", dependencies=[protected])
def update_audit_type(type_id: int, body: AuditTypeIn):
    conn = db.connect()
    try:
        conn.execute("UPDATE audit_types SET name_es=?, name_en=?, color=? WHERE id=?",
                     (body.name_es, body.name_en, body.color, type_id))
        conn.commit()
        return dict(conn.execute("SELECT * FROM audit_types WHERE id = ?",
                                 (type_id,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/audit-types/{type_id}", dependencies=[protected])
def delete_audit_type(type_id: int):
    conn = db.connect()
    try:
        row = conn.execute("SELECT builtin FROM audit_types WHERE id = ?",
                           (type_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404)
        if row["builtin"]:
            raise HTTPException(status_code=400, detail="builtin_type")
        if conn.execute("SELECT 1 FROM audits WHERE type_id = ? LIMIT 1",
                        (type_id,)).fetchone():
            raise HTTPException(status_code=409, detail="type_in_use")
        conn.execute("DELETE FROM audit_types WHERE id = ?", (type_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- recordatorios

@app.get("/api/reminders", dependencies=[protected])
def list_reminders(target_kind: str | None = None, target_id: int | None = None):
    conn = db.connect()
    try:
        if target_kind and target_id is not None:
            rows = conn.execute(
                "SELECT * FROM reminders WHERE target_kind=? AND target_id=?"
                " ORDER BY offset_min", (target_kind, target_id))
        else:
            rows = conn.execute("SELECT * FROM reminders ORDER BY id")
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.post("/api/reminders", dependencies=[protected])
def create_reminder(body: ReminderIn):
    if body.target_kind not in ("event", "audit_start", "report_start", "vacation_start"):
        raise HTTPException(status_code=400, detail="bad_kind")
    conn = db.connect()
    try:
        cur = conn.execute(
            "INSERT INTO reminders (target_kind, target_id, offset_min) VALUES (?,?,?)",
            (body.target_kind, body.target_id, body.offset_min))
        conn.commit()
        return dict(conn.execute("SELECT * FROM reminders WHERE id = ?",
                                 (cur.lastrowid,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/reminders/{reminder_id}", dependencies=[protected])
def delete_reminder(reminder_id: int):
    conn = db.connect()
    try:
        conn.execute("DELETE FROM reminders WHERE id = ?", (reminder_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/reminders/due", dependencies=[protected])
def reminders_due():
    """Avisos vencidos y aún no entregados, para mostrarlos en el navegador.

    No marca nada: el navegador confirma con POST /api/reminders/ack. Solo llegan
    aquí los que el canal de escritorio no entregó (fired_at sigue nulo)."""
    conn = db.connect()
    try:
        user = db.get_user(conn)
        lang = user["lang"] if user else "es"
        now = datetime.now()
        out = []
        for rem in conn.execute("SELECT * FROM reminders WHERE fired_at IS NULL").fetchall():
            target = notifier._target_datetime(conn, rem["target_kind"], rem["target_id"])
            if target is None:
                continue
            if now < target - timedelta(minutes=rem["offset_min"]):
                continue
            msg = notifier._build_message(conn, rem["target_kind"], rem["target_id"], lang)
            if msg:
                out.append({"id": rem["id"], "title": msg[0], "body": msg[1]})
        return out
    finally:
        conn.close()


@app.post("/api/reminders/ack", dependencies=[protected])
def ack_reminders(body: AckIn):
    if not body.ids:
        return {"ok": True, "acked": 0}
    conn = db.connect()
    try:
        now = datetime.now().isoformat(timespec="seconds")
        placeholders = ",".join("?" * len(body.ids))
        conn.execute(
            f"UPDATE reminders SET fired_at = ? WHERE id IN ({placeholders})"
            " AND fired_at IS NULL",
            [now, *body.ids])
        conn.commit()
        return {"ok": True, "acked": len(body.ids)}
    finally:
        conn.close()


# ---------------------------------------------------------------- ajustes

@app.get("/api/settings", dependencies=[protected])
def get_settings():
    conn = db.connect()
    try:
        user = db.get_user(conn)
        return {
            "username": user["username"],
            "lang": user["lang"],
            "default_reminders": json.loads(user["default_reminders"]),
        }
    finally:
        conn.close()


@app.put("/api/settings", dependencies=[protected])
def update_settings(body: SettingsIn):
    conn = db.connect()
    try:
        if body.lang is not None:
            if body.lang not in ("es", "en"):
                raise HTTPException(status_code=400, detail="bad_lang")
            conn.execute("UPDATE user SET lang = ? WHERE id = 1", (body.lang,))
        if body.default_reminders is not None:
            conn.execute("UPDATE user SET default_reminders = ? WHERE id = 1",
                         (json.dumps(body.default_reminders),))
        conn.commit()
        return get_settings()
    finally:
        conn.close()


# ---------------------------------------------------------------- calendario

@app.get("/api/calendar", dependencies=[protected])
def calendar(date_from: str, date_to: str):
    """Todo lo que cae en [date_from, date_to] (fechas YYYY-MM-DD) en una llamada."""
    conn = db.connect()
    try:
        audits = [
            _audit_dict(conn, r)
            for r in conn.execute(
                "SELECT * FROM audits WHERE audit_start <= ? AND "
                "COALESCE(report_end, audit_end) >= ?", (date_to, date_from))
        ]
        events = [dict(r) for r in conn.execute(
            "SELECT * FROM events WHERE date(datetime) BETWEEN ? AND ? ORDER BY datetime",
            (date_from, date_to))]
        vacations = [dict(r) for r in conn.execute(
            "SELECT * FROM vacations WHERE start_date <= ? AND end_date >= ?",
            (date_to, date_from))]
        types = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM audit_types")}
        teammates = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM teammates")}
        return {"audits": audits, "events": events, "vacations": vacations,
                "types": types, "teammates": teammates}
    finally:
        conn.close()


# ---------------------------------------------------------------- gestión de horas

@app.get("/api/time/categories", dependencies=[protected])
def list_time_categories():
    conn = db.connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT id, name, color FROM time_categories WHERE archived = 0 ORDER BY name")]
    finally:
        conn.close()


@app.post("/api/time/categories", dependencies=[protected])
def create_time_category(body: TimeCategoryIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="empty_name")
    conn = db.connect()
    try:
        cur = conn.execute(
            "INSERT INTO time_categories (name, color) VALUES (?, ?)", (name, body.color))
        conn.commit()
        return dict(conn.execute(
            "SELECT id, name, color FROM time_categories WHERE id = ?",
            (cur.lastrowid,)).fetchone())
    finally:
        conn.close()


@app.put("/api/time/categories/{cat_id}", dependencies=[protected])
def update_time_category(cat_id: int, body: TimeCategoryIn):
    conn = db.connect()
    try:
        if not conn.execute(
                "SELECT 1 FROM time_categories WHERE id = ?", (cat_id,)).fetchone():
            raise HTTPException(status_code=404)
        conn.execute("UPDATE time_categories SET name=?, color=? WHERE id=?",
                     (body.name.strip(), body.color, cat_id))
        conn.commit()
        return dict(conn.execute(
            "SELECT id, name, color FROM time_categories WHERE id = ?",
            (cat_id,)).fetchone())
    finally:
        conn.close()


@app.delete("/api/time/categories/{cat_id}", dependencies=[protected])
def delete_time_category(cat_id: int):
    conn = db.connect()
    try:
        conn.execute("DELETE FROM time_categories WHERE id = ?", (cat_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/time/week", dependencies=[protected])
def time_week(start: str):
    """Rejilla semanal: 'start' es el lunes (YYYY-MM-DD)."""
    try:
        start_d = datetime.strptime(start, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="bad_date")
    days = [(start_d + timedelta(days=i)).isoformat() for i in range(7)]
    conn = db.connect()
    try:
        categories = [dict(r) for r in conn.execute(
            "SELECT id, name, color FROM time_categories WHERE archived = 0 ORDER BY name")]
        audits = [dict(r) for r in conn.execute(
            "SELECT a.id, a.title, a.audit_start, a.audit_end, a.report_start,"
            " a.report_end, t.color AS color FROM audits a"
            " JOIN audit_types t ON t.id = a.type_id ORDER BY a.audit_start DESC")]
        events = [dict(r) for r in conn.execute(
            "SELECT id, title, kind, datetime FROM events"
            " WHERE date(datetime) BETWEEN ? AND ? ORDER BY datetime",
            (days[0], days[-1]))]
        entries = [dict(r) for r in conn.execute(
            "SELECT day, audit_id, category_id, event_id, hours, note FROM time_entries"
            " WHERE day BETWEEN ? AND ?", (days[0], days[-1]))]
        return {"start": start, "days": days, "categories": categories,
                "audits": audits, "events": events, "entries": entries}
    finally:
        conn.close()


@app.put("/api/time/entry", dependencies=[protected])
def upsert_time_entry(body: TimeEntryIn):
    """Fija/actualiza la celda (tarea, día). hours<=0 borra la celda."""
    targets = {"audit_id": body.audit_id, "category_id": body.category_id,
               "event_id": body.event_id}
    chosen = [(c, v) for c, v in targets.items() if v is not None]
    if len(chosen) != 1:
        raise HTTPException(status_code=400, detail="need_exactly_one_target")
    col, val = chosen[0]
    conn = db.connect()
    try:
        existing = conn.execute(
            f"SELECT id FROM time_entries WHERE day = ? AND {col} = ?",
            (body.day, val)).fetchone()
        if body.hours is None or body.hours <= 0:
            if existing:
                conn.execute("DELETE FROM time_entries WHERE id = ?", (existing["id"],))
                conn.commit()
            return {"ok": True, "deleted": True}
        note = (body.note or "").strip() or None
        if existing:
            conn.execute("UPDATE time_entries SET hours = ?, note = ? WHERE id = ?",
                         (body.hours, note, existing["id"]))
        else:
            conn.execute(
                f"INSERT INTO time_entries (day, {col}, hours, note) VALUES (?, ?, ?, ?)",
                (body.day, val, body.hours, note))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- estáticos

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")
