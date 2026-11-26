"""Low-latency text-to-speech with graceful fallback.

Engines (all keyless):
  edge    – Microsoft Edge neural voices via `edge-tts` (best quality, needs internet)
  piper   – fully local neural TTS (`piper-tts`, voice model auto-downloaded once)
  espeak  – `espeak-ng` binary (robotic but always available offline)

Text is split into sentences; sentence N+1 is synthesised while N is playing,
and `stop()` cuts playback within one audio block (voice interruption).
"""
from __future__ import annotations

import asyncio
import io
import queue
import re
import shutil
import subprocess
import threading
import wave
from typing import Callable, Iterator

import numpy as np

from ..config import models_dir
from ..runner import clean_env

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
Chunk = tuple[np.ndarray, int]  # (int16 mono samples, sample rate)


def split_sentences(text: str, max_len: int = 220) -> list[str]:
    parts: list[str] = []
    for raw in SENTENCE_SPLIT.split(text.strip()):
        s = raw.strip()
        while len(s) > max_len:  # hard-wrap pathological run-on text at a space
            cut = s.rfind(" ", 0, max_len) or max_len
            parts.append(s[:cut])
            s = s[cut:].strip()
        if s:
            parts.append(s)
    return parts


def clean_for_speech(text: str) -> str:
    text = re.sub(r"```.*?```", " code omitted. ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[*_#>]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


# ----------------------------------------------------------------------------- engines
class TTSUnavailable(Exception):
    pass


class EdgeEngine:
    name = "edge"

    def __init__(self, voice: str, rate: str) -> None:
        self.voice, self.rate = voice, rate

    def synthesize(self, text: str) -> Iterator[Chunk]:
        try:
            import av
            import edge_tts
        except ImportError as exc:
            raise TTSUnavailable(f"edge-tts/av missing: {exc.name}") from exc

        async def collect() -> bytes:
            comm = edge_tts.Communicate(text, self.voice, rate=self.rate)
            buf = bytearray()
            async for msg in comm.stream():
                if msg["type"] == "audio":
                    buf += msg["data"]
            return bytes(buf)

        try:
            mp3 = asyncio.run(collect())
        except Exception as exc:  # offline, blocked, DNS ...
            raise TTSUnavailable(f"edge-tts failed: {exc}") from exc
        if not mp3:
            raise TTSUnavailable("edge-tts returned no audio")

        container = av.open(io.BytesIO(mp3))
        resampler = av.AudioResampler(format="s16", layout="mono", rate=24_000)
        pcm: list[np.ndarray] = []
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                pcm.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None) or []:
            pcm.append(out.to_ndarray().reshape(-1))
        container.close()
        if pcm:
            yield np.concatenate(pcm).astype(np.int16), 24_000


PIPER_VOICE_DEFAULT = "en_US-lessac-medium"


class PiperEngine:
    name = "piper"
    _voice = None
    _voice_name = ""
    _lock = threading.Lock()

    def __init__(self, voice: str) -> None:
        self.voice_name = voice if re.fullmatch(r"[a-z]{2}_[A-Z]{2}-[\w]+-\w+", voice or "") else PIPER_VOICE_DEFAULT

    def _load(self):
        with PiperEngine._lock:
            if PiperEngine._voice is not None and PiperEngine._voice_name == self.voice_name:
                return PiperEngine._voice
            try:
                from piper import PiperVoice
                from piper.download_voices import download_voice
            except ImportError as exc:
                raise TTSUnavailable("piper-tts not installed") from exc
            dest = models_dir() / "piper"
            dest.mkdir(parents=True, exist_ok=True)
            model = dest / f"{self.voice_name}.onnx"
            if not model.exists():
                try:
                    download_voice(self.voice_name, dest)
                except Exception as exc:
                    raise TTSUnavailable(f"could not download piper voice: {exc}") from exc
            PiperEngine._voice = PiperVoice.load(model)
            PiperEngine._voice_name = self.voice_name
            return PiperEngine._voice

    def synthesize(self, text: str) -> Iterator[Chunk]:
        voice = self._load()
        rate = voice.config.sample_rate
        for chunk in voice.synthesize(text):
            yield np.frombuffer(chunk.audio_int16_bytes, dtype=np.int16), rate


class EspeakEngine:
    name = "espeak"

    def __init__(self, voice: str = "en") -> None:
        self.voice = voice if re.fullmatch(r"[A-Za-z0-9+_-]{1,20}", voice or "") else "en"

    def synthesize(self, text: str) -> Iterator[Chunk]:
        exe = shutil.which("espeak-ng") or shutil.which("espeak")
        if not exe:
            raise TTSUnavailable("espeak-ng not installed")
        res = subprocess.run([exe, "--stdout", "-v", self.voice, "--", text], capture_output=True,
                             env=clean_env(), timeout=30)
        if res.returncode != 0 or not res.stdout:
            raise TTSUnavailable("espeak failed")
        with wave.open(io.BytesIO(res.stdout)) as wf:
            data = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
            yield data, wf.getframerate()


# ----------------------------------------------------------------------------- speaker
class Speaker:
    """Owns the playback thread. Thread-safe: `speak()` / `stop()` from anywhere."""

    def __init__(self, emit: Callable[[str, dict], None]) -> None:
        self.emit = emit
        self.engine_name = "edge"
        self.voice = "en-US-AriaNeural"
        self.rate = "+0%"
        self.output_device: int | str | None = None
        self.volume = 1.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self.speaking = False
        self.last_engine_used = ""

    def configure(self, engine: str | None = None, voice: str | None = None, rate: str | None = None,
                  output_device: int | str | None = None, volume: float | None = None) -> None:
        if engine:
            self.engine_name = engine
        if voice:
            self.voice = voice
        if rate:
            self.rate = rate
        if output_device is not None:
            self.output_device = output_device if output_device != "" else None
        if volume is not None:
            self.volume = max(0.0, min(float(volume), 1.5))

    # ------------------------------------------------------------------ public
    def speak(self, text: str, interrupt: bool = True) -> None:
        if self.engine_name == "off":
            return
        text = clean_for_speech(text)
        if not text:
            return
        if interrupt:
            self.stop()
        with self._lock:
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, args=(text,), name="tts", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=1.5)

    # ----------------------------------------------------------------- internals
    def _engines(self) -> list:
        order = {"edge": ["edge", "piper", "espeak"], "piper": ["piper", "espeak"], "espeak": ["espeak"]}
        built = []
        for name in order.get(self.engine_name, ["edge", "piper", "espeak"]):
            if name == "edge":
                built.append(EdgeEngine(self.voice if "Neural" in self.voice else "en-US-AriaNeural", self.rate))
            elif name == "piper":
                built.append(PiperEngine(self.voice if self.engine_name == "piper" else PIPER_VOICE_DEFAULT))
            else:
                built.append(EspeakEngine())
        return built

    def _synth_sentence(self, engines: list, sentence: str) -> list[Chunk]:
        last: Exception | None = None
        for eng in list(engines):
            try:
                chunks = list(eng.synthesize(sentence))
                self.last_engine_used = eng.name
                # Stick with the first engine that works for the rest of this utterance.
                engines[:] = [eng]
                return chunks
            except TTSUnavailable as exc:
                last = exc
                engines.remove(eng)
        raise TTSUnavailable(str(last) if last else "no TTS engine available")

    def _run(self, text: str) -> None:
        sentences = split_sentences(text)
        q: queue.Queue = queue.Queue(maxsize=2)
        engines = self._engines()

        def producer() -> None:
            try:
                for s in sentences:
                    if self._stop.is_set():
                        break
                    q.put(self._synth_sentence(engines, s))
            except Exception as exc:
                q.put(exc)
            finally:
                q.put(None)

        threading.Thread(target=producer, name="tts-synth", daemon=True).start()
        self.speaking = True
        self.emit("voice.state", {"state": "speaking"})
        try:
            import sounddevice as sd

            while not self._stop.is_set():
                item = q.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    self.emit("voice.error", {"message": f"Text-to-speech unavailable: {item}"})
                    break
                for samples, rate in item:
                    self._play(sd, samples, rate)
        except Exception as exc:
            self.emit("voice.error", {"message": f"Audio playback failed: {exc}"})
        finally:
            self.speaking = False
            self._stop.set()
            self.emit("voice.level", {"level": 0.0, "source": "tts"})
            self.emit("voice.state", {"state": "idle"})

    def _play(self, sd, samples: np.ndarray, rate: int) -> None:
        block = max(256, rate // 40)  # ~25 ms → also the interruption latency
        with sd.OutputStream(samplerate=rate, channels=1, dtype="int16", device=self.output_device) as out:
            for i in range(0, len(samples), block):
                if self._stop.is_set():
                    break
                chunk = samples[i : i + block]
                if self.volume != 1.0:
                    chunk = np.clip(chunk.astype(np.float32) * self.volume, -32768, 32767).astype(np.int16)
                out.write(chunk.reshape(-1, 1))
                rms = float(np.sqrt(np.mean((chunk.astype(np.float32) / 32768.0) ** 2)))
                self.emit("voice.level", {"level": min(1.0, rms * 6), "source": "tts"})
