"""Confirmation policy.

Everything here is a *heuristic*, not a sandbox: it exists so the user gets a
chance to approve obviously destructive / outward-facing actions. The model is
also told to self-flag sensitive GUI actions with `requires_confirmation`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Risk:
    reason: str
    category: str  # privilege | destructive | system | email | financial | flagged | ui

    def to_dict(self) -> dict:
        return {"reason": self.reason, "category": self.category}


def _r(pattern: str, reason: str, category: str) -> tuple[re.Pattern, Risk]:
    return re.compile(pattern, re.IGNORECASE), Risk(reason, category)


_PKG = r"(?:apt(?:-get)?|aptitude|dpkg|dnf|yum|zypper|pacman|snap|flatpak|pip3?|pipx|npm|gem|brew)"

_BASH_RULES: list[tuple[re.Pattern, Risk]] = [
    _r(r"(?<![\w-])(?:sudo|doas|pkexec)(?![\w-])|(?<![\w-])su\s+(?:-\S*\s*)?(?:root|-)?(?:\s|$)",
       "Runs with elevated (root) privileges", "privilege"),
    _r(r"(?<![\w-])(?:rm|rmdir|unlink|shred|srm|wipe|trash(?:-put)?|gio\s+trash)(?![\w-])",
       "Deletes files or directories", "destructive"),
    _r(r"\bfind\b[^\n|;&]*\s-delete\b", "Deletes files found by `find`", "destructive"),
    _r(r"(?<![\w-])(?:truncate)(?![\w-])", "Truncates files", "destructive"),
    _r(r"\bmkfs(?:\.\w+)?\b|\bwipefs\b|\bfdisk\b|\bparted\b|\bsfdisk\b|\bcryptsetup\b",
       "Modifies disks or filesystems", "destructive"),
    _r(r"(?<![\w-])dd\s+[^|;&\n]*\bof=", "Writes raw data with dd", "destructive"),
    _r(r">\s*/dev/(?:sd|nvme|hd|vd|mmcblk)\w*", "Writes directly to a block device", "destructive"),
    _r(r">>?\s*/etc/|\btee\b[^|;&\n]*\s/etc/", "Modifies system configuration in /etc", "system"),
    _r(r"\b(?:shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b|\bsystemctl\s+(?:poweroff|reboot|halt|suspend|hibernate)\b",
       "Shuts down / reboots the machine", "system"),
    _r(r"\bsystemctl\s+(?:stop|disable|mask|kill|restart)\b|\bservice\s+\S+\s+(?:stop|restart)\b",
       "Changes system services", "system"),
    _r(rf"\b{_PKG}\b[^|;&\n]*\b(?:remove|purge|erase|uninstall|autoremove|--remove)\b|\bpacman\s+-R",
       "Uninstalls software", "destructive"),
    _r(r"(?<![\w-])(?:kill|pkill|killall|xkill)(?![\w-])", "Terminates processes", "system"),
    _r(r"\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b", "Pipes a download straight into a shell", "destructive"),
    _r(r"\bgit\s+(?:push\s+[^\n]*(?:--force|-f\b)|reset\s+--hard|clean\s+-\w*f|branch\s+-D|checkout\s+--\s)",
       "Rewrites or discards git history / work", "destructive"),
    _r(r"\b(?:chmod|chown|chgrp)\b[^|;&\n]*\s-\w*R", "Recursively changes permissions or ownership", "destructive"),
    _r(r":\s*\(\s*\)\s*\{", "Looks like a fork bomb", "destructive"),
    _r(r"\bcrontab\s+-r\b|\buserdel\b|\bgroupdel\b|\busermod\b|\bpasswd\b|\bvisudo\b", "Changes users or scheduled jobs", "system"),
    _r(r"\b(?:iptables|ip6tables|nft|ufw|firewall-cmd)\b", "Changes firewall rules", "system"),
    _r(r"\b(?:sendmail|mailx?|mutt|neomutt|msmtp|swaks|ssmtp)\b|mailto:|\bxdg-email\b|\bthunderbird\b[^\n]*-compose",
       "Sends an email", "email"),
    _r(r"\bscp\b|\brsync\b[^\n]*\S+@\S+:|\bsftp\b|\bftp\b|\bnc\b[^\n]*\s\d{2,5}\b",
       "Transfers data to another machine", "system"),
]

_UI_LABEL = re.compile(
    r"\b(send|pay|purchase|buy( now)?|place (?:your )?order|checkout|check out|confirm (?:order|payment|purchase)|"
    r"transfer|wire|donate|subscribe|delete|remove|erase|format|empty trash|uninstall|sign out|log ?out|"
    r"submit|publish|post|tweet|reply all)\b",
    re.IGNORECASE,
)

_RISKY_HOTKEYS = {
    frozenset({"ctrl", "alt", "delete"}): "Ctrl+Alt+Delete (session / power menu)",
    frozenset({"ctrl", "alt", "backspace"}): "Ctrl+Alt+Backspace (kills the X session)",
    frozenset({"alt", "f4"}): "Alt+F4 closes the active window (unsaved work may be lost)",
    frozenset({"ctrl", "q"}): "Ctrl+Q quits the active application",
    frozenset({"super", "l"}): "Super+L locks the screen",
}


def classify_bash(command: str) -> Risk | None:
    for pattern, risk in _BASH_RULES:
        if pattern.search(command):
            return risk
    return None


def classify_ui_label(label: str | None) -> Risk | None:
    if label and _UI_LABEL.search(label):
        return Risk(f"UI element looks sensitive: “{label.strip()[:80]}”", "ui")
    return None


def classify_action(action: dict) -> Risk | None:
    """`action` is a *normalised* action dict (see actions.normalize_action)."""
    if action.get("requires_confirmation"):
        reason = str(action.get("reason") or "Claude flagged this step as sensitive").strip()
        return Risk(reason[:200], "flagged")

    kind = action.get("type")
    if kind == "bash":
        return classify_bash(str(action.get("command", "")))
    if kind == "type":
        text = str(action.get("text", ""))
        if "\n" in text or "\r" in text:  # typed + Enter, e.g. into a terminal
            return classify_bash(text)
        return None
    if kind == "hotkey":
        combo = frozenset(action.get("keys", []))
        reason = _RISKY_HOTKEYS.get(combo)
        return Risk(reason, "system") if reason else None
    if kind in {"click", "double_click", "right_click", "middle_click", "atspi_click"}:
        return classify_ui_label(action.get("target") or action.get("name"))
    return None
