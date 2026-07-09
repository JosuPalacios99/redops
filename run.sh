#!/usr/bin/env bash
# Arranca la agenda en http://127.0.0.1:8666
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
    if ! python3 -m venv .venv 2>/dev/null; then
        # Sistemas sin ensurepip (falta python3-venv): bootstrap con get-pip
        python3 -m venv --without-pip .venv
        TMP_PIP="$(mktemp)"
        wget -q https://bootstrap.pypa.io/get-pip.py -O "$TMP_PIP" \
            || curl -sSL https://bootstrap.pypa.io/get-pip.py -o "$TMP_PIP"
        .venv/bin/python "$TMP_PIP" --quiet
        rm -f "$TMP_PIP"
    fi
    .venv/bin/pip install --quiet -r requirements.txt
fi

exec .venv/bin/uvicorn server.main:app --host 127.0.0.1 --port "${AGENDA_PORT:-8666}"
