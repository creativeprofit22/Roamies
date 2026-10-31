# Voice engines

`roamies-voice-moonshine` (`showcase/tauri/src-tauri/voice-rs`) has two speech engines behind one `SpeechEngine` trait:

- **Moonshine streaming** (`--engine moonshine`, the default). It uses Moonshine's own C runtime and loads it at
  runtime from `moonshine.dll`, so the helper still starts without it. The model is set with
  `--moonshine-size tiny|small|medium` (default `small`).
- **Zipformer** (`--engine zipformer`). This is streaming Zipformer int8 through sherpa-onnx, linked statically.

The `ready` event reports what loaded, for example `{"type":"ready","engine":"moonshine","model":"small-streaming-en"}`.

`roamies-voice-parakeet` (`showcase/tauri/src-tauri/voice-win`) runs **NVIDIA Parakeet TDT 0.6B v3** (int8 ONNX,
through `parakeet-rs`). It is finish-only: no live partial text, the whole take is read when it ends. Its `ready` is
`{"type":"ready","engine":"parakeet","model":"tdt-0.6b-v3-int8"}`.

### Layout

Both helpers share `showcase/tauri/src-tauri/voice-core` (`roamies-voice-core`), so the host sees one protocol:

- `protocol`: the stdout events, stdin commands, error codes (`unavailable`, `no_input`, `nothing_heard`,
  `permission`) and `MicStatus`.
- `engine`: the `SpeechEngine` trait. `streaming()` is `false` for Parakeet.
- `chord` / `session`: the chord and hands-free state machine and the loop that emits events. For a finish-only
  engine, hands-free ends 1.5 s after the voice pauses and cancels if no voice comes.
- `level`, `score`: the mic level meter and the bench's WER helpers (`normalize`, `word_edits`).

Each helper keeps only its own engine, mic capture, key polling, permission check and bench.

## Setup

```sh
cd showcase/tauri/src-tauri/voice-rs
./fetch-moonshine.sh            # Windows x64 runtime + small model (add tiny/medium to fetch others)
./fetch-model.sh                # Zipformer int8
cargo run --release -- --chord ctrl,alt
```

`fetch-moonshine.sh` downloads the pinned `v0.1.5` Windows runtime (sha256-checked). It links the static libs into
`models/moonshine-runtime/moonshine.dll` with MSVC `link.exe`, so Visual Studio Build Tools are needed. It then
downloads each model's files into `models/moonshine-<size>/`. The tiny and small model files are sha256-pinned and
checked. Medium downloads unverified, with a `warning: no pinned sha256` line per file, until its hashes are pinned in
`SHA` in `fetch-moonshine.sh`.

Moonshine publishes no Windows arm64 build, so arm64 is a packaging follow-up. Our `moonshine.dll` is built `/MD`
and needs the MSVC runtime (`vcruntime140.dll`, `msvcp140.dll`) on the target machine. Packaging must ship it or
require it.

## Benchmark

```sh
./fetch-testset.sh              # first 200 LibriSpeech test-clean utterances -> bench-data/librispeech
cargo run --release -- --record bench-data/own   # read bench-prompts.txt aloud, one clip each
./bench.sh bench-data/own       # zipformer, moonshine tiny, moonshine small; appends to bench-data/results.log

cd ../voice-win && ./fetch-model.sh                      # Parakeet int8, sha256-checked
cargo run --release -- --bench ../voice-rs/bench-data/own
```

`bench-data/` is gitignored, so recordings of the user's voice are never committed.

The bench feeds 100 ms chunks as fast as possible, running one engine per process. It measures:

- **WER**: corpus word error rate, after lowercasing and removing punctuation. Numbers and spelling are not
  normalised.
- **TTFP**: time to the first non-empty partial. This counts audio already fed plus compute, so it includes about
  1 s of the speaker's own lead-in.
- **Finish**: time spent inside `finish`.
- **RTF**: compute time ÷ audio time.
- **Peak RAM**: peak working set of the whole process.

Test machine: Intel i7-8700 @ 3.20 GHz (6 cores / 12 threads), 24 GB RAM, Windows x64, release build, 30 Oct 2026.

### Own voice (25 Roamies-style commands, 105.5 s, `bench-prompts.txt`)

| Engine / model | WER | TTFP median / p90 | Finish | RTF | Peak RAM |
|---|---|---|---|---|---|
| Zipformer int8 | 31.7 % | 1.61 / 1.96 s | 0.03 s | 0.10 | 157 MiB |
| Moonshine tiny streaming | 17.3 % | 1.23 / 1.78 s | 0.19 s | 0.64 | 152 MiB |
| **Moonshine small streaming** | **8.6 %** | 1.49 / 2.20 s | 0.19 s | 1.16 | 299 MiB |
| Parakeet TDT 0.6B v3 int8 | 4.9 % | n/a (finish-only) | 0.56 s | 0.13 | 808 MiB |

### LibriSpeech test-clean (first 200 utterances, 1818.5 s; CC BY 4.0, openslr SLR12)

| Engine / model | WER | TTFP median / p90 | Finish | RTF | Peak RAM |
|---|---|---|---|---|---|
| Zipformer int8 | 3.04 % | 1.29 / 1.61 s | 0.03 s | 0.11 | 154 MiB |
| Moonshine tiny streaming | 4.92 % | 1.19 / 1.28 s | 0.19 s | 0.55 | 175 MiB |
| **Moonshine small streaming** | **2.91 %** | 1.35 / 1.94 s | 0.38 s | 1.03 | 356 MiB |
| Parakeet TDT 0.6B v3 int8 | 1.99 % | n/a (finish-only) | 1.97 s | 0.25 | 1073 MiB |

Parakeet's WER uses the same normalisation (`voice-core` `score::normalize`). Its finish time is the whole
transcription, since nothing runs during the take. Model load takes about 7 s, once per helper start.

### Size on disk

| Engine / model | Model | Runtime |
|---|---|---|
| Zipformer int8 | 67.6 MiB | 18.8 MiB (helper exe with sherpa + ONNX Runtime) |
| Moonshine tiny streaming | 43.1 MiB | 22.7 MiB (`moonshine.dll` + `onnxruntime.dll`) |
| Moonshine small streaming | 135.7 MiB | 22.7 MiB |
| Parakeet TDT 0.6B v3 int8 | 639.4 MiB | 23.4 MiB (helper exe with ONNX Runtime; uses the system `DirectML.dll`) |

### Parakeet: blank text on short clips

Unpadded, Parakeet returned empty text for 12 of the 25 own-voice clips, nearly all short commands. Probing showed:

- The mel features (`parakeet-rs`) match NeMo's preprocessor, and the TDT greedy decode loop is correct.
  It is not a `parakeet-rs` bug and not frame alignment.
- The int8 encoder emits only blanks when speech starts right at the first frame. It needs some low-energy
  context first. The whole-clip feature normalisation plays a smaller part.
- Silence only at the end does not help. Silence at the end also made long takes (16-21 s) stop after the first
  sentence. Low-level noise as padding made things much worse.

The fix (`pad_for_parakeet` in `voice-win/src/engine.rs`) puts 1.5 s of zeros before each take and nothing after.
A sweep of 0.25-2 s lead (on own-voice clips, mixed short/long takes and LibriSpeech) found 1.5 s the only value
with no blanks and the lowest WER; 1 s each side scored 4.1 % on LibriSpeech with one blank and cut long takes.
`transcribe-rs` pads 250 ms the same way. `voice-win/tests/cli.rs` `short_clip_is_not_blank` reads a 1.9 s clip that
comes back blank without the fix.

On the user's voice, Zipformer (trained only on LibriSpeech) breaks down on conversational commands. For example,
"Open my downloads folder" became "OPEN MY DULLNESS FULLER", and "in Lisbon this weekend" became "ELIZABETH WAKINS".
Most of Moonshine small's remaining errors are formatting: "Summarize" vs "Summarise", "24th" vs "twenty fourth",
and "25" vs "twenty five". The real miss rate is lower than 8.6 %.

## Licences

- **Moonshine.** I read `LICENSE` in full at tag `v0.1.5` (commit `bf6ae1590d0928fd704772d0e80d6fef39424be8`). The
  code is MIT. All streaming models and all English models are MIT. Only the older non-streaming models for other
  languages use the non-commercial Moonshine Community License, and we don't ship any of them. The models we use
  (`tiny-streaming-en`, `small-streaming-en`) are **MIT**. The licence is saved with the runtime as
  `models/moonshine-runtime/licenses/moonshine-LICENSE`.
- **Third-party code in the Moonshine runtime.** `core/third-party` is excluded from Moonshine's MIT grant. Its
  licences are saved in `models/moonshine-runtime/licenses/`:
  - ONNX Runtime (MIT)
  - kaldi-native-fbank (Apache-2.0)
  - Eigen (MPL-2.0)
  - nlohmann/json (MIT)
  - utf8proc (MIT-style)
  - utf-8 (Boost Software License 1.0)
  - kissfft (BSD-style)
  - doctest (MIT)

  Packaging must ship these notices.
- **Text-to-speech and grapheme-to-phoneme models.** Moonshine's MIT default doesn't cover these, but we don't use
  them.
- **Zipformer and sherpa-onnx.** Both are Apache-2.0.
- **Parakeet.** NVIDIA `parakeet-tdt-0.6b-v3` weights are **CC BY 4.0**, so attribution must ship. We use the ONNX
  int8 export `istupakov/parakeet-tdt-0.6b-v3-onnx` at revision `8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce`
  (conversion and quantisation by istupakov, nothing else changed). The notice is
  `voice-win/licenses/parakeet-NOTICE.txt`, bundled as `licenses/parakeet/` and opened from the tray's "Licences…".
  `parakeet-rs` is MIT/Apache-2.0.

## Decision

**Default: Moonshine, `small-streaming-en` (`--engine moonshine --moonshine-size small`).**

The rule is the best accuracy on the user's own voice, while staying well under Parakeet's size and RAM. Ties go to
the faster first partial, and only MIT models count.

- **Accuracy.** Moonshine small makes about a quarter of Zipformer's word errors on the user's voice (8.6 % vs
  31.7 %), and half of tiny's errors. It is also the best on LibriSpeech (2.9 %).
- **Size.** It is about 160 MiB on disk with its runtime and about 300-370 MiB peak RAM, a fraction of Parakeet.
- **Licence.** MIT.

The caveat is that its RTF is about 1.0-1.16 on this 2017 6-core CPU, which is borderline for real time. Partials
can lag on slower machines, though Moonshine throttles itself and catches up at the end. Moonshine tiny
(`--moonshine-size tiny`, RTF 0.55-0.64, 17 % WER on the user's voice) is the fallback for weak hardware. Zipformer
stays available but is not shipped by default.

**Packaging uses:** `moonshine.dll` + `onnxruntime.dll` + licences from `models/moonshine-runtime/`, the
`models/moonshine-small/` model files, and the MSVC runtime. The helper runs with its defaults (`--engine moonshine`,
`--moonshine-size small`).

## Packaging (Windows)

- **Helper:** `src-tauri/build.rs` builds `voice-rs` for `x86_64-pc-windows-msvc` into `binaries/roamies-voice-moonshine-<triple>.exe`, and the Parakeet helper (`voice-win`) into `binaries/roamies-voice-parakeet-<triple>.exe`; `tauri.windows.conf.json` ships both as `externalBin`. Which one runs is picked at runtime (see below). Other Windows targets are refused: there is no published arm64 Moonshine build, so the sidecar only turns voice on for win32 x64.
- **Runtime (bundled):** `moonshine.dll`, its `onnxruntime.dll`, the app-local MSVC runtime (`vcruntime140*.dll`, `msvcp140*.dll`, the set `dumpbin` reports) and the licences (`licenses/moonshine/`) are Tauri resources installed next to the app. `./build.sh` fetches them with `voice-rs/fetch-moonshine.sh --runtime`.
- **Models (downloaded):** Moonshine small (135.7 MiB) and Parakeet (~670 MB) are over the ~80 MB bundling limit, so the sidecar (`sidecar/voice-model.mjs`) downloads the chosen engine's model on demand into `%LOCALAPPDATA%\Roamies\models\<dir>`. Each file is checked against the sha256 pinned in `src-tauri/voice-engines.json` (a test keeps it in sync with `fetch-moonshine.sh` and `voice-win/fetch-model.sh`), downloads resume with HTTP Range, and the folder is renamed into place only when complete. Progress shows in a bubble and in the setup guide; until the model is there the helper reports `unavailable`.
- **Microphone:** `roamies-voice-moonshine --perms` reads the Windows microphone privacy setting; the setup guide's Microphone row opens `ms-settings:privacy-microphone`.
- **Checks:** CI runs each engine on a test clip; the release job installs the NSIS setup silently, checks these files (both licence folders included) and runs each installed helper with `--wav`.

## Choosing the engine

- **Registry:** `src-tauri/voice-engines.json` lists the engines in preferred order: id, label, helper binary, crate, `streaming`, engine args and model files (size + sha256). The host (`src/voice/engines.rs`), `build.rs` and the sidecar (`sidecar/voice-engines.mjs`) all read it. A new engine is one entry there plus its helper crate.
- **Setting:** `voiceEngine` in `sidekick.json` (`moonshine` by default; `voice` stays the on/off switch). The tray's Settings › Voice Engine lists every engine with its download state.
- **Rule:** use the configured engine if its model is installed and verified; else the first ready engine in registry order; if none is ready, the helper reports `unavailable` and the configured engine's model downloads. Picking an engine whose model is missing starts that download and keeps the ready one until it finishes.
- **Switching:** the host closes the old helper's stdin (it leaves its loop and releases the mic), kills it after 3 s if needed, ignores anything it still prints, and starts the new one. No app restart; both Computer Use and Dictation use it on the next press. Starts and stops are logged with engine and pid in `sidekick-voice.log`.
- **Non-streaming engines** (Parakeet) send no partials, so the overlay and setup guide say "Listening… I'll write it out when you stop", then "Writing it out…". Parakeet takes a few seconds to load after a switch, so the first press can wait.
