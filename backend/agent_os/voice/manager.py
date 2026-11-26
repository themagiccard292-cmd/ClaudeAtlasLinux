"""Voice orchestration: push-to-talk, hands-free (+ wake word), TTS and interruption.

State machine (the UI mirrors it via `voice.state` events):
    idle → listening → transcribing → idle
    idle → speaking  → idle
Voice interruption: speech starting while TTS plays or the agent is busy stops
TTS immediately and emits `voice.interrupt` so Electron can pause the agent.
"""
from __future__ import annotations

import threading
import time
from typing import Callable

import numpy as np

from .audio_in import TARGET_RATE, MicStream, list_devices
from .stt import SpeechToText
from .tts import Speaker
from .vad import EnergyVAD
from .wake import strip_wake_word

Emit = Callable[[str, dict], None]
MAX_PTT_SECONDS = 60


class VoiceManager:
    def __init__(self, emit: Emit) -> None:
        self.emit = emit
        self.stt = SpeechToText(on_status=lambda msg: self.emit("voice.status", {"message": msg}))
        self.speaker = Speaker(emit)
        self.input_device: int | str | None = None
        self.wake_word = "hey claude"
        self.require_wake_when_busy = False
        self.agent_busy = False

        self._lock = threading.RLock()
        self._mic: MicStream | None = None
        self._vad = EnergyVAD()
        self._ptt = False
        self._hands_free = False
        self._once = False
        self._ptt_buf: list[np.ndarray] = []
        self._level_t = 0.0
        self._interrupted = False

    # ------------------------------------------------------------------ config
    def configure(self, **kw) -> dict:
        with self._lock:
            if "input_device" in kw:
                dev = kw["input_device"]
                changed = dev != self.input_device
                self.input_device = None if dev in ("", None) else dev
                if changed and self._mic:
                    self._restart_mic()
            if "wake_word" in kw and kw["wake_word"] is not None:
                self.wake_word = str(kw["wake_word"]).strip()
            if "require_wake_when_busy" in kw:
                self.require_wake_when_busy = bool(kw["require_wake_when_busy"])
            if "whisper_model" in kw or "language" in kw:
                self.stt.configure(kw.get("whisper_model"), kw.get("language"))
            self.speaker.configure(kw.get("tts_engine"), kw.get("tts_voice"), kw.get("tts_rate"),
                                   kw.get("output_device"), kw.get("tts_volume"))
            if "hands_free" in kw:
                self.set_hands_free(bool(kw["hands_free"]))
        return self.state()

    def state(self) -> dict:
        return {"ptt": self._ptt, "hands_free": self._hands_free, "once": self._once,
                "speaking": self.speaker.speaking, "mic_open": bool(self._mic and self._mic.running),
                "wake_word": self.wake_word, "tts_engine": self.speaker.engine_name,
                "stt_model": self.stt.model_name, "agent_busy": self.agent_busy}

    def devices(self) -> dict:
        return list_devices()

    def set_agent_busy(self, busy: bool) -> None:
        self.agent_busy = busy

    def preload(self) -> None:
        """Warm the Whisper model in the background so first PTT is fast."""
        def work():
            try:
                self.stt.ensure_loaded()
            except Exception as exc:
                self.emit("voice.error", {"message": f"Speech model failed to load: {exc}"})
        threading.Thread(target=work, name="stt-preload", daemon=True).start()

    # --------------------------------------------------------------------- mic
    def _needs_mic(self) -> bool:
        return self._ptt or self._hands_free or self._once

    def _sync_mic(self) -> None:
        with self._lock:
            if self._needs_mic() and not (self._mic and self._mic.running):
                try:
                    self._mic = MicStream(self._on_block, self.input_device)
                    self._mic.start()
                except Exception as exc:
                    self._mic = None
                    self._ptt = self._hands_free = self._once = False
                    self.emit("voice.error", {"message": str(exc)})
                    self.emit("voice.state", {"state": "idle"})
            elif not self._needs_mic() and self._mic:
                self._mic.stop()
                self._mic = None
                self.emit("voice.level", {"level": 0.0, "source": "mic"})

    def _restart_mic(self) -> None:
        if self._mic:
            self._mic.stop()
            self._mic = None
        self._sync_mic()

    def _on_block(self, block: np.ndarray) -> None:  # audio thread
        rms = float(np.sqrt(np.mean(block * block))) if len(block) else 0.0
        now = time.monotonic()
        if now - self._level_t > 0.045:
            self._level_t = now
            self.emit("voice.level", {"level": min(1.0, rms * 10), "source": "mic"})

        if self._ptt:
            if sum(len(b) for b in self._ptt_buf) < MAX_PTT_SECONDS * TARGET_RATE:
                self._ptt_buf.append(block)
            return
        if not (self._hands_free or self._once):
            return
        self._vad.boost = 2.5 if self.speaker.speaking else 1.0  # ignore our own TTS echo
        for kind, audio in self._vad.process(block):
            if kind == "start":
                self._speech_started()
            elif kind == "end" and audio is not None:
                threading.Thread(target=self._handle_utterance, args=(audio, "hands_free"), daemon=True).start()
            elif kind == "cancel":
                self.emit("voice.state", {"state": "listening"})

    # ------------------------------------------------------------ interruption
    def _speech_started(self) -> None:
        self.emit("voice.state", {"state": "hearing"})
        self._maybe_interrupt("speech")

    def _maybe_interrupt(self, reason: str) -> None:
        if self.speaker.speaking:
            self.speaker.stop()
        if self.agent_busy or self.speaker.speaking:
            self._interrupted = True
            self.emit("voice.interrupt", {"reason": reason})

    # --------------------------------------------------------------------- PTT
    def ptt(self, down: bool) -> None:
        if down:
            with self._lock:
                if self._ptt:
                    return
                self._maybe_interrupt("ptt")
                self._ptt_buf = []
                self._ptt = True
            self.emit("voice.state", {"state": "listening", "mode": "ptt"})
            self._sync_mic()
        else:
            with self._lock:
                if not self._ptt:
                    return
                self._ptt = False
                audio = np.concatenate(self._ptt_buf) if self._ptt_buf else np.zeros(0, np.float32)
                self._ptt_buf = []
            self._sync_mic()
            if len(audio) < TARGET_RATE * 0.3:
                self.emit("voice.ignored", {"reason": "too_short"})
                self.emit("voice.state", {"state": "idle"})
                return
            threading.Thread(target=self._handle_utterance, args=(audio, "ptt"), daemon=True).start()

    # -------------------------------------------------------------- hands-free
    def set_hands_free(self, on: bool) -> None:
        with self._lock:
            if on == self._hands_free:
                return
            self._hands_free = on
            self._vad = EnergyVAD()
        self.emit("voice.state", {"state": "listening" if on else "idle", "mode": "hands_free"})
        self._sync_mic()

    def listen_once(self) -> None:
        """Capture exactly one utterance (used for voice confirmations)."""
        with self._lock:
            self._once = True
            self._vad = EnergyVAD()
        self.emit("voice.state", {"state": "listening", "mode": "once"})
        self._sync_mic()

    # -------------------------------------------------------------- transcribe
    def _handle_utterance(self, audio: np.ndarray, source: str) -> None:
        self.emit("voice.state", {"state": "transcribing"})
        t0 = time.monotonic()
        try:
            text = self.stt.transcribe(audio)
        except Exception as exc:
            self.emit("voice.error", {"message": f"Transcription failed: {exc}"})
            self._after_utterance()
            return
        interrupted, self._interrupted = self._interrupted, False

        if source == "hands_free" and not self._once and self.wake_word:
            need = not (self.agent_busy and not self.require_wake_when_busy) and not interrupted
            if need:
                matched, text2 = strip_wake_word(text, self.wake_word)
                if not matched:
                    self.emit("voice.ignored", {"reason": "no_wake_word", "heard": text})
                    self._after_utterance()
                    return
                text = text2
        if not text.strip():
            self.emit("voice.ignored", {"reason": "empty"})
        else:
            self.emit("voice.transcript", {
                "text": text.strip(), "source": source, "interrupt": interrupted,
                "once": self._once, "seconds": round(time.monotonic() - t0, 2)})
        self._after_utterance()

    def _after_utterance(self) -> None:
        if self._once:
            self._once = False
            self._sync_mic()
        self.emit("voice.state", {"state": "listening" if self._hands_free else "idle"})

    # --------------------------------------------------------------------- TTS
    def speak(self, text: str) -> None:
        self.speaker.speak(text)

    def stop_speaking(self) -> None:
        self.speaker.stop()

    def shutdown(self) -> None:
        self._hands_free = self._ptt = self._once = False
        self.speaker.stop()
        if self._mic:
            self._mic.stop()
            self._mic = None
