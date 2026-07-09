# 🎯 RedOps — Agenda local para Red Teaming

Webapp local y ligera para gestionar auditorías, reuniones, tareas y avisos.
Backend en FastAPI + SQLite, frontend vanilla sin build step. Todo corre en tu
máquina y escucha **solo en localhost**.

## Requisitos

- **Python 3.10 o superior.**
  - Linux (Debian/Ubuntu): `sudo apt install python3 python3-venv`.
  - Windows: instala Python desde
    <https://www.python.org/downloads/windows/> y marca
    **«Add python.exe to PATH»** en la primera pantalla del instalador.
  - macOS: `brew install python` (o el instalador oficial).
- Un navegador. Nada más: las dependencias de Python (`fastapi`, `uvicorn`) se
  instalan solas en un entorno virtual la primera vez.

## Arranque

**Linux / macOS:**

```bash
./run.sh
```

**Windows:** doble clic en **`run.bat`** (o ejecútalo desde `cmd`/PowerShell).

La primera vez crea un entorno virtual e instala las dependencias. Después abre
<http://127.0.0.1:8666>.

En el primer arranque la app te pide crear tu usuario y contraseña
(mínimo 8 caracteres). Los datos se guardan en `agenda.db` (SQLite) en este
mismo directorio.

Para usar otro puerto:

- Linux/macOS: `AGENDA_PORT=9000 ./run.sh`
- Windows (`cmd`): `set AGENDA_PORT=9000 && run.bat`

## Qué hace

- **Auditorías** con tipo, ubicación, periodo de auditoría y periodo de
  informe (se pintan como barras en el calendario: fase de ejecución sólida,
  fase de informe rayada), estado y compañeros asignados.
- **Reuniones** (kickoff, presentación de resultados…) opcionalmente ligadas a
  una auditoría, **tareas** sueltas y **vacaciones** (barras propias en el
  calendario, con aviso opcional antes de que empiecen).
- **Notas rápidas** (📝 en la cabecera): captura ideas al vuelo, edítalas o
  bórralas; las últimas aparecen en el panel lateral.
- **Modo claro / oscuro** (◐ en la cabecera) y **ubicaciones abribles en
  Google Maps** (📍 / 🗺).
- **Tipos de auditoría** integrados: simulación de adversarios, hacking ético
  interno, hacking ético externo, análisis de vulnerabilidades. Puedes añadir
  más desde Ajustes → Tipos.
- **Gestión de horas**: rejilla semanal para imputar las horas dedicadas a cada
  auditoría, reunión, tarea o categoría propia (formación, gestión…); totales
  por día y por tarea y botón para copiar el resumen de la semana.
- **Avisos** con dos canales automáticos: en Linux/macOS nativos, aviso de
  escritorio (`notify-send` / `osascript`) que salta aunque el navegador esté
  cerrado. Donde eso no está disponible (WSL, Windows), el aviso lo muestra el
  **navegador** (Web Notifications) mientras haya una pestaña de RedOps abierta
  —acepta el permiso de notificaciones la primera vez—. Nunca se duplica: cada
  aviso lo entrega un solo canal. Cada elemento admite varios avisos (15 min,
  1 h, 1 día, 1 semana antes o un valor personalizado) y en Ajustes se
  configuran los avisos por defecto.
- **Español / English** conmutable desde la cabecera.
- **Login** con sesión de 30 días (cookie HttpOnly, PBKDF2 para la contraseña).

## Arranque automático al encender (opcional)

Para que la app (y por tanto los avisos) arranque sola al iniciar sesión, sin
lanzar nada a mano.

### Linux — unidad systemd de usuario

```ini
# ~/.config/systemd/user/redops.service
[Unit]
Description=RedOps

[Service]
ExecStart=%h/Documents/Tools/redops/run.sh
Restart=on-failure

[Install]
WantedBy=default.target
```

Ajusta `ExecStart` a la ruta real de tu `run.sh`, luego:

```bash
systemctl --user daemon-reload
systemctl --user enable --now redops
```

### Windows — carpeta de inicio o Programador de tareas

Opción sencilla (arranca al iniciar sesión):

1. Pulsa `Win + R`, escribe `shell:startup` y pulsa Enter.
2. Crea en esa carpeta un acceso directo a `run.bat`.
   - Para que no deje una ventana de consola abierta, apunta el acceso directo a:
     `cmd /c start "" /min "C:\ruta\a\redops\run.bat"`

Opción con **Programador de tareas** (arranca aunque no haya sesión iniciada):
crea una tarea básica con desencadenante «Al iniciar el equipo» y acción
«Iniciar programa» → `run.bat`. Marca «Ejecutar tanto si el usuario inició
sesión como si no» solo si no necesitas ver las notificaciones (los globos de la
bandeja requieren una sesión de escritorio activa).

## Estructura

```
server/   API FastAPI (auth, CRUD, calendario) + notificador en segundo plano
static/   SPA: HTML, CSS, JS e i18n (es/en)
agenda.db Base de datos SQLite (se crea sola; haz backup de este fichero)
```
