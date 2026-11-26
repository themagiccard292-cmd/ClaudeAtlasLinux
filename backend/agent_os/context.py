"""Wires every backend component together."""
from __future__ import annotations

from typing import Callable

from .actions import ActionExecutor
from .atspi import AtspiService
from .capture import ScreenCapturer
from .hotkeys import HotkeyService
from .input_drivers import make_driver
from .killswitch import InjectionGuard, KillSwitch
from .runner import CommandRunner
from .session import DisplayEnv, detect_session
from .shell import ShellTool
from .voice.manager import VoiceManager

Emit = Callable[[str, dict], None]


class AppContext:
    def __init__(self, emit: Emit, env: DisplayEnv | None = None) -> None:
        self.emit = emit
        self.env = env or detect_session()
        self.ks = KillSwitch()
        self.guard = InjectionGuard()
        self.runner = CommandRunner(self.ks)
        self.capturer = ScreenCapturer(self.env, self.runner)
        self.atspi = AtspiService(self.runner)
        self.shell = ShellTool(self.ks)

        self.driver_error: str | None = None
        try:
            self.driver = make_driver(self.env, self.runner, self.ks, self.guard)
        except Exception as exc:  # the UI shows this instead of crashing the sidecar
            self.driver, self.driver_error = None, str(exc)

        self.executor = ActionExecutor(self.capturer, self.driver, self.driver_error,
                                       self.atspi, self.shell, self.ks)
        self.voice = VoiceManager(emit)
        self.hotkeys = HotkeyService(self.ks, self.guard, on_ptt=self._on_ptt, env=self.env)
        self.hotkey_status: dict = {}

        self.ks.add_listener(self._on_kill)

    # ------------------------------------------------------------------ hooks
    def _on_ptt(self, down: bool) -> None:
        self.emit("hotkey.ptt", {"down": down})
        self.voice.ptt(down)

    def _on_kill(self, source: str) -> None:
        self.voice.stop_speaking()
        self.emit("kill.triggered", {"source": source})

    # -------------------------------------------------------------- lifecycle
    def start(self) -> None:
        self.hotkey_status = self.hotkeys.start()

    def stop(self) -> None:
        self.hotkeys.stop()
        self.voice.shutdown()
