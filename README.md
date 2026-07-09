# 🎯 RedOps — Agenda local para Red Teaming

Webapp local y ligera para gestionar auditorías, reuniones, tareas y avisos.
Backend en FastAPI + SQLite, frontend vanilla sin build step. Todo corre en tu
máquina y escucha **solo en localhost**.

## Arranque

```bash
./run.sh
```

La primera vez crea un entorno virtual e instala las dependencias
(`fastapi`, `uvicorn`). Después abre <http://127.0.0.1:8666>.

En el primer arranque la app te pide crear tu usuario y contraseña
(mínimo 8 caracteres). Los datos se guardan en `agenda.db` (SQLite) en este
mismo directorio.

Para usar otro puerto: `AGENDA_PORT=9000 ./run.sh`.

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
- **Avisos de escritorio** vía `notify-send`: saltan aunque el navegador esté
  cerrado, mientras el servidor corra. Cada elemento admite varios avisos
  (15 min, 1 h, 1 día, 1 semana antes o un valor personalizado) y en Ajustes
  se configuran los avisos por defecto.
- **Español / English** conmutable desde la cabecera.
- **Login** con sesión de 30 días (cookie HttpOnly, PBKDF2 para la contraseña).

## Notificaciones siempre activas (opcional)

Para que los avisos salten sin tener que arrancar nada a mano, crea una unidad
systemd de usuario:

```ini
# ~/.config/systemd/user/redops.service
[Unit]
Description=RedOps

[Service]
ExecStart=%h/Documents/agenda/run.sh
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now redops
```

## Estructura

```
server/   API FastAPI (auth, CRUD, calendario) + notificador en segundo plano
static/   SPA: HTML, CSS, JS e i18n (es/en)
agenda.db Base de datos SQLite (se crea sola; haz backup de este fichero)
```
