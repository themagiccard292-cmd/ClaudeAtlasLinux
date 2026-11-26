"""Logic tests of the AT-SPI helper using an in-memory fake accessibility tree."""
from agent_os import atspi_helper as H
from agent_os.atspi import AtspiService, format_nodes
from agent_os.capture import Shot


class N:
    def __init__(self, role, name="", children=(), states=("showing", "enabled"), box=(0, 0, 10, 10),
                 actions=(), text=""):
        self.role, self.name, self.kids = role, name, list(children)
        self.st, self.box, self.acts, self.txt = set(states), box, list(actions), text
        self.clicked = None


class FakeBackend:
    def __init__(self, apps): self.root = N("desktop", children=apps)
    def desktop(self): return self.root
    def children(self, a): return iter(a.kids)
    def name(self, a): return a.name
    def role(self, a): return a.role
    def states(self, a): return a.st
    def extents(self, a): return a.box
    def actions(self, a): return a.acts
    def text(self, a): return a.txt
    def do_action(self, a, i): a.clicked = i; return True


def sample_backend():
    save = N("push button", "Save", box=(100, 200, 80, 30), actions=("click",))
    hidden = N("push button", "Hidden Button", states=("enabled",), actions=("click",))
    entry = N("entry", "Search", box=(10, 10, 300, 24), states=("showing", "focused", "editable"), text="hello")
    panel = N("panel", "", children=[save, entry, hidden])
    win = N("frame", "Editor", children=[panel], states=("showing", "active"), box=(0, 0, 800, 600))
    other = N("frame", "Terminal", children=[N("terminal", "Term", box=(0, 0, 5, 5))], states=("showing",))
    return FakeBackend([N("application", "gedit", children=[win]), N("application", "xterm", children=[other])]), save


def test_windows_listing():
    be, _ = sample_backend()
    wins = H.handle(be, {"op": "windows"})["windows"]
    assert {(w["app"], w["title"], w["active"]) for w in wins} == {("gedit", "Editor", True), ("xterm", "Terminal", False)}


def test_tree_defaults_to_active_window_and_prunes_hidden():
    be, _ = sample_backend()
    res = H.handle(be, {"op": "tree"})
    names = {n["name"] for n in res["nodes"]}
    assert {"Editor", "Save", "Search"} <= names
    assert "Hidden Button" not in names and "Term" not in names
    entry = next(n for n in res["nodes"] if n["name"] == "Search")
    assert entry["text"] == "hello" and "focused" in entry["states"] and "_acc" not in entry


def test_tree_scope_app_and_all():
    be, _ = sample_backend()
    assert {n["app"] for n in H.handle(be, {"op": "tree", "scope": "app:xterm"})["nodes"]} == {"xterm"}
    assert {n["app"] for n in H.handle(be, {"op": "tree", "scope": "all"})["nodes"]} == {"gedit", "xterm"}


def test_max_nodes_truncates():
    be, _ = sample_backend()
    res = H.handle(be, {"op": "tree", "max_nodes": 2})
    assert res["truncated"] is True and len(res["nodes"]) == 2


def test_find_by_name_and_role():
    be, _ = sample_backend()
    assert H.handle(be, {"op": "find", "name": "sav", "scope": "all"})["matches"][0]["name"] == "Save"
    assert H.handle(be, {"op": "find", "role": "entry", "scope": "all"})["total"] == 1
    assert H.handle(be, {"op": "find", "name": "nonexistent", "scope": "all"})["total"] == 0


def test_act_uses_native_action_when_available():
    be, save = sample_backend()
    res = H.handle(be, {"op": "act", "name": "Save", "scope": "all"})
    assert res["ok"] and res["method"].startswith("atspi-action") and save.clicked == 0


def test_act_falls_back_to_coordinates_without_actions():
    be, save = sample_backend()
    save.acts = []
    res = H.handle(be, {"op": "act", "name": "Save", "scope": "all"})
    assert res["method"] == "coordinates" and res["node"]["bbox"] == [100, 200, 80, 30]


def test_act_reports_missing_element():
    be, _ = sample_backend()
    res = H.handle(be, {"op": "act", "name": "Nope", "scope": "all"})
    assert res["ok"] is False and "No element" in res["error"]


def test_unknown_op():
    be, _ = sample_backend()
    assert H.handle(be, {"op": "zap"})["ok"] is False


def test_annotation_converts_screen_to_model_coordinates():
    shot = Shot(b"", 1280, 720, 2560, 1440, 0, 0, "t", 2560, 1440)
    node = {"role": "push button", "name": "Save", "bbox": [100, 200, 80, 40], "states": [], "actions": ["click"], "id": 1}
    AtspiService._annotate(node, shot)
    assert node["center"] == [70, 110] and node["screen_center"] == [140, 220]
    text = format_nodes([node], truncated=True)
    assert 'push button "Save" @(70,110)' in text and "actions=click" in text and text.endswith("(truncated)")


def test_format_nodes_empty():
    assert format_nodes([], False) == "(no accessible elements found)"
