#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────────────────────
#  Claude OS Agent — one-click Linux build
#
#    ./build.sh                       full build  →  release/Claude-OS-Agent.AppImage + release/claude-os-agent.deb
#    ./build.sh --install-system-deps apt-get install the build/runtime packages first (uses sudo)
#    ./build.sh --appimage-only | --deb-only
#    ./build.sh --skip-backend        reuse an existing backend/dist/backend-linux
#    ./build.sh --skip-pip            don't (re)install Python packages
#    ./build.sh --no-piper            skip the optional offline TTS engine (smaller binary)
#
#  Pipeline:  Python venv → PyInstaller (backend-linux ELF) → Vite (React) + tsc (Electron main)
#             → electron-builder (bundles backend-linux via extraResources) → AppImage + deb
# ──────────────────────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

TARGETS="AppImage deb"
SKIP_BACKEND=0; SKIP_PIP=0; WITH_PIPER=1; INSTALL_SYS=0

for arg in "$@"; do
  case "$arg" in
    --install-system-deps) INSTALL_SYS=1 ;;
    --appimage-only)       TARGETS="AppImage" ;;
    --deb-only)            TARGETS="deb" ;;
    --skip-backend)        SKIP_BACKEND=1 ;;
    --skip-pip)            SKIP_PIP=1 ;;
    --no-piper)            WITH_PIPER=0 ;;
    -h|--help)             sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "This project builds Linux packages; run it on Linux."

# ── system packages ───────────────────────────────────────────────────────────────────────────
# build:   python3-venv python3-pip nodejs npm fakeroot dpkg (+ libportaudio2 so sounddevice imports)
# runtime: xdotool x11-xserver-utils (X11) · ydotool wtype grim (Wayland) · python3-gi gir1.2-atspi-2.0
#          python3-pyatspi at-spi2-core (accessibility) · libasound2 libportaudio2 (audio) · espeak-ng (TTS fallback)
SYSTEM_PKGS=(python3 python3-venv python3-pip nodejs npm fakeroot dpkg libasound2-dev libportaudio2 portaudio19-dev
             xdotool x11-xserver-utils ydotool wtype grim espeak-ng python3-gi gir1.2-atspi-2.0 python3-pyatspi
             at-spi2-core libgtk-3-0 libnss3 libxss1 libxtst6 xdg-utils libsecret-1-0)
if [[ $INSTALL_SYS -eq 1 ]]; then
  command -v apt-get >/dev/null || die "--install-system-deps needs apt (Debian/Ubuntu). Install equivalents manually."
  say "Installing system packages (sudo)"
  sudo apt-get update
  # a few are optional on older releases (ydotool/wtype/grim) — install what exists
  for p in "${SYSTEM_PKGS[@]}"; do
    sudo apt-get install -y "$p" || warn "could not install $p (continuing)"
  done
fi

command -v node   >/dev/null || die "Node.js ≥ 20 is required (https://nodejs.org or apt install nodejs)"
command -v npm    >/dev/null || die "npm is required"
command -v python3 >/dev/null || die "python3 ≥ 3.9 is required"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ $NODE_MAJOR -ge 20 ]] || die "Node.js ≥ 20 required (found $(node -v))"
python3 - <<'PY' || die "python3 ≥ 3.9 with the venv module is required (apt install python3-venv)"
import sys, venv
sys.exit(0 if sys.version_info >= (3, 9) else 1)
PY
[[ "$TARGETS" == *deb* ]] && ! command -v dpkg >/dev/null && warn "dpkg not found: the .deb target may fail (apt install dpkg fakeroot)"
python3 -c "import ctypes.util,sys; sys.exit(0 if ctypes.util.find_library('portaudio') else 1)" \
  || warn "libportaudio2 not found — the bundled backend needs it at runtime for the microphone (apt install libportaudio2)"

# ── 1. Python backend → backend/dist/backend-linux ────────────────────────────────────────────
if [[ $SKIP_BACKEND -eq 0 ]]; then
  say "1/4  Compiling the Python OS-automation backend with PyInstaller"
  SKIP_PIP=$SKIP_PIP WITH_PIPER=$WITH_PIPER bash scripts/build-backend.sh
else
  [[ -x backend/dist/backend-linux ]] || die "--skip-backend given but backend/dist/backend-linux does not exist"
  say "1/4  Reusing existing backend/dist/backend-linux"
fi

# ── 2. JS dependencies ────────────────────────────────────────────────────────────────────────
say "2/4  Installing JavaScript dependencies"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

# ── 3. icons + app bundle ─────────────────────────────────────────────────────────────────────
say "3/4  Building the React UI and Electron main process"
[[ -f resources/icons/512x512.png ]] || python3 scripts/make-icons.py
npm run build

# ── 4. package ────────────────────────────────────────────────────────────────────────────────
say "4/4  Packaging with electron-builder (${TARGETS})"
# shellcheck disable=SC2086
npx electron-builder --linux $TARGETS --publish never

say "Done"
ls -lh release/*.AppImage release/*.deb 2>/dev/null | awk '{printf "   %s  %s\n", $5, $9}'
cat <<'EOF'

  Run it:     chmod +x release/Claude-OS-Agent.AppImage && ./release/Claude-OS-Agent.AppImage
  Install:    sudo apt install ./release/claude-os-agent.deb      (then launch "Claude OS Agent")

EOF
