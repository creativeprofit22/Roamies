# Voice engines

`roamies-voice-moonshine` (`showcase/tauri/src-tauri/voice-rs`) has two speech engines behind one `SpeechEngine` trait:

- **Moonshine streaming** (`--engine moonshine`, the default). It uses Moonshine's own C runtime and loads it at
  runtime from `moonshine.dll`, so the helper still starts without it. The model is set with
  `--moonshine-size tiny|small|medium` (default `small`).
- **Zipformer** (`--engine zipformer`). This is streaming Zipformer int8 through sherpa-onnx, linked statically.

The `ready` event reports what loaded, for example `{"type":"ready","engine":"moonshine","model":"small-streaming-en"}`.

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

### LibriSpeech test-clean (first 200 utterances, 1818.5 s; CC BY 4.0, openslr SLR12)

| Engine / model | WER | TTFP median / p90 | Finish | RTF | Peak RAM |
|---|---|---|---|---|---|
| Zipformer int8 | 3.04 % | 1.29 / 1.61 s | 0.03 s | 0.11 | 154 MiB |
| Moonshine tiny streaming | 4.92 % | 1.19 / 1.28 s | 0.19 s | 0.55 | 175 MiB |
| **Moonshine small streaming** | **2.91 %** | 1.35 / 1.94 s | 0.38 s | 1.03 | 356 MiB |

### Size on disk

| Engine / model | Model | Runtime |
|---|---|---|
| Zipformer int8 | 67.6 MiB | 18.8 MiB (helper exe with sherpa + ONNX Runtime) |
| Moonshine tiny streaming | 43.1 MiB | 22.7 MiB (`moonshine.dll` + `onnxruntime.dll`) |
| Moonshine small streaming | 135.7 MiB | 22.7 MiB |

For comparison, Parakeet's int8 model alone is about 600 MB or more.

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

- **Helper:** `src-tauri/build.rs` builds `voice-rs` for `x86_64-pc-windows-msvc` into `binaries/roamies-voice-moonshine-<triple>.exe`, and upstream's Parakeet helper (`voice-win`) into `binaries/roamies-voice-parakeet-<triple>.exe`; `tauri.windows.conf.json` ships both as `externalBin`. The host launches Moonshine until runtime engine selection lands. Other Windows targets are refused: there is no published arm64 Moonshine build, so the sidecar only turns voice on for win32 x64.
- **Runtime (bundled):** `moonshine.dll`, its `onnxruntime.dll`, the app-local MSVC runtime (`vcruntime140*.dll`, `msvcp140*.dll`, the set `dumpbin` reports) and the licences (`licenses/moonshine/`) are Tauri resources installed next to the app. `./build.sh` fetches them with `voice-rs/fetch-moonshine.sh --runtime`.
- **Model (downloaded):** Moonshine small (135.7 MiB) is over the ~80 MB bundling limit, so the sidecar (`sidecar/voice-model.mjs`) downloads it on first enable into `%LOCALAPPDATA%\Roamies\models\moonshine-small`. Each file is checked against the sha256 pinned in `fetch-moonshine.sh` (a test keeps the two in sync), downloads resume with HTTP Range, and the folder is renamed into place only when complete. Progress shows in a bubble and in the setup guide; until the model is there the helper reports `unavailable`.
- **Microphone:** `roamies-voice-moonshine --perms` reads the Windows microphone privacy setting; the setup guide's Microphone row opens `ms-settings:privacy-microphone`.
- **Checks:** CI runs the default engine on a test clip; the release job installs the NSIS setup silently, checks these files and runs the installed helper with `--wav`.
