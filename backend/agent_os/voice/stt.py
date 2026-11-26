"""Local speech-to-text with faster-whisper (no API key; model cached on disk)."""
from __future__ import annotations

import threading
from typing import Callable

import numpy as np

from ..config import models_dir


class SpeechToText:
    def __init__(self, model_name: str = "base.en", language: str | None = "en",
                 on_status: Callable[[str], None] | None = None) -> None:
        self.model_name = model_name
        self.language = language or None
        self._model = None
        self._lock = threading.Lock()
        self._on_status = on_status or (lambda _s: None)

    def configure(self, model_name: str | None = None, language: str | None = None) -> None:
        with self._lock:
            if model_name and model_name != self.model_name:
                self.model_name = model_name
                self._model = None  # reload lazily
            if language is not None:
                self.language = language or None

    def ensure_loaded(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            from faster_whisper import WhisperModel

            self._on_status(f"Loading speech model “{self.model_name}” (first use downloads it)…")
            self._model = WhisperModel(
                self.model_name, device="cpu", compute_type="int8",
                download_root=str(models_dir()), cpu_threads=max(2, (__import__("os").cpu_count() or 4) // 2),
            )
            self._on_status("")

    def transcribe(self, audio: np.ndarray) -> str:
        """`audio`: mono float32 @ 16 kHz."""
        self.ensure_loaded()
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)
        if len(audio) < 16_000 * 0.25:
            return ""
        # Normalise very quiet recordings so Whisper doesn't hallucinate on silence.
        peak = float(np.max(np.abs(audio))) or 1.0
        if peak < 0.5:
            audio = audio * (0.7 / peak)
        segments, _info = self._model.transcribe(  # type: ignore[union-attr]
            audio, language=self.language, beam_size=1, vad_filter=True,
            condition_on_previous_text=False, temperature=0.0,
            vad_parameters={"min_silence_duration_ms": 400},
        )
        return " ".join(seg.text.strip() for seg in segments).strip()
