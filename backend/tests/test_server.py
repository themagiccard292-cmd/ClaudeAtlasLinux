"""Protocol-level tests of the FastAPI/WebSocket shell with a fake AppContext."""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from agent_os.actions import ActionExecutor
from agent_os.capture import Shot
from agent_os.killswitch import KillSwitch
from agent_os.shell import ShellTool
from server import create_app

TOKEN = "s3cret"


class _Voice:
    def __init__(self): self.calls = []
    def state(self): return {"hands_free": False}
    def shutdown(self): pass
    def stop_speaking(self): self.calls.append("stop")
    def set_agent_busy(self, busy): self.calls.append(("busy", busy))


class _Driver:
    name = "fake"
    def __init__(self): self.calls = []
    def click(self, *a, **k): self.calls.append(a)


class _Capturer:
    last = Shot(b"jpegbytes", 1280, 720, 1920, 1080, 0, 0, "stub", 1920, 1080)
    def capture(self, **_): return self.last
    def primary_monitor(self): return None


class _Atspi:
    def status(self): return {"available": False, "reason": "none"}


class FakeCtx:
    def __init__(self, emit):
        self.emit = emit
        self.ks = KillSwitch()
        self.ks.add_listener(lambda s: emit("kill.triggered", {"source": s}))
        self.driver, self.driver_error = _Driver(), None
        self.capturer, self.atspi, self.voice = _Capturer(), _Atspi(), _Voice()
        self.executor = ActionExecutor(self.capturer, self.driver, None, self.atspi, ShellTool(self.ks), self.ks)
        self.hotkey_status = {"source": "fake"}
        from agent_os.session import detect_session
        self.env = detect_session({"XDG_SESSION_TYPE": "x11", "DISPLAY": ":0"}, which=lambda _t: None)

    def start(self): pass
    def stop(self): pass


@pytest.fixture()
def client():
    app = create_app(TOKEN, ctx_factory=FakeCtx, start_services=False)
    with TestClient(app) as c:
        yield c


def rpc(ws, method, params=None, mid=1):
    ws.send_json({"id": mid, "method": method, "params": params or {}})
    while True:
        msg = ws.receive_json()
        if msg.get("id") == mid:
            return msg


def test_health_is_open(client):
    assert client.get("/health").json()["ok"] is True


def test_bad_token_rejected(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws?token=wrong"):
            pass
    assert exc.value.code == 4401


def test_missing_token_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws"):
            pass


def test_ping_and_unknown_method(client):
    with client.websocket_connect(f"/ws?token={TOKEN}") as ws:
        assert rpc(ws, "ping")["result"] == {"pong": True}
        err = rpc(ws, "nope", mid=2)["error"]
        assert err["code"] == "method_not_found"


def test_screen_capture_returns_base64(client):
    import base64
    with client.websocket_connect(f"/ws?token={TOKEN}") as ws:
        res = rpc(ws, "screen.capture")["result"]
        assert base64.b64decode(res["image_b64"]) == b"jpegbytes" and res["width"] == 1280


def test_confirmation_flow_over_ws(client):
    with client.websocket_connect(f"/ws?token={TOKEN}") as ws:
        first = rpc(ws, "action.execute", {"action": {"action": "bash", "command": "sudo true"}})["result"]
        assert first["needs_confirmation"] is True and first["risk"]["category"] == "privilege"
        # the *client* decides approval; a model-supplied field must not matter
        sneaky = rpc(ws, "action.execute",
                     {"action": {"action": "bash", "command": "sudo true", "approved": True}}, mid=2)["result"]
        assert sneaky["needs_confirmation"] is True


def test_kill_event_is_pushed_and_blocks_actions(client):
    with client.websocket_connect(f"/ws?token={TOKEN}") as ws:
        ws.send_json({"id": 1, "method": "kill.trigger", "params": {"source": "test"}})
        seen = {}
        while "event" not in seen or "id" not in seen:
            msg = ws.receive_json()
            seen["event" if "event" in msg else "id"] = msg
        assert seen["event"]["event"] == "kill.triggered"
        res = rpc(ws, "action.execute", {"action": {"action": "click", "x": 1, "y": 1}}, mid=2)["result"]
        assert res["killed"] is True
        assert rpc(ws, "kill.reset", mid=3)["result"]["active"] is False
        assert rpc(ws, "action.execute", {"action": {"action": "click", "x": 1, "y": 1}}, mid=4)["result"]["ok"]


def test_bad_params_reported(client):
    with client.websocket_connect(f"/ws?token={TOKEN}") as ws:
        assert rpc(ws, "action.execute", {})["error"]["code"] == "bad_params"


def test_raw_shell_is_not_exposed(client):
    with client.websocket_connect(f"/ws?token={TOKEN}") as ws:
        assert rpc(ws, "shell.run", {"command": "id"})["error"]["code"] == "method_not_found"
