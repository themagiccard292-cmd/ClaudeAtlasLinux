"""A *target* is one screen the agent can see and drive: your real desktop, or the sandbox desktop."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .actions import ActionExecutor
from .atspi import AtspiService
from .capture import ScreenCapturer
from .errors import UnsupportedError
from .input_drivers import InputDriver, make_driver
from .killswitch import InjectionGuard, KillSwitch
from .runner import CommandRunner
from .session import DisplayEnv
from .shell import ShellTool


class NoAtspi:
    """The sandbox has no accessibility bus; fail with a message the model can act on."""

    def status(self) -> dict:
        return {"available": False, "python": None, "reason": "not available in the sandbox desktop"}

    def _no(self, *_a, **_k):
        raise UnsupportedError("The accessibility tree is not available on the sandbox desktop — use the screenshot.")

    windows = tree = find = act = _no


@dataclass
class Target:
    name: str
    env: DisplayEnv
    runner: CommandRunner
    capturer: ScreenCapturer
    shell: ShellTool
    driver: InputDriver | None
    driver_error: str | None
    atspi: AtspiService | NoAtspi
    executor: ActionExecutor


def build_target(
    name: str,
    env: DisplayEnv,
    ks: KillSwitch,
    guard: InjectionGuard,
    atspi: AtspiService | NoAtspi,
    on_fx: Callable[[dict], None] | None,
    env_extra: dict[str, str | None] | None = None,
    force_driver: str | None = None,
) -> Target:
    runner = CommandRunner(ks, env_extra)
    capturer = ScreenCapturer(env, runner)
    shell = ShellTool(ks, env_extra)
    driver: InputDriver | None = None
    driver_error: str | None = None
    try:
        driver = make_driver(env, runner, ks, guard, force=force_driver)
    except Exception as exc:
        driver_error = str(exc)
    executor = ActionExecutor(capturer, driver, driver_error, atspi, shell, ks, on_fx=on_fx, target=name)
    return Target(name, env, runner, capturer, shell, driver, driver_error, atspi, executor)
