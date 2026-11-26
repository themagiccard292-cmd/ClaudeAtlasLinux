# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec -> single-file ELF `backend/dist/backend-linux`.

Build (from the repo root):

    pyinstaller --noconfirm --clean \
        --distpath backend/dist --workpath backend/build \
        backend/backend-linux.spec

The binary is bundled into the Electron app via electron-builder `extraResources`.
Things deliberately NOT frozen in:
  * PyGObject / AT-SPI  -> `agent_os/atspi_helper.py` runs under the *system* Python
  * PortAudio           -> system `libportaudio2`
  * Whisper / Piper voice models -> downloaded to ~/.cache/claude-os-agent on first use
"""
import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

HERE = SPECPATH  # directory containing this spec (provided by PyInstaller)

datas = [(os.path.join(HERE, "agent_os", "atspi_helper.py"), "agent_os")]
binaries = []
hiddenimports = []

# Packages that ship native libs / data files / dynamic imports.
for pkg in ("faster_whisper", "ctranslate2", "onnxruntime", "av", "edge_tts", "tokenizers",
            "sounddevice", "mss", "evdev", "piper"):
    try:
        d, b, h = collect_all(pkg)
    except Exception:  # optional / not installed (e.g. piper-tts)
        continue
    datas += d
    binaries += b
    hiddenimports += h

# Packages with import-by-string plugin loading.
for pkg in ("uvicorn", "websockets", "pynput", "Xlib", "jeepney", "anyio", "h11", "starlette", "fastapi"):
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception:
        pass

hiddenimports += [
    "agent_os", "agent_os.context", "agent_os.rpc", "agent_os.voice.manager",
    "pynput.keyboard._xorg", "pynput.mouse._xorg", "pynput._util.xorg",
]

a = Analysis(
    [os.path.join(HERE, "server.py")],
    pathex=[HERE],
    binaries=binaries,
    datas=datas,
    hiddenimports=sorted(set(hiddenimports)),
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "torch", "scipy", "pandas", "PyQt5", "PyQt6", "PySide2", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="backend-linux",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX breaks some of the bundled .so files
    runtime_tmpdir=None,
    console=True,       # Electron reads the READY line from stdout
    disable_windowed_traceback=False,
)
