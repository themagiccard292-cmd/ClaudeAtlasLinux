"""Microphone capture (sounddevice → PortAudio → ALSA / PulseAudio / PipeWire).

Delivers 16 kHz mono float32 blocks. If the chosen device cannot open at 16 kHz
the stream is opened at its native rate and resampled.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

TARGET_RATE = 16_000
BLOCK_MS = 30


def list_devices() -> dict:
    """Returns {'input': [...], 'output': [...], 'default_input': idx|None, 'default_output': idx|None}."""
    try:
        import sounddevice as sd
    except Exception as exc:
        return {"input": [], "output": [], "default_input": None, "default_output": None,
                "error": f"sounddevice unavailable: {exc}"}
    try:
        devices = sd.query_devices()
        default_in, default_out = sd.default.device
        hostapis = sd.query_hostapis()
    except Exception as exc:
        return {"input": [], "output": [], "default_input": None, "default_output": None, "error": str(exc)}

    def entry(i: int, d: dict) -> dict:
        return {"index": i, "name": d["name"], "hostapi": hostapis[d["hostapi"]]["name"],
                "sample_rate": int(d["default_samplerate"])}

    ins = [entry(i, d) for i, d in enumerate(devices) if d["max_input_channels"] > 0]
    outs = [entry(i, d) for i, d in enumerate(devices) if d["max_output_channels"] > 0]
    return {"input": ins, "output": outs,
            "default_input": default_in if default_in is not None and default_in >= 0 else None,
            "default_output": default_out if default_out is not None and default_out >= 0 else None}


def resample(block: np.ndarray, src_rate: int, dst_rate: int = TARGET_RATE) -> np.ndarray:
    if src_rate == dst_rate:
        return block
    if src_rate % dst_rate == 0:  # e.g. 48k -> 16k: block-average (cheap anti-alias)
        k = src_rate // dst_rate
        n = (len(block) // k) * k
        return block[:n].reshape(-1, k).mean(axis=1).astype(np.float32)
    n_out = int(len(block) * dst_rate / src_rate)
    return np.interp(np.linspace(0, len(block) - 1, n_out), np.arange(len(block)), block).astype(np.float32)


class MicStream:
    def __init__(self, on_block: Callable[[np.ndarray], None], device: int | str | None = None) -> None:
        self.on_block = on_block
        self.device = device
        self._stream = None
        self._backend = ""
        self._src_rate = TARGET_RATE

    @property
    def running(self) -> bool:
        return self._stream is not None

    def start(self) -> None:
        if self._stream is not None:
            return
        try:
            self._start_sounddevice()
        except ImportError:
            self._start_pyaudio()

    # ------------------------------------------------------------ sounddevice
    def _start_sounddevice(self) -> None:
        import sounddevice as sd

        def cb(indata, frames, time_info, status):  # PortAudio thread
            block = indata[:, 0].astype(np.float32, copy=True)
            self.on_block(resample(block, self._src_rate))

        last_exc: Exception | None = None
        rates = [TARGET_RATE]
        try:
            info = sd.query_devices(self.device, "input")
            rates.append(int(info["default_samplerate"]))
        except Exception as exc:
            last_exc = exc
        for rate in dict.fromkeys(rates):
            try:
                self._stream = sd.InputStream(
                    samplerate=rate, channels=1, dtype="float32", device=self.device,
                    blocksize=int(rate * BLOCK_MS / 1000), callback=cb)
                self._src_rate = rate
                self._stream.start()
                self._backend = "sounddevice"
                return
            except Exception as exc:
                last_exc = exc
                self._stream = None
        raise RuntimeError(f"Cannot open microphone: {last_exc}")

    # ---------------------------------------------------------------- pyaudio
    def _start_pyaudio(self) -> None:
        import pyaudio  # noqa: F401 (ImportError propagates as 'no mic backend')

        pa = pyaudio.PyAudio()

        def cb(in_data, frame_count, time_info, status):
            block = np.frombuffer(in_data, dtype=np.int16).astype(np.float32) / 32768.0
            self.on_block(block)
            return (None, pyaudio.paContinue)

        idx = self.device if isinstance(self.device, int) else None
        stream = pa.open(format=pyaudio.paInt16, channels=1, rate=TARGET_RATE, input=True,
                         input_device_index=idx, frames_per_buffer=int(TARGET_RATE * BLOCK_MS / 1000),
                         stream_callback=cb)
        stream.start_stream()
        self._stream = (pa, stream)
        self._backend = "pyaudio"

    def stop(self) -> None:
        s, self._stream = self._stream, None
        if s is None:
            return
        try:
            if self._backend == "sounddevice":
                s.stop()
                s.close()
            else:
                pa, stream = s
                stream.stop_stream()
                stream.close()
                pa.terminate()
        except Exception:
            pass
