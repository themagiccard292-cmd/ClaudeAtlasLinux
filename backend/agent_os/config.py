"""Paths, frozen-binary helpers and environment overrides."""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "claude-os-agent"


def is_frozen() -> bool:
    """True when running inside the PyInstaller `backend-linux` binary."""
    return bool(getattr(sys, "frozen", False))


def package_dir() -> Path:
    # Works both from source and from PyInstaller's extraction dir, because
    # PyInstaller rewrites __file__ to live under sys._MEIPASS.
    return Path(__file__).resolve().parent


def _xdg(var: str, fallback: str) -> Path:
    base = os.environ.get(var)
    return Path(base) if base else Path.home() / fallback


def config_dir() -> Path:
    p = _xdg("XDG_CONFIG_HOME", ".config") / APP_NAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def cache_dir() -> Path:
    p = _xdg("XDG_CACHE_HOME", ".cache") / APP_NAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def models_dir() -> Path:
    p = cache_dir() / "models"
    p.mkdir(parents=True, exist_ok=True)
    return p


def env_choice(name: str, default: str = "auto") -> str:
    return os.environ.get(name, default).strip().lower() or default
