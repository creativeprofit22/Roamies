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
../bench-engines.sh              # both shipped engines (Moonshine small, Parakeet) on own + librispeech, one command

cd ../voice-win && ./fetch-model.sh                      # Parakeet int8, sha256-checked
cargo run --release -- --bench ../voice-rs/bench-data/own
```

`bench-data/` is gitignored, so recordings of the user's voice are never committed.

The bench feeds 100 ms chunks as fast as possible, running one engine per process. It measures:

- **WER**: corpus word error rate, after lowercasing and removing punctuation. Numbers and spelling are not
  normalised.
- **S/I/D**: the word errors split into substitutions, insertions and deletions, with the reference as the truth
  (jiwer's naming). On a tie the alignment counts a substitution first, then a deletion, then an insertion.
- **TTFP**: time to the first non-empty partial. This counts audio already fed plus compute, so it includes about
  1 s of the speaker's own lead-in.
- **Finish**: time spent inside `finish`.
- **RTF**: compute time ÷ audio time.
- **Peak RAM**: peak working set of the whole process.

Test machine: Intel i7-8700 @ 3.20 GHz (6 cores / 12 threads), 24 GB RAM, Windows x64, release build. Zipformer and
Moonshine tiny are from 30 Oct 2026; the two shipped engines were re-run with `bench-engines.sh` on 31 Oct 2026.

### Own voice (25 Roamies-style commands, 105.5 s, `bench-prompts.txt`)

| Engine / model | WER | S/I/D | TTFP median / p90 | Finish | RTF | Peak RAM |
|---|---|---|---|---|---|---|
| Zipformer int8 | 31.7 % | – | 1.61 / 1.96 s | 0.03 s | 0.10 | 157 MiB |
| Moonshine tiny streaming | 17.3 % | – | 1.23 / 1.78 s | 0.19 s | 0.64 | 152 MiB |
| **Moonshine small streaming** | **8.6 %** | 13 / 4 / 4 | 1.25 / 2.00 s | 0.10 s | 0.58 | 317 MiB |
| Parakeet TDT 0.6B v3 int8 | 4.9 % | 9 / 2 / 1 | n/a (finish-only) | 0.31 s | 0.07 | 820 MiB |

### LibriSpeech test-clean (first 200 utterances, 1818.5 s; CC BY 4.0, openslr SLR12)

| Engine / model | WER | S/I/D | TTFP median / p90 | Finish | RTF | Peak RAM |
|---|---|---|---|---|---|---|
| Zipformer int8 | 3.04 % | – | 1.29 / 1.61 s | 0.03 s | 0.11 | 154 MiB |
| Moonshine tiny streaming | 4.92 % | – | 1.19 / 1.28 s | 0.19 s | 0.55 | 175 MiB |
| **Moonshine small streaming** | **2.91 %** | 99 / 27 / 9 | 1.24 / 1.86 s | 0.24 s | 0.66 | 353 MiB |
| Parakeet TDT 0.6B v3 int8 | 1.99 % | 76 / 6 / 10 | n/a (finish-only) | 0.57 s | 0.07 | 1072 MiB |

Moonshine makes more insertions (27 vs 6 on LibriSpeech); Parakeet's errors are mostly substitutions. Timings moved between the two runs (Moonshine RTF 1.03 → 0.66, Parakeet 0.25 → 0.07)
with the same build and data, so treat timing differences under about 2× as machine noise.

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

## Voice metrics

Both Windows helpers add `metrics` to every `final` (and to the `nothing_heard` error, so empty takes count). It is
defined once in `voice-core/src/protocol.rs` and measured by `voice-core/src/metrics.rs`. The host logs it on the
`host.stt` telemetry step with `engine` and `role`; macOS speech has no metrics.

| Field | Meaning |
|---|---|
| `audio_s` | seconds of 16 kHz audio fed to the engine this take |
| `compute_s` | wall time inside the engine's `accept`/`partial`/`endpoint`/`finish` calls |
| `rtf` | `compute_s / audio_s` (missing with no audio); below 1 is faster than real time |
| `warmup_ms` | this take's engine `start()`, including the model load when it was cold |
| `speech_end_to_final_ms` | speech end (chord up or endpoint) → `final` sent, tail included |
| `time_to_first_partial_ms` | session start → first non-empty text; null for engines that don't stream (Parakeet) |
| `partial_count` | partials sent |
| `revision_rate` | characters revised / characters shown across successive partials and the final, from their common prefix; streaming only |
| `peak_rss_mb` | the helper's peak working set |
| `empty` | the final text is empty |

`npm run telemetry:report -- stt [days]` compares them per engine and role: count, empty rate, p50/p95 RTF,
speech end → final and first partial, mean revision rate, max peak RAM, mean shadow agreement and the
`stt_correction` rate per selected engine.

## Shadow mode

Settings › Voice Engine › "Compare With <other> in Background" (Windows, off by default) runs the engine you didn't
pick on the same take, as GitHub Scientist does with a control and a candidate: the selected engine's text is always
the one that is pasted, sent to the agent or shown; the other engine's result is only logged.

- While it's on, the primary helper keeps the take's 16 kHz audio in memory (60 s cap) and, right after `final`,
  sends it to the host as one `audio` line. It is never written to disk.
- The host forwards it as `transcribe` to a second helper started with `--shadow`: no mic, no keys, below-normal
  priority, model kept loaded while the setting is on. It answers only with `shadow` lines. Those go to telemetry
  (`host.stt_shadow`) and nowhere else; `src/voice/shadow.rs` tests that they can't reach dictation, the agent or
  the UI.
- It is skipped (logged as cancelled with `battery_saver`, `busy` or `not_installed`) when Windows battery saver is
  on, while the previous shadow job is still running, or when the other engine's model isn't downloaded. It never
  downloads a model.
- It needs telemetry: with Record Telemetry off (or `ROAMIES_TELEMETRY=off`) the shadow helper isn't started at all,
  since its results would be thrown away, and the menu item reads "(needs telemetry)". Turning telemetry back on
  starts it again.
- `host.stt_shadow` carries the shadow's metrics and `agreement` = 1 − word edits / longer word count between the two
  transcripts, plus `sub/ins/del` with the selected engine as reference. No text.

### Cost (measured 31 Oct 2026, same i7-8700, 25 own-voice takes, 105.5 s audio)

Each helper in `--shadow` mode, fed the takes one after another. CPU time and working set are read from the process
(`GetProcessTimes`, `GetProcessMemoryInfo`).

| Shadow engine | Compute (RTF) | CPU time | CPU while busy | Resident idle / after | Peak working set |
|---|---|---|---|---|---|
| Moonshine small (when Parakeet is selected) | 60.5 s (0.57) | 512 s | ~8.4 cores | 198 / 222 MiB | 301 MiB |
| Parakeet (when Moonshine is selected) | 7.4 s (0.07) | 32 s | ~3.1 cores | 676 / 809 MiB | 810 MiB |

- Parakeet as the shadow costs about 0.8 GB of RAM for as long as the setting is on, and a short CPU burst (about
  0.3 s CPU per second of speech).
- Moonshine as the shadow is light on RAM but heavy on CPU: it kept about 8 of 12 threads busy for the whole job (about 4.9 s CPU
  per second of speech), because it's a streaming model run as fast as it can. Below-normal priority keeps it behind
  the foreground app, but it will spin the fans.
- Both run after the selected engine's `final`, so they never delay the text you see.

## Correction signal

An `stt_correction` event is a free hint that a transcript was wrong. It holds the edit distance only; the text is
added only when "include text" is on. It fires on all platforms when:

- **Re-ask:** you send a request (typed or spoken) within 30 s of a spoken one, and the two differ by at most 40 % of
  the longer text (character-level Levenshtein over the normalized text).
- **Re-dictate:** you dictate again within 30 s of a dictation, with the same 40 % rule.

**Decision: Roamies does not watch the pasted field on Windows.** The spike (31 Oct 2026, read-only UI Automation
probe, Value then TextPattern over the target window) failed the gate of reading the pasted text back in ≥ 5 of 6
apps:

| App | Result |
|---|---|
| Notepad (Windows 11) | not readable: the window exposes 2 elements to the UIA client |
| Chrome textarea | readable only when Chrome is started with `--force-renderer-accessibility` |
| VS Code | not readable: Electron hides the editor text unless screen-reader mode is on |
| Word, Slack/Teams, Windows Terminal | not installed on the test PC, so they can't count towards the gate |

Making it work would mean turning on accessibility modes in other apps, adding the heavy `windows` crate, and
reading other apps' text fields for 30 s after every paste. That costs more privacy than a hint is worth. Re-ask and
re-dictate cover the criterion. Revisit only if a cheap, reliable read path shows up.

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

### When to revisit the default

The offline bench above stays the trusted accuracy number; real use decides whether Parakeet earns its size. The
default is reviewed with `telemetry:report -- stt` after **two weeks of use or 300 voice requests, whichever comes
first, with at least 100 requests per engine as the selected one** (turn shadow mode on so each take also scores
the other engine). The decision and the registry's `default` in `voice-engines.json` change together. Until that
data exists, Moonshine small stays the default.

## Packaging (Windows)

- **Helper:** `src-tauri/build.rs` builds `voice-rs` for `x86_64-pc-windows-msvc` into `binaries/roamies-voice-moonshine-<triple>.exe`, and the Parakeet helper (`voice-win`) into `binaries/roamies-voice-parakeet-<triple>.exe`; `tauri.windows.conf.json` ships both as `externalBin`. Which one runs is picked at runtime (see below). Other Windows targets are refused: there is no published arm64 Moonshine build, so the sidecar only turns voice on for win32 x64.
- **Runtime (bundled):** `moonshine.dll`, its `onnxruntime.dll`, the app-local MSVC runtime (`vcruntime140*.dll`, `msvcp140*.dll`, the set `dumpbin` reports) and the licences (`licenses/moonshine/`) are Tauri resources installed next to the app. `./build.sh` fetches them with `voice-rs/fetch-moonshine.sh --runtime`.
- **Models (downloaded):** Moonshine small (135.7 MiB) and Parakeet (~670 MB) are over the ~80 MB bundling limit, so the sidecar (`sidecar/voice-model.mjs`) downloads the chosen engine's model on demand into `%LOCALAPPDATA%\Roamies\models\<dir>`. Each file is checked against the sha256 pinned in `src-tauri/voice-engines.json` (a test keeps it in sync with `fetch-moonshine.sh` and `voice-win/fetch-model.sh`), downloads resume with HTTP Range, and the folder is renamed into place only when complete. Progress shows in a bubble and in the setup guide; until the model is there the helper reports `unavailable`.
- **Microphone:** `roamies-voice-moonshine --perms` reads the Windows microphone privacy setting; the setup guide's Microphone row opens `ms-settings:privacy-microphone`.
- **Checks:** CI runs each engine on a test clip; the release job installs the NSIS setup silently, checks these files (both licence folders included) and runs each installed helper with `--wav`.

## Choosing the engine

- **Registry:** `src-tauri/voice-engines.json` lists the engines in preferred order: id, label, helper binary, crate, `streaming`, engine args and model files (size + sha256). The host (`src/voice/engines.rs`), `build.rs` and the sidecar (`sidecar/voice-engines.mjs`) all read it. A new engine is one entry there plus its helper crate, a `binaries/<helper>` line in `tauri.windows.conf.json` `externalBin` and its licence folder (`model.licence.bundled`); `sidecar/test/voice-engines.test.mjs` fails until both are there. Add a `--wav` smoke step for it in `ci.yml`.
- **Setting:** `voiceEngine` in `sidekick.json` (`moonshine` by default; `voice` stays the on/off switch). The tray's Settings › Voice Engine lists every engine with its download state.
- **Rule:** use the configured engine if its model is installed and verified; else the first ready engine in registry order; if none is ready, the helper reports `unavailable` and the configured engine's model downloads. Picking an engine whose model is missing starts that download and keeps the ready one until it finishes.
- **Switching:** the host closes the old helper's stdin (it leaves its loop and releases the mic), kills it after 3 s if needed, ignores anything it still prints, and starts the new one. No app restart; both Computer Use and Dictation use it on the next press. Starts and stops are logged with engine and pid in `sidekick-voice.log`.
- **Non-streaming engines** (Parakeet) send no partials, so the overlay and setup guide say "Listening… I'll write it out when you stop", then "Writing it out…". Parakeet takes a few seconds to load after a switch, so the first press can wait.
