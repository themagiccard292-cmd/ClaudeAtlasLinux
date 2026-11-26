"""Key-name normalisation plus per-backend key tables.

One canonical name per key (`ctrl`, `enter`, `f5`, `a`, ...) maps to:
  * a Linux evdev keycode  (ydotool / evdev hotkey listener)
  * an X keysym            (xdotool / wtype)
"""
from __future__ import annotations

from dataclasses import dataclass

from .errors import ActionError


@dataclass(frozen=True)
class KeySpec:
    name: str
    code: int  # linux/input-event-codes.h
    xkeysym: str


_SPECS: dict[str, KeySpec] = {}


def _add(name: str, code: int, keysym: str | None = None) -> None:
    _SPECS[name] = KeySpec(name, code, keysym or name)


# --- layout rows --------------------------------------------------------------
for _i, _c in enumerate("1234567890"):
    _add(_c, 2 + _i)
for _i, _c in enumerate("qwertyuiop"):
    _add(_c, 16 + _i)
for _i, _c in enumerate("asdfghjkl"):
    _add(_c, 30 + _i)
for _i, _c in enumerate("zxcvbnm"):
    _add(_c, 44 + _i)
for _i in range(1, 11):
    _add(f"f{_i}", 58 + _i, f"F{_i}")
_add("f11", 87, "F11")
_add("f12", 88, "F12")

# --- punctuation / editing / navigation -----------------------------------------
_add("esc", 1, "Escape")
_add("minus", 12)
_add("equal", 13)
_add("backspace", 14, "BackSpace")
_add("tab", 15, "Tab")
_add("bracketleft", 26)
_add("bracketright", 27)
_add("enter", 28, "Return")
_add("semicolon", 39)
_add("apostrophe", 40)
_add("grave", 41)
_add("backslash", 43)
_add("comma", 51)
_add("period", 52)
_add("slash", 53)
_add("space", 57)
_add("capslock", 58, "Caps_Lock")
_add("printscreen", 99, "Print")
_add("home", 102, "Home")
_add("up", 103, "Up")
_add("pageup", 104, "Page_Up")
_add("left", 105, "Left")
_add("right", 106, "Right")
_add("end", 107, "End")
_add("down", 108, "Down")
_add("pagedown", 109, "Page_Down")
_add("insert", 110, "Insert")
_add("delete", 111, "Delete")

# --- modifiers ------------------------------------------------------------------
_add("ctrl", 29, "ctrl")
_add("shift", 42, "shift")
_add("alt", 56, "alt")
_add("super", 125, "super")
_add("altgr", 100, "ISO_Level3_Shift")

MODIFIERS = frozenset({"ctrl", "shift", "alt", "super", "altgr"})

_ALIASES = {
    "control": "ctrl", "ctl": "ctrl", "lctrl": "ctrl", "rctrl": "ctrl", "control_l": "ctrl",
    "control_r": "ctrl", "ctrl_l": "ctrl", "ctrl_r": "ctrl",
    "option": "alt", "opt": "alt", "lalt": "alt", "ralt": "alt", "alt_l": "alt", "alt_r": "alt",
    "shift_l": "shift", "shift_r": "shift", "lshift": "shift", "rshift": "shift",
    "win": "super", "windows": "super", "meta": "super", "cmd": "super", "command": "super",
    "super_l": "super", "super_r": "super", "lsuper": "super", "rsuper": "super", "logo": "super",
    "alt_gr": "altgr", "iso_level3_shift": "altgr",
    "return": "enter", "ret": "enter", "kp_enter": "enter",
    "escape": "esc",
    "del": "delete", "ins": "insert",
    "pgup": "pageup", "page_up": "pageup", "prior": "pageup",
    "pgdn": "pagedown", "page_down": "pagedown", "next": "pagedown",
    "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right",
    "spacebar": "space", "bksp": "backspace", "caps": "capslock", "caps_lock": "capslock",
    "print": "printscreen", "prtsc": "printscreen",
    "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", ";": "semicolon",
    "'": "apostrophe", "`": "grave", "\\": "backslash", ",": "comma", ".": "period", "/": "slash",
    " ": "space", "\n": "enter", "\t": "tab",
}

# Reverse lookup used by the evdev hotkey listener (both left/right variants).
CODE_TO_NAME: dict[int, str] = {spec.code: name for name, spec in _SPECS.items()}
CODE_TO_NAME.update({97: "ctrl", 54: "shift", 126: "super", 100: "alt"})

_WTYPE_MODS = {"ctrl": "ctrl", "shift": "shift", "alt": "alt", "super": "logo", "altgr": "altgr"}


def normalize(name: str) -> str:
    key = str(name).strip().lower()
    if not key:
        raise ActionError("Empty key name")
    key = _ALIASES.get(key, key)
    if key not in _SPECS:
        raise ActionError(f"Unknown key: {name!r}")
    return key


def split_combo(combo: str | list[str] | tuple[str, ...]) -> list[str]:
    """'Ctrl+Shift+T' / ['ctrl','shift','t'] -> ['ctrl','shift','t']."""
    if isinstance(combo, (list, tuple)):
        parts = [str(p) for p in combo]
    else:
        text = str(combo).strip()
        if text == "+":
            parts = ["+"]
        else:
            parts = [p for p in text.replace(" ", "").split("+") if p]
    if not parts:
        raise ActionError("Empty hotkey")
    return [normalize(p) for p in parts]


def spec(name: str) -> KeySpec:
    return _SPECS[normalize(name)]


def xdotool_combo(keys: list[str]) -> str:
    return "+".join(_SPECS[k].xkeysym for k in keys)


def ydotool_events(keys: list[str]) -> list[str]:
    codes = [_SPECS[k].code for k in keys]
    return [f"{c}:1" for c in codes] + [f"{c}:0" for c in reversed(codes)]


def wtype_args(keys: list[str]) -> list[str]:
    mods = [k for k in keys if k in MODIFIERS]
    normal = [k for k in keys if k not in MODIFIERS]
    args: list[str] = []
    for m in mods:
        args += ["-M", _WTYPE_MODS[m]]
    for k in normal or []:
        args += ["-k", _SPECS[k].xkeysym]
    for m in reversed(mods):
        args += ["-m", _WTYPE_MODS[m]]
    return args


def includes_escape(keys: list[str]) -> bool:
    return "esc" in keys
