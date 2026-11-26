# Claude OS Agent (Linux)

A standalone desktop app that looks like the Claude desktop app and **drives your whole Linux desktop** —
mouse, keyboard, shell, accessibility tree — on **X11 and Wayland**, with a floating "Mini-HUD" while it works
and a hands-free voice mode. It talks to Claude through **your Claude Pro subscription — never an API key**.

```
 ┌──────────────────────────── Electron app ────────────────────────────┐        ┌─── Python sidecar (backend-linux) ───┐
 │  React + Tailwind UI   ⇄  main process                               │  WS    │  FastAPI + WebSocket (localhost)      │
 │  • chat / step accordions   • agent loop:                            │ ◄────► │  • X11/Wayland detection              │
 │  • login (claude.ai)           capture → ask Claude → parse JSON     │ token  │  • mss | grim | XDG portal capture    │
 │  • sidebar / settings          → execute → verify                    │ auth   │  • xdotool | pynput | ydotool+wtype   │
 │  • Mini-HUD window          ┌── Claude bridge ──────────────┐        │        │  • AT-SPI (system-python helper)      │
 │                             │ web: hidden claude.ai window   │        │        │  • bash tool  + confirmation policy   │
 │                             │      (persist:claude-pro)      │        │        │  • Esc-Esc kill switch (pynput/evdev) │
 │                             │ cli: local `claude -p` (OAuth) │        │        │  • faster-whisper STT · edge/piper TTS│
 │                             └────────────────────────────────┘        │        │  • Alt+Space push-to-talk             │
 └───────────────────────────────────────────────────────────────────────┘        └───────────────────────────────────────┘
```

## What's new in v1.1 — live view

Claude can't watch a video stream (no model reached through a chat session can; it reasons on screenshots), but **you** can.
v1.1 adds a real live view:

* **Sandbox desktop (default).** Claude works on its own private virtual screen (Xvfb). The app shows it as a **~15 fps live
  video** next to the chat, with the agent's **mouse pointer gliding** between targets, **click ripples**, and chips for typing and
  shortcuts. Your real desktop stays free, no HUD covers anything, and it behaves the same on X11 and Wayland.
* **My desktop** (switch under the prompt box) still drives your real screen — now with a **smoothly gliding cursor** instead of
  teleporting, so you can follow it.
* Needs `xvfb` (+ `xdotool`; `openbox` is recommended for window frames). Apps run inside the sandbox via plain X11.

Honest limits: the sandbox is a *separate screen*, **not a security sandbox** — `bash` still runs as you, with your files. The
sandbox has no accessibility tree (screenshots only), starts empty (Claude launches apps with `bash`), and you watch rather than
click in it (yet). The model still sees discrete screenshots after each step, exactly as before.

## How Claude sees the screen (v1.3)

**Claude cannot take video**, and through a claude.ai chat or the `claude` CLI it can only be given text and still images. Instead of
screenshots as the default, v1.3 runs a *perception engine* that watches the screen continuously (~5 Hz) and hands Claude text:

| Channel | What Claude gets |
|---|---|
| **Windows** | titles, sizes, positions, which one is active |
| **UI elements** | buttons / fields with click points, from the accessibility tree (AT-SPI; also inside the sandbox) |
| **Text on screen** | every line of visible text with its position, read by offline OCR (tesseract) |
| **What changed** | a timeline of what happened *while Claude was acting*: windows opened/closed, text appeared/disappeared, the screen was changing for 1.1 s then settled |
| **Settling** | after each action it waits until the screen stops changing, instead of fixed sleeps |
| **Motion strip** | only when something was moving: a timestamped contact sheet of the last few frames |
| **One frame** | only when the screen has visual content text can't describe (photo, video, canvas), or when Claude asks with `look` |

Claude can click by *reading*: `click_text {"text":"Edit"}` finds that word on screen and clicks it. **Settings → Agent → How Claude sees the
screen** switches between *Auto* (default), *Text only* (never any image) and *Always send a frame*. The live-view panel shows
**What Claude sees** — the exact text it received each step and whether any image was attached. Honest limits: Claude still
reasons in discrete turns (this makes those turns continuous-aware, not video); OCR can misread small or stylised text; graphics-only
UIs fall back to a frame; needs `tesseract-ocr` (the `.deb` installs it).

## Auto-update (v1.2)

The installed app keeps itself current — no re-running `build.sh`:

* It checks GitHub Releases on start-up and every 6 hours (Settings → **Updates**: on/off, background download, Stable/Beta,
  *Check now*). A banner offers **Download** → **Restart to update**.
* **AppImage:** the new AppImage replaces the old file in place and the app relaunches. **.deb:** the package is installed with
  `dpkg -i` through a graphical password prompt (polkit); if that fails or is cancelled the app simply carries on.
* Installing **always waits for you** and is refused while a task is running. Downloaded updates survive a later failed check.
* Integrity: HTTPS + the sha512 in `latest-linux.yml`. There is no code signing on Linux, so you are trusting the GitHub repo.

**Publishing a release (maintainer):** bump `version` in `package.json`, commit, then
`git tag v1.2.1 && git push origin v1.2.1`. The *Release* workflow builds both packages and uploads them with
`latest-linux.yml` — running apps pick it up within hours. (Locally: `ATLAS_PUBLISH=always GH_TOKEN=… ./build.sh`.)
The repository must be **public** (or the app would need a token baked in, which this project deliberately does not do).
Apps built from source (`npm run dev`) never self-update. `ATLAS_UPDATE_URL=<dir with latest-linux.yml>` points a build at a
different feed (used by `scripts/e2e-update.mjs`).

## ⚠️ Read this first

* **Terms of service.** The *web* bridge automates the claude.ai chat page (types into it, reads the answer). Anthropic's
  consumer terms restrict automated access to the web app except where they explicitly permit it, and the officially
  supported way to use a subscription from tools is **Claude Code / the `claude` CLI**. If that matters for your account,
  choose **Settings → Claude connection → Local claude CLI** (`claude login` with your Pro/Max account). Both modes
  use your flat-rate plan; neither uses an API key. You are responsible for how you use the app.
* **Plan limits.** A perception-action loop sends a screenshot per step. Pro/Max message limits still apply, so long
  tasks can hit the usage cap (the app shows a clear error when claude.ai answers 429).
* **The web bridge depends on claude.ai's current page layout**, which can change without notice. All selectors live in one
  file (`electron/bridge/selectors.ts`); **Settings → Test bridge** reports which ones currently match.
* **This app can delete files and send things on your behalf.** Risky `bash` (sudo, rm, kill, uninstall, e-mail…) and
  anything Claude flags as sensitive needs your approval — but the policy is a heuristic, not a sandbox. Keep a hand on
  **Esc Esc**.

## Features

| | |
|---|---|
| **Auth (no API key)** | Embedded official `claude.ai/login` in a persistent Electron partition (`persist:claude-pro`); the UI flips to the agent the moment the `sessionKey` cookie appears. Plan badge (Pro/Max/…) from `/api/organizations`. Optional `claude` CLI bridge; `ANTHROPIC_API_KEY`/`…AUTH_TOKEN`/`…BASE_URL` are scrubbed from its environment. |
| **Bridge** | Screenshot (≤1280×720 JPEG) attached via file-input → paste → drop fallbacks; reply read from the DOM (raw `<pre>` JSON so markdown can't corrupt it) and the streaming `/completion` request is watched for exact completion + 429/401/403. |
| **Actions** | `click` `double_click` `right_click` `middle_click` `move` `drag` `scroll` `type` `hotkey` `bash` `wait` `screenshot` + `atspi_windows` `atspi_tree` `atspi_find` `atspi_click`. Coordinates are screenshot-space and mapped to real monitor pixels (HiDPI / multi-monitor aware, primary monitor only). |
| **X11** | `mss` capture · `xdotool` (fallback `pynput`) · `pynput` global keys |
| **Wayland** | `grim` → XDG Desktop Portal (`jeepney`) → `gnome-screenshot` → `spectacle` · `ydotool` (+`wtype` for Unicode) · `evdev` global keys |
| **Smart targeting** | AT-SPI tree / find / click through `gi.repository.Atspi` (or `pyatspi`) in a helper run by the *system* Python |
| **UI** | `#F5F4EF` / `#262624`, serif headings, markdown, collapsible **Agent Action** accordions with the screenshot, click markers, coordinates and bash output; chat history, saved workflows, plan badge, voice/audio settings |
| **Live view** | Sandbox desktop streamed at ~15 fps into the app with a gliding agent pointer, click ripples and typing chips (v1.1) |
| **Mini-HUD** | Frameless transparent always-on-top pill (`type: 'dock'` / `'toolbar'`) at the bottom of the screen: live status, waveform, **STOP / TAKE OVER**, inline approve/deny. Painted out of the screenshots so Claude can't click it |
| **Voice (keyless)** | `faster-whisper` STT · `edge-tts` → `piper` → `espeak-ng` TTS · push-to-talk **Alt+Space** · hands-free with a wake phrase · speaking while Claude works **pauses it and injects your new instruction** |
| **Safety** | **Esc Esc** kill switch (pynput on X11, evdev anywhere) kills every automation thread and child process group; STOP button; approval gate with voice "approve / deny"; no raw shell endpoint |
| **Packaging** | PyInstaller → `backend-linux` ELF → `extraResources` → `Claude-OS-Agent.AppImage` + `claude-os-agent.deb` |

## Project layout

```
ClaudeAtlasLinux/
├── build.sh                      one-click build (venv → PyInstaller → vite/tsc → electron-builder)
├── package.json                  scripts + electron-builder Linux config (AppImage, deb, extraResources)
├── index.html  vite.config.mts  tailwind.config.cjs  postcss.config.cjs  tsconfig*.json
├── shared/                       types.ts · ipc.ts   (contract between main and renderer)
├── electron/                     ── main process (TypeScript → dist-electron/)
│   ├── main.ts                   lifecycle, sidecar start/stop, event routing, single instance
│   ├── preload.ts  ipc.ts        contextBridge API + validated IPC handlers
│   ├── auth.ts  planDetect.ts    persist:claude-pro session, cookie watcher, plan badge
│   ├── windows.ts                main window, login WebContentsView, Mini-HUD (+ screenshot mask)
│   ├── store.ts                  settings / chats / workflows (atomic JSON in userData)
│   ├── updater.ts updateState.ts auto-update (electron-updater) + pure state machine
│   ├── backend/  sidecar.ts client.ts      spawn backend-linux (chmod +x, free port, token), WS RPC client
│   ├── bridge/   webBridge.ts page-bridge.js selectors.ts cliBridge.ts imageUtil.ts types.ts
│   └── agent/    runner.ts parser.ts prompt.ts voiceConfirm.ts   perception→action loop
├── src/                          ── React renderer (Vite)
│   ├── App.tsx  store.ts  styles.css  lib/{atlas,format,mock}.ts
│   └── components/               Sidebar ChatView StepAccordion PromptBar AudioVisualizer LoginView
│                                 SettingsPanel ConfirmDialog Hud Banners Markdown Icons
├── backend/                      ── Python OS-control server
│   ├── server.py                 FastAPI + WebSocket, READY handshake, parent-death watchdog
│   ├── backend-linux.spec        PyInstaller spec  →  backend/dist/backend-linux
│   ├── requirements*.txt
│   ├── agent_os/                 session capture input_drivers actions safety killswitch hotkeys
│   │   │                         atspi atspi_helper shell runner keys context rpc x11util config
│   │                         sandbox targets streamer   (v1.1: virtual desktop, live frames)
│   │   └── voice/                audio_in vad wake stt tts manager
│   └── tests/                    unit + real-X11 + real-AT-SPI + process tests
├── scripts/                      build-backend.sh make-icons.py copy-assets.mjs
│                                 test-page-bridge.mjs e2e-electron.mjs
└── resources/icons/              generated app icons
```

## Build

```bash
./build.sh --install-system-deps      # Debian/Ubuntu: installs everything below, then builds
# or, if the packages are already there:
./build.sh
```

Outputs: `release/Claude-OS-Agent.AppImage` and `release/claude-os-agent.deb`.

**Exact PyInstaller command** (what `build.sh` runs for the sidecar):

```bash
backend/.venv/bin/python -m PyInstaller --noconfirm --clean \
    --distpath backend/dist --workpath backend/build backend/backend-linux.spec
```

**System packages**

| Purpose | Debian / Ubuntu packages |
|---|---|
| Build | `python3 python3-venv python3-pip nodejs(≥20) npm fakeroot dpkg libasound2-dev portaudio19-dev` |
| Sandbox desktop (v1.1) | `xvfb xdotool` (+ `openbox` for window frames) |
| X11 input/capture | `xdotool x11-xserver-utils` (xrandr) |
| Wayland input/capture | `ydotool` (≥1.0) `wtype` `grim` (+ `wl-clipboard`); GNOME/KDE use the screenshot portal instead of grim |
| Accessibility | `python3-gi gir1.2-atspi-2.0 python3-pyatspi at-spi2-core` |
| Audio | `libasound2` (`libasound2t64`) `libportaudio2` `pipewire-pulse` or `pulseaudio` |
| TTS fallback | `espeak-ng` |

The `.deb` declares these as `Depends` / `Recommends`. The **AppImage** is self-contained except for the packages above,
which come from the host (they can't be frozen: PyGObject, PortAudio, xdotool, ydotool…).

### Development

```bash
python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements-dev.txt
npm install
npm run dev                  # vite + electron; the sidecar runs from backend/server.py
npm run typecheck && npm test
backend/.venv/bin/python -m pytest backend/tests
```

## Wayland setup

Wayland deliberately blocks synthetic input and global key capture, so the app uses kernel-level tools:

```bash
sudo apt install ydotool wtype grim
sudo usermod -aG input "$USER"                       # evdev: global Esc-Esc kill switch + Alt+Space
echo 'KERNEL=="uinput", GROUP="input", MODE="0660"' | sudo tee /etc/udev/rules.d/60-uinput.rules
sudo udevadm control --reload && sudo udevadm trigger   # then log out / in; ydotoold is started on demand
```

Notes: `wtype` does not work on GNOME (the app falls back to `ydotool type`, ASCII only); GNOME shows a one-time
screenshot-portal prompt; AT-SPI window geometry is only reliable for XWayland/X11 apps; the HUD is forced onto XWayland
only if you set `ATLAS_FORCE_X11=1` (v1.1 no longer forces it, which fixed invisible windows on some Wayland setups); native Wayland windows cannot position themselves or stay on top, so use the sandbox desktop there.
Environment overrides: `ATLAS_SESSION_TYPE`, `ATLAS_INPUT_BACKEND`, `ATLAS_CAPTURE_BACKEND`, `ATLAS_HOTKEY_BACKEND`,
`ATLAS_PTT_KEYS` (default `alt+space`), `ATLAS_SYSTEM_PYTHON`, `ATLAS_GLIDE=0` (disable smooth cursor), `ATLAS_ENABLE_GPU=1` (GPU acceleration is off by default).

## Using it

1. Launch → **Sign in with Claude Pro** (or "Use the local Claude CLI instead").
2. Type a task, or hold **Alt+Space** and say it. Mode **Agent** controls the desktop; **Chat** is plain Claude.
3. In **Sandbox** mode the live view opens beside the chat; in **My desktop** mode the window hides and the HUD appears. **STOP / TAKE OVER** or **Esc Esc** hands control back instantly.
4. Speak while it works to interrupt: it pauses, listens, and folds your instruction into the next step.
5. Anything destructive asks first — click Approve/Deny, or say "approve" / "deny".

## How the agent talks to Claude

Each turn Claude gets the task (first turn only), the previous results, the active window title, whether the screen
changed, and a fresh screenshot, and must answer with one fenced JSON block:

```json
{ "thought": "Open the file manager", "actions": [ {"action":"click","x":148,"y":118,"target":"Files"} ], "done": false, "message": "Opening Files" }
```

Replies are validated by a **whitelist** parser (`electron/agent/parser.ts`) — unknown fields (e.g. a model-supplied
`approved: true`) are dropped, so the model can never bypass the approval gate. Malformed replies get up to two
format reminders before the task fails.

## Tests

| Suite | What it proves |
|---|---|
| `backend/tests` (188, incl. real sandbox, live stream, OCR, accessibility, click-from-text) | safety rules, key tables, kill switch, coordinate mapping, VAD, wake word, AT-SPI tree logic, WebSocket protocol |
| `…/test_e2e_x11.py` | **real** Xvfb: capture, xdotool clicks/typing into a real xterm, Esc-Esc kill via real key events, Alt+Space |
| `…/test_e2e_atspi.py` | **real** GTK3 app on a private AT-SPI bus: read tree, read entry text, click a button via AT-SPI |
| `…/test_e2e_process.py` | sidecar as a process: READY handshake, auth, loopback-only, exits when the parent dies |
| `electron/agent/parser.test.ts` | JSON extraction/repair, sanitising, voice-confirm parsing |
| `scripts/test-page-bridge.mjs` | in-page bridge against a *mock* claude.ai page (attach/paste/drop, send, stream, stop) |
| `scripts/e2e-update.mjs` | **real** AppImage + local update feed: up-to-date, available + notes, consent-gated download with progress, file actually swapped, app relaunches, old instance exits |
| `scripts/e2e-electron.mjs` | **real** Electron + sidecar + Xvfb with a fake `claude` CLI: full task, HUD, approval deny/approve, retry, kill, persistence, API-key scrubbing |

## Troubleshooting

* **Bridge can't find the composer / send button** → Settings → *Test bridge*, then update `electron/bridge/selectors.ts`.
* **Google sign-in refuses the embedded browser** → use the e-mail magic link on claude.ai/login, or the CLI mode.
* **"No input driver"** → X11: `sudo apt install xdotool`; Wayland: see above.
* **Global hotkeys inactive (banner)** → add yourself to the `input` group (Wayland) or check `ATLAS_HOTKEY_BACKEND`.
* **AppImage won't start (sandbox error)** → on kernels/AppArmor that block user namespaces the app adds `--no-sandbox` itself; to force it: `--no-sandbox`.
* **Speech model download fails** → first use needs internet (Hugging Face); pick a smaller model in Settings.
* **TTS echo interrupts the agent** → use headphones; speech detection is raised while TTS plays but can't remove echo.
* Logs: `~/.config/Claude OS Agent/claude-os-agent.log` (path may be `claude-os-agent`).

## License

MIT. "Claude" is a trademark of Anthropic; this is an independent, unofficial client and uses original artwork.
