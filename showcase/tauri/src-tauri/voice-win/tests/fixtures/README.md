`en-short-1s.wav` is the first 1.9 s of `voice-rs/tests/fixtures/en-short.wav` ("After early nightfall, the"),
which is `test_wavs/0.wav` from the sherpa-onnx model `sherpa-onnx-streaming-zipformer-en-2023-06-26`
(k2-fsa/sherpa-onnx `asr-models` release, Apache-2.0), a LibriSpeech utterance. 16 kHz mono 16-bit.
Trimmed with Python's `wave` module. Without the silence padding in `src/engine.rs`, Parakeet reads it as blank.
