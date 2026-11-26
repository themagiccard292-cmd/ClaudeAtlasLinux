"""Keyless wake-word handling on top of the transcript (fuzzy prefix match)."""
from __future__ import annotations

import re
from difflib import SequenceMatcher

_TOKEN = re.compile(r"[\w']+", re.UNICODE)
_LEADING_PUNCT = " \t,.:;!?-–—"


def strip_wake_word(text: str, wake: str, threshold: float = 0.8) -> tuple[bool, str]:
    """Returns (matched, remainder).

    `wake` may be empty, which means "no wake word needed" -> (True, text).
    Matching is fuzzy so that Whisper hearing "hey cloud" / "a claude" still works.
    """
    wake_tokens = [t.lower() for t in _TOKEN.findall(wake)]
    if not wake_tokens:
        return True, text.strip()
    spans = [(m.group(0).lower(), m.end()) for m in _TOKEN.finditer(text)]
    n = len(wake_tokens)
    target = " ".join(wake_tokens)
    best: tuple[float, int] | None = None
    for take in (n, n + 1, n - 1):  # allow one split / merged word
        if take < 1 or take > len(spans):
            continue
        heard = " ".join(s[0] for s in spans[:take])
        ratio = SequenceMatcher(None, heard, target).ratio()
        if best is None or ratio > best[0]:
            best = (ratio, spans[take - 1][1])
    if best and best[0] >= threshold:
        return True, text[best[1]:].lstrip(_LEADING_PUNCT)
    return False, text.strip()
