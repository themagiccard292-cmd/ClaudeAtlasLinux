"""Subprocess runner that cooperates with the kill switch."""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from dataclasses import dataclass

from .config import is_frozen
from .errors import ActionError, KillSwitchTriggered
from .killswitch import KillSwitch, kill_process_group


def clean_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for child processes.

    PyInstaller prepends its extraction dir to LD_LIBRARY_PATH, which breaks
    system binaries (xdotool, python3-gi, firefox...). Restore the original.
    """
    env = dict(os.environ)
    if is_frozen():
        if "LD_LIBRARY_PATH_ORIG" in env:
            env["LD_LIBRARY_PATH"] = env["LD_LIBRARY_PATH_ORIG"]
        else:
            env.pop("LD_LIBRARY_PATH", None)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    if extra:
        env.update(extra)
    return env


@dataclass
class CmdResult:
    returncode: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False
    duration: float = 0.0

    @property
    def text(self) -> str:
        return self.stdout.decode("utf-8", "replace")

    @property
    def err(self) -> str:
        return self.stderr.decode("utf-8", "replace")

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


class CommandRunner:
    def __init__(self, killswitch: KillSwitch | None = None) -> None:
        self.ks = killswitch or KillSwitch()

    @staticmethod
    def which(name: str) -> str | None:
        return shutil.which(name)

    def run(
        self,
        argv: list[str],
        *,
        timeout: float = 10.0,
        input_bytes: bytes | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> CmdResult:
        self.ks.check()
        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env or clean_env(),
                cwd=cwd,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            raise ActionError(f"Required tool not found: {argv[0]}") from exc
        timed_out = False
        with self.ks.track(proc):
            try:
                out, err = proc.communicate(input=input_bytes, timeout=timeout)
            except subprocess.TimeoutExpired:
                kill_process_group(proc)
                out, err = proc.communicate()
                timed_out = True
        if self.ks.active:
            raise KillSwitchTriggered(self.ks.triggered_by)
        return CmdResult(proc.returncode, out, err, timed_out, time.monotonic() - started)
