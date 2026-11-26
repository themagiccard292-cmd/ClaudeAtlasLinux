"""AT-SPI client: talks to `atspi_helper.py` running under the system Python."""
from __future__ import annotations

import glob
import json
import os
import re
import sys
from pathlib import Path

from .capture import Shot
from .config import is_frozen, package_dir
from .errors import ActionError, UnsupportedError
from .runner import CommandRunner


class AtspiService:
    def __init__(self, runner: CommandRunner) -> None:
        self.r = runner
        self._python: str | None = None
        self._checked = False
        self._why = ""
        self.helper = package_dir() / "atspi_helper.py"

    # ---------------------------------------------------------------- discovery
    def _candidates(self) -> list[str]:
        # python3-gi is built for the *distro's* interpreter, which is not always what
        # `python3` resolves to (pyenv, /usr/local, conda...), so probe every candidate.
        cands = [os.environ.get("ATLAS_SYSTEM_PYTHON", ""), "/usr/bin/python3"]
        cands += sorted((p for p in glob.glob("/usr/bin/python3.*") if re.fullmatch(r"/usr/bin/python3\.\d+", p)),
                        reverse=True)
        which = self.r.which("python3")
        if which:
            cands.append(which)
        if not is_frozen():
            cands.append(sys.executable)
        seen, out = set(), []
        for c in cands:
            if c and c not in seen and Path(c).exists():
                seen.add(c)
                out.append(c)
        return out

    def status(self) -> dict:
        if not self._checked:
            self._checked = True
            probe = ("import sys\n"
                     "try:\n import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi\n"
                     "except Exception:\n import pyatspi\n")
            for py in self._candidates():
                try:
                    res = self.r.run([py, "-c", probe], timeout=8)
                except ActionError:
                    continue
                if res.ok:
                    self._python = py
                    break
            else:
                self._why = ("No system Python with AT-SPI bindings. Install: "
                             "sudo apt install python3-gi gir1.2-atspi-2.0 python3-pyatspi at-spi2-core")
        return {"available": self._python is not None, "python": self._python, "reason": self._why}

    # --------------------------------------------------------------------- calls
    def _call(self, request: dict, timeout: float = 15.0) -> dict:
        st = self.status()
        if not st["available"]:
            raise UnsupportedError(st["reason"])
        res = self.r.run([self._python, str(self.helper)], timeout=timeout,
                         input_bytes=json.dumps(request).encode())
        if res.timed_out:
            raise ActionError("AT-SPI query timed out (the app may not expose an accessibility tree)")
        try:
            data = json.loads(res.text.strip().splitlines()[-1])
        except (ValueError, IndexError):
            raise ActionError(f"AT-SPI helper failed: {(res.err or res.text).strip()[:200]}") from None
        return data

    def windows(self) -> list[dict]:
        data = self._call({"op": "windows"})
        if not data.get("ok"):
            raise ActionError(data.get("error", "AT-SPI error"))
        return data["windows"]

    def tree(self, shot: Shot | None, scope: str = "active", max_nodes: int = 200) -> dict:
        data = self._call({"op": "tree", "scope": scope, "max_nodes": max_nodes})
        if not data.get("ok"):
            raise ActionError(data.get("error", "AT-SPI error"))
        for n in data["nodes"]:
            self._annotate(n, shot)
        data["text"] = format_nodes(data["nodes"], data.get("truncated", False))
        return data

    def find(self, shot: Shot | None, name: str | None, role: str | None,
             scope: str = "all", limit: int = 10) -> dict:
        data = self._call({"op": "find", "name": name, "role": role, "scope": scope, "limit": limit})
        if not data.get("ok"):
            raise ActionError(data.get("error", "AT-SPI error"))
        for n in data["matches"]:
            self._annotate(n, shot)
        data["text"] = format_nodes(data["matches"], False)
        return data

    def act(self, name: str | None, role: str | None, scope: str = "all", index: int = 0) -> dict:
        return self._call({"op": "act", "name": name, "role": role, "scope": scope, "index": index})

    # ------------------------------------------------------------------- helpers
    @staticmethod
    def _annotate(node: dict, shot: Shot | None) -> None:
        box = node.get("bbox")
        if box and shot:
            cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
            mx, my = shot.to_model(cx, cy)
            node["center"] = [mx, my]
            node["screen_center"] = [round(cx), round(cy)]
        elif box:
            node["screen_center"] = [round(box[0] + box[2] / 2), round(box[1] + box[3] / 2)]


def format_nodes(nodes: list[dict], truncated: bool) -> str:
    """Compact text for the model. Centres are in *screenshot* coordinates."""
    lines = []
    for n in nodes:
        pos = f" @({n['center'][0]},{n['center'][1]})" if n.get("center") else ""
        name = f' "{n["name"]}"' if n.get("name") else ""
        text = f" text={n['text']!r}" if n.get("text") else ""
        st = f" [{','.join(n['states'])}]" if n.get("states") else ""
        act = f" actions={','.join(n['actions'])}" if n.get("actions") else ""
        lines.append(f"{n.get('id', '-')}: {n['role']}{name}{pos}{st}{text}{act}")
    if truncated:
        lines.append("… (truncated)")
    return "\n".join(lines) if lines else "(no accessible elements found)"
