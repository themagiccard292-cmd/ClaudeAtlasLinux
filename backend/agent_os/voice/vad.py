"""Small energy-based voice activity detector with adaptive noise floor.

Feeds 16 kHz float32 blocks, emits ('start', None) when speech begins and
('end', audio) when it ends. Pure NumPy so it works inside the frozen binary.
"""
from __future__ import annotations

from collections import deque

import numpy as np


class EnergyVAD:
    def __init__(
        self,
        sample_rate: int = 16_000,
        frame_ms: int = 30,
        start_ms: int = 150,
        end_ms: int = 900,
        pre_roll_ms: int = 300,
        min_rms: float = 0.012,
        factor: float = 3.0,
        min_utterance_ms: int = 240,
        max_utterance_s: float = 30.0,
    ) -> None:
        self.sr = sample_rate
        self.frame = int(sample_rate * frame_ms / 1000)
        self.start_frames = max(1, start_ms // frame_ms)
        self.end_frames = max(1, end_ms // frame_ms)
        self.pre_roll = deque(maxlen=max(1, pre_roll_ms // frame_ms))
        self.min_rms = min_rms
        self.factor = factor
        self.min_frames = max(1, min_utterance_ms // frame_ms)
        self.max_frames = int(max_utterance_s * 1000 / frame_ms)
        self.boost = 1.0  # >1 raises the threshold (e.g. while TTS is playing)
        self.floor = min_rms / factor
        self._buf = np.zeros(0, dtype=np.float32)
        self._reset()

    def _reset(self) -> None:
        self.speaking = False
        self._voiced = 0
        self._voiced_total = 0  # voiced frames in the current utterance (pre-roll excluded)
        self._silent = 0
        self._speech: list[np.ndarray] = []
        self._pending: list[np.ndarray] = []

    @property
    def threshold(self) -> float:
        return max(self.min_rms, self.floor * self.factor) * self.boost

    def process(self, block: np.ndarray) -> list[tuple[str, np.ndarray | None]]:
        events: list[tuple[str, np.ndarray | None]] = []
        self._buf = np.concatenate([self._buf, block.astype(np.float32, copy=False)])
        while len(self._buf) >= self.frame:
            frame, self._buf = self._buf[: self.frame], self._buf[self.frame :]
            events.extend(self._frame(frame))
        return events

    def _frame(self, frame: np.ndarray) -> list[tuple[str, np.ndarray | None]]:
        rms = float(np.sqrt(np.mean(frame * frame)) + 1e-9)
        voiced = rms > self.threshold
        out: list[tuple[str, np.ndarray | None]] = []

        if not self.speaking:
            if not voiced:  # track noise floor only on non-speech frames
                self.floor = 0.97 * self.floor + 0.03 * rms
            self.pre_roll.append(frame)
            if voiced:
                self._voiced += 1
                self._pending.append(frame)
                if self._voiced >= self.start_frames:
                    self.speaking = True
                    self._speech = list(self.pre_roll)
                    self._pending = []
                    self._silent = 0
                    self._voiced_total = self._voiced
                    out.append(("start", None))
            else:
                self._voiced = 0
                self._pending = []
            return out

        self._speech.append(frame)
        self._silent = 0 if voiced else self._silent + 1
        self._voiced_total += voiced
        if self._silent >= self.end_frames or len(self._speech) >= self.max_frames:
            audio = np.concatenate(self._speech)
            n_voiced_frames = self._voiced_total
            pre = list(self.pre_roll)
            self._reset()
            self.pre_roll.clear()
            self.pre_roll.extend(pre[-1:])
            if n_voiced_frames >= self.min_frames:
                out.append(("end", audio))
            else:
                out.append(("cancel", None))
        return out

    def flush(self) -> np.ndarray | None:
        """Return whatever is buffered (used when the stream is closed mid-speech)."""
        if self.speaking and self._speech:
            audio = np.concatenate(self._speech)
            self._reset()
            return audio
        return None
