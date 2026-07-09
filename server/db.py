"""Esquema SQLite y helpers de acceso. Sin ORM: sqlite3 de la stdlib."""
import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "agenda.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'es',
    default_reminders TEXT NOT NULL DEFAULT '[1440, 60]'
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_es TEXT NOT NULL,
    name_en TEXT NOT NULL,
    color TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS teammates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#8b949e'
);

CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type_id INTEGER NOT NULL REFERENCES audit_types(id),
    location TEXT,
    audit_start TEXT NOT NULL,
    audit_end TEXT NOT NULL,
    report_start TEXT,
    report_end TEXT,
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned','in_progress','reporting','done')),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS audit_teammates (
    audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    teammate_id INTEGER NOT NULL REFERENCES teammates(id) ON DELETE CASCADE,
    PRIMARY KEY (audit_id, teammate_id)
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('meeting','task')),
    audit_id INTEGER REFERENCES audits(id) ON DELETE SET NULL,
    datetime TEXT NOT NULL,
    duration_min INTEGER,
    location TEXT,
    notes TEXT,
    done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vacations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    location TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_kind TEXT NOT NULL
        CHECK (target_kind IN ('event','audit_start','report_start','vacation_start')),
    target_id INTEGER NOT NULL,
    offset_min INTEGER NOT NULL,
    fired_at TEXT
);

CREATE TABLE IF NOT EXISTS time_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#8b949e',
    archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    audit_id INTEGER REFERENCES audits(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES time_categories(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    hours REAL NOT NULL,
    note TEXT,
    CHECK ((audit_id IS NOT NULL) + (category_id IS NOT NULL) + (event_id IS NOT NULL) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entry_audit
    ON time_entries(day, audit_id) WHERE audit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entry_cat
    ON time_entries(day, category_id) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entry_event
    ON time_entries(day, event_id) WHERE event_id IS NOT NULL;
"""

BUILTIN_TYPES = [
    ("Simulación de adversarios", "Adversary simulation", "#f85149"),
    ("Hacking ético interno", "Internal ethical hacking", "#ff9838"),
    ("Hacking ético externo", "External ethical hacking", "#58a6ff"),
    ("Análisis de vulnerabilidades", "Vulnerability assessment", "#3fb950"),
]


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _migrate_reminders_check(conn: sqlite3.Connection) -> None:
    """BDs creadas antes de existir las vacaciones: ampliar el CHECK de reminders."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='reminders'"
    ).fetchone()
    if row and "vacation_start" not in row["sql"]:
        conn.executescript("""
            CREATE TABLE reminders_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_kind TEXT NOT NULL
                    CHECK (target_kind IN ('event','audit_start','report_start','vacation_start')),
                target_id INTEGER NOT NULL,
                offset_min INTEGER NOT NULL,
                fired_at TEXT
            );
            INSERT INTO reminders_new SELECT * FROM reminders;
            DROP TABLE reminders;
            ALTER TABLE reminders_new RENAME TO reminders;
        """)


def _migrate_time_entries_event(conn: sqlite3.Connection) -> None:
    """BDs con time_entries previo a poder imputar a eventos: añadir event_id."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='time_entries'"
    ).fetchone()
    if row and "event_id" not in row["sql"]:
        conn.executescript("""
            DROP INDEX IF EXISTS idx_time_entry_audit;
            DROP INDEX IF EXISTS idx_time_entry_cat;
            CREATE TABLE time_entries_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                day TEXT NOT NULL,
                audit_id INTEGER REFERENCES audits(id) ON DELETE CASCADE,
                category_id INTEGER REFERENCES time_categories(id) ON DELETE CASCADE,
                event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
                hours REAL NOT NULL,
                note TEXT,
                CHECK ((audit_id IS NOT NULL) + (category_id IS NOT NULL)
                       + (event_id IS NOT NULL) = 1)
            );
            INSERT INTO time_entries_new (id, day, audit_id, category_id, hours, note)
                SELECT id, day, audit_id, category_id, hours, note FROM time_entries;
            DROP TABLE time_entries;
            ALTER TABLE time_entries_new RENAME TO time_entries;
        """)


def init_db() -> None:
    conn = connect()
    try:
        _migrate_time_entries_event(conn)
        conn.executescript(SCHEMA)
        _migrate_reminders_check(conn)
        if conn.execute("SELECT COUNT(*) FROM audit_types").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO audit_types (name_es, name_en, color, builtin) VALUES (?, ?, ?, 1)",
                BUILTIN_TYPES,
            )
        conn.commit()
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


def get_user(conn: sqlite3.Connection):
    return conn.execute("SELECT * FROM user WHERE id = 1").fetchone()


def default_reminder_offsets(conn: sqlite3.Connection) -> list[int]:
    user = get_user(conn)
    if not user:
        return []
    try:
        offsets = json.loads(user["default_reminders"])
        return [int(o) for o in offsets]
    except (ValueError, TypeError):
        return []
