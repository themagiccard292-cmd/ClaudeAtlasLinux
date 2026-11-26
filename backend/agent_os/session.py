"""X11 / Wayland session detection."""
from __future__ import annotations

import os
import shutil
from dataclasses import asdict, dataclass, field
from typing import Mapping

TOOLS = (
    "xdotool", "xrandr", "ydotool", "ydotoold", "wtype", "grim", "slurp",
    "swaymsg", "hyprctl", "wlr-randr", "gnome-screenshot", "spectacle",
    "espeak-ng", "piper", "bash",
)


@dataclass(frozen=True)
class DisplayEnv:
    kind: str  # "x11" | "wayland" | "headless"
    desktop: str = ""
    display: str | None = None
    wayland_display: str | None = None
    xwayland: bool = False
    detected_from: str = ""
    tools: dict[str, bool] = field(default_factory=dict)

    @property
    def is_wayland(self) -> bool:
        return self.kind == "wayland"

    @property
    def is_x11(self) -> bool:
        return self.kind == "x11"

    def to_dict(self) -> dict:
        return asdict(self)


def detect_session(environ: Mapping[str, str] | None = None, which=shutil.which) -> DisplayEnv:
    """Decide between X11 and Wayland.

    `$XDG_SESSION_TYPE` is authoritative; if it is missing/`tty` we fall back to
    `$WAYLAND_DISPLAY` and `$DISPLAY`. `ATLAS_SESSION_TYPE` forces a value.
    """
    env = os.environ if environ is None else environ
    forced = env.get("ATLAS_SESSION_TYPE", "").strip().lower()
    declared = env.get("XDG_SESSION_TYPE", "").strip().lower()
    display = env.get("DISPLAY") or None
    wayland_display = env.get("WAYLAND_DISPLAY") or None

    if forced in ("x11", "wayland"):
        kind, source = forced, "ATLAS_SESSION_TYPE"
    elif declared in ("x11", "wayland"):
        kind, source = declared, "XDG_SESSION_TYPE"
    elif wayland_display:
        kind, source = "wayland", "WAYLAND_DISPLAY"
    elif display:
        kind, source = "x11", "DISPLAY"
    else:
        kind, source = "headless", "none"

    desktop = env.get("XDG_CURRENT_DESKTOP", "")
    tools = {t: which(t) is not None for t in TOOLS}
    return DisplayEnv(
        kind=kind,
        desktop=desktop,
        display=display,
        wayland_display=wayland_display,
        xwayland=(kind == "wayland" and display is not None),
        detected_from=source,
        tools=tools,
    )
