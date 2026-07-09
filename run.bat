@echo off
rem Arranca la agenda en http://127.0.0.1:8666
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creando entorno virtual...
    python -m venv .venv
    if errorlevel 1 (
        echo.
        echo ERROR: no se pudo crear el entorno virtual.
        echo Instala Python 3 desde https://www.python.org/downloads/windows/
        echo y marca "Add python.exe to PATH" durante la instalacion.
        pause
        exit /b 1
    )
    ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
    ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt
)

if "%AGENDA_PORT%"=="" set AGENDA_PORT=8666
echo Abriendo http://127.0.0.1:%AGENDA_PORT%
".venv\Scripts\python.exe" -m uvicorn server.main:app --host 127.0.0.1 --port %AGENDA_PORT%
