"""Exception hierarchy shared by every backend module."""
from __future__ import annotations


class AgentOSError(Exception):
    """Base class. `code` is surfaced to the Electron client."""

    code = "error"


class KillSwitchTriggered(AgentOSError):
    """Raised inside worker threads when the kill switch fires."""

    code = "killed"

    def __init__(self, source: str | None = None) -> None:
        super().__init__(f"Kill switch triggered ({source or 'unknown'})")
        self.source = source


class ActionError(AgentOSError):
    """The requested action is malformed or could not be performed."""

    code = "action_error"


class UnsupportedError(AgentOSError):
    """A required tool / protocol is not available in this session."""

    code = "unsupported"
