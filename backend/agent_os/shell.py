"""Bash execution tool.

Output goes to temp *files* (not pipes) so that `firefox &` style background
launches don't keep us waiting for EOF, while still capturing everything the
foreground part printed. The process group is only killed on timeout or when
the kill switch fires — normally launched GUI apps keep running.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time

from .errors import ActionError, KillSwitchTriggered
from .killswitch import KillSwitch, kill_process_group
from .runner import clean_env

MAX_OUTPUT = 12_000


def _clip(text: str, limit: int = MAX_OUTPUT) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    head, tail = text[: limit * 2 // 3], text[-limit // 3 :]
    return f"{head}\n… [{len(text) - limit} chars omitted] …\n{tail}", True


class ShellTool:
    def __init__(self, ks: KillSwitch, env_extra: dict[str, str | None] | None = None) -> None:
        self.ks = ks
        self.env_extra = env_extra or {}

    def run(self, command: str, timeout: float = 60.0, cwd: str | None = None) -> dict:
        if not command.strip():
            raise ActionError("Empty bash command")
        timeout = max(1.0, min(float(timeout), 600.0))
        workdir = os.path.expanduser(cwd) if cwd else os.path.expanduser("~")
        if not os.path.isdir(workdir):
            raise ActionError(f"cwd does not exist: {workdir}")
        self.ks.check()

        started = time.monotonic()
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(
                ["/bin/bash", "-c", command],
                stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                cwd=workdir, env=clean_env({**self.env_extra, "TERM": "dumb", "PAGER": "cat", "GIT_PAGER": "cat"}),
                start_new_session=True,
            )
            timed_out = False
            with self.ks.track(proc):
                try:
                    proc.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    kill_process_group(proc)
                    proc.wait()
                    timed_out = True
            if self.ks.active:
                raise KillSwitchTriggered(self.ks.triggered_by)
            out.seek(0)
            err.seek(0)
            stdout, t1 = _clip(out.read().decode("utf-8", "replace"))
            stderr, t2 = _clip(err.read().decode("utf-8", "replace"))
        return {
            "exit_code": proc.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "timed_out": timed_out,
            "truncated": t1 or t2,
            "duration_ms": round((time.monotonic() - started) * 1000),
            "cwd": workdir,
        }
