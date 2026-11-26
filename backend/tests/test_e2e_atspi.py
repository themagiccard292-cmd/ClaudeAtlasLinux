"""Real AT-SPI test: a GTK3 app on Xvfb with a private D-Bus + AT-SPI bus.

Skipped unless a system Python with PyGObject+Gtk3+Atspi, Xvfb, dbus-run-session
and at-spi-bus-launcher exist. Runs the real helper in a subprocess, exactly as
the sidecar does in production.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import textwrap
import time

import pytest

PROBE = ("import gi; gi.require_version('Atspi','2.0'); gi.require_version('Gtk','3.0');"
         "from gi.repository import Atspi, Gtk")


def _system_python():
    for py in sorted(glob.glob("/usr/bin/python3.[0-9]*"), reverse=True):
        if py.endswith("config"):
            continue
        if subprocess.run([py, "-c", PROBE], capture_output=True).returncode == 0:
            return py
    return None


SYSPY = _system_python()
LAUNCHER = next(iter(glob.glob("/usr/libexec/at-spi-bus-launcher") + glob.glob("/usr/lib/*/at-spi2*/at-spi-bus-launcher")), None)

pytestmark = pytest.mark.skipif(
    not (SYSPY and shutil.which("Xvfb") and shutil.which("dbus-run-session") and LAUNCHER),
    reason="needs system python3-gi + Gtk3 typelib, Xvfb, dbus-run-session, at-spi2-core",
)

APP = textwrap.dedent('''
    import gi, sys
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk
    marker = sys.argv[1]
    win = Gtk.Window(title="Atlas Test App")
    win.set_default_size(420, 200)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    entry = Gtk.Entry(); entry.set_text("hello atspi"); entry.set_placeholder_text("Search")
    btn = Gtk.Button(label="Save Document")
    def clicked(_b):
        open(marker, "w").write("clicked")
    btn.connect("clicked", clicked)
    box.pack_start(entry, False, False, 0); box.pack_start(btn, False, False, 0)
    win.add(box); win.connect("destroy", Gtk.main_quit); win.show_all(); Gtk.main()
''')

SESSION = textwrap.dedent('''
    set -e
    export DISPLAY=:{disp} GTK_A11Y=atspi NO_AT_BRIDGE=0 GNOME_ACCESSIBILITY=1
    Xvfb :{disp} -screen 0 1280x800x24 -noreset >/dev/null 2>&1 &
    XPID=$!
    sleep 1
    {launcher} --launch-immediately >/dev/null 2>&1 &
    sleep 1
    {py} {app} {marker} >/dev/null 2>&1 &
    APID=$!
    sleep 2.5
    {py} {helper} < {req} > {out} || true
    {py} {helper} < {req2} > {out2} || true
    kill $APID $XPID 2>/dev/null || true
''')


def run_session(tmp_path, requests):
    from agent_os import atspi_helper

    app = tmp_path / "app.py"
    app.write_text(APP)
    marker = tmp_path / "marker"
    outs = []
    script_lines = []
    for i, req in enumerate(requests):
        (tmp_path / f"req{i}.json").write_text(json.dumps(req))
        outs.append(tmp_path / f"out{i}.json")
    body = SESSION.format(disp=88, launcher=LAUNCHER, py=SYSPY, app=app, marker=marker,
                          helper=atspi_helper.__file__, req=tmp_path / "req0.json", out=outs[0],
                          req2=tmp_path / "req1.json", out2=outs[1])
    proc = subprocess.run(["dbus-run-session", "--", "bash", "-c", body], capture_output=True, text=True, timeout=90)
    results = []
    for o in outs:
        assert o.exists() and o.read_text().strip(), f"helper produced no output; stderr={proc.stderr[-500:]}"
        results.append(json.loads(o.read_text().strip().splitlines()[-1]))
    return results, marker


def test_helper_sees_and_clicks_a_real_gtk_button(tmp_path):
    (tree, act), marker = run_session(tmp_path, [
        {"op": "tree", "scope": "all", "max_nodes": 100},
        {"op": "act", "name": "Save Document", "role": "button", "scope": "all"},
    ])
    assert tree["ok"], tree
    labels = [(n["role"], n["name"]) for n in tree["nodes"]]
    assert any("Save Document" in name for _r, name in labels), labels
    assert any(r in ("frame", "window") and "Atlas Test App" in name for r, name in labels), labels
    entry = next((n for n in tree["nodes"] if n["role"] in ("text", "entry")), None)
    assert entry is not None and "hello atspi" in (entry["text"] or entry["name"]), tree["nodes"]
    btn = next(n for n in tree["nodes"] if "Save Document" in n["name"])
    assert btn["bbox"] and btn["bbox"][2] > 20 and "click" in " ".join(btn["actions"]).lower() or btn["actions"]

    assert act["ok"], act
    time.sleep(0.5)
    assert marker.exists(), f"AT-SPI action did not click the button: {act}"
