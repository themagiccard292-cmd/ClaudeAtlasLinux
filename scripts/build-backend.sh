#!/usr/bin/env bash
# Compile the Python OS-automation backend into a standalone ELF: backend/dist/backend-linux
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
VENV="${ATLAS_VENV:-$BACKEND/.venv}"
PY="${PYTHON:-python3}"

say() { printf '\033[1;34m[backend]\033[0m %s\n' "$*"; }

if [[ ! -x "$VENV/bin/python" ]]; then
  say "Creating virtualenv at $VENV"
  "$PY" -m venv "$VENV"
fi

if [[ "${SKIP_PIP:-0}" != "1" ]]; then
  say "Installing Python dependencies"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet -r "$BACKEND/requirements.txt" pyinstaller
  if [[ "${WITH_PIPER:-1}" == "1" ]]; then
    "$VENV/bin/python" -m pip install --quiet -r "$BACKEND/requirements-optional.txt" piper-tts \
      || say "piper-tts unavailable — offline TTS fallback will be espeak-ng only"
  fi
fi

say "Running PyInstaller"
rm -rf "$BACKEND/dist" "$BACKEND/build"
"$VENV/bin/python" -m PyInstaller --noconfirm --clean \
  --distpath "$BACKEND/dist" --workpath "$BACKEND/build" \
  "$BACKEND/backend-linux.spec"

chmod +x "$BACKEND/dist/backend-linux"
say "Smoke test: $("$BACKEND/dist/backend-linux" --version)"
say "Built $(du -h "$BACKEND/dist/backend-linux" | cut -f1)  →  backend/dist/backend-linux"
