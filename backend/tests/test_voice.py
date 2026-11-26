import numpy as np
import pytest

from agent_os.voice.audio_in import resample
from agent_os.voice.tts import clean_for_speech, split_sentences
from agent_os.voice.vad import EnergyVAD
from agent_os.voice.wake import strip_wake_word

SR = 16_000


def tone(seconds: float, amp: float = 0.2, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def noise(seconds: float, amp: float = 0.002) -> np.ndarray:
    return (np.random.default_rng(0).standard_normal(int(SR * seconds)) * amp).astype(np.float32)


def run(vad: EnergyVAD, audio: np.ndarray):
    events = []
    for i in range(0, len(audio), 480):
        events += vad.process(audio[i : i + 480])
    return events


def test_vad_detects_one_utterance_in_silence():
    sig = np.concatenate([noise(1.0), tone(1.2), noise(1.5)])
    ev = run(EnergyVAD(), sig)
    kinds = [k for k, _ in ev]
    assert kinds == ["start", "end"]
    audio = ev[1][1]
    assert 1.2 <= len(audio) / SR <= 2.6  # utterance + pre-roll + trailing hangover


def test_vad_ignores_background_noise():
    assert run(EnergyVAD(), noise(5.0, amp=0.003)) == []


def test_vad_drops_tiny_clicks():
    sig = np.concatenate([noise(0.5), tone(0.1), noise(1.5)])
    kinds = [k for k, _ in run(EnergyVAD(), sig)]
    assert "end" not in kinds


def test_vad_two_utterances():
    sig = np.concatenate([noise(0.5), tone(0.8), noise(1.4), tone(0.8), noise(1.4)])
    assert [k for k, _ in run(EnergyVAD(), sig)] == ["start", "end", "start", "end"]


def test_vad_boost_raises_threshold_for_tts_echo():
    quiet_speech = np.concatenate([noise(0.5), tone(1.0, amp=0.03), noise(1.5)])
    assert any(k == "start" for k, _ in run(EnergyVAD(), quiet_speech))
    boosted = EnergyVAD()
    boosted.boost = 3.0
    assert run(boosted, quiet_speech) == []


def test_vad_flush_returns_partial_speech():
    vad = EnergyVAD()
    run(vad, np.concatenate([noise(0.5), tone(1.0)]))
    assert vad.speaking and vad.flush() is not None


@pytest.mark.parametrize("heard,expected_ok,rest", [
    ("Hey Claude, open Firefox", True, "open Firefox"),
    ("hey claude open the terminal", True, "open the terminal"),
    ("Hey, Claude. What time is it?", True, "What time is it?"),
    ("hey cloud open firefox", True, "open firefox"),
    ("Okay so anyway open firefox", False, None),
    ("hello there", False, None),
])
def test_wake_word(heard, expected_ok, rest):
    ok, remainder = strip_wake_word(heard, "hey claude")
    assert ok is expected_ok
    if expected_ok:
        assert remainder == rest


def test_empty_wake_word_accepts_everything():
    assert strip_wake_word("do a thing", "") == (True, "do a thing")


def test_resample_integer_ratio_and_passthrough():
    x = np.ones(480, dtype=np.float32)
    assert len(resample(x, 48000, 16000)) == 160
    assert resample(x, 16000, 16000) is x
    assert len(resample(np.ones(441, dtype=np.float32), 44100, 16000)) == 160


def test_split_sentences_and_cleaning():
    assert split_sentences("Hello there. How are you? Fine!") == ["Hello there.", "How are you?", "Fine!"]
    long = "word " * 120
    assert all(len(s) <= 220 for s in split_sentences(long))
    assert "code omitted" in clean_for_speech("Run ```rm -rf x``` now")
    assert clean_for_speech("**Bold** and [link](http://x.y)") == "Bold and link"
