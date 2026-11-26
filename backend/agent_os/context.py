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
from .sandbox import Sandbox
from .shell import ShellTool
from .streamer import LiveStreamer
from .targets import Target
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
                                       self.atspi, self.shell, self.ks, on_fx=self._fx, target="real")
        self.real = Target("real", self.env, self.runner, self.capturer, self.shell, self.driver,
                           self.driver_error, self.atspi, self.executor)
        self.sandbox = Sandbox(self.ks, self.guard, self.env, self._fx)
        self.streamer = LiveStreamer(emit, self.get_target)
        self.voice = VoiceManager(emit)
        self.hotkeys = HotkeyService(self.ks, self.guard, on_ptt=self._on_ptt, env=self.env)
        self.hotkey_status: dict = {}

        self.ks.add_listener(self._on_kill)

    # ---------------------------------------------------------------- targets
    def get_target(self, name: str) -> Target | None:
        if name == "sandbox":
            return self.sandbox.target if self.sandbox.running else None
        return self.real

    def _fx(self, fx: dict) -> None:
        self.emit("action.fx", fx)

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
        self.streamer.stop()
        self.sandbox.stop()
        self.hotkeys.stop()
        self.voice.shutdown()
