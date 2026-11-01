# Telemetry

Roamies keeps a local, private log of how long each part of a request takes, so slow or failing steps can
be found later. It never leaves the computer: there is no network sink, and a test
(`sidecar/test/telemetry-offline.test.mjs`) fails if any telemetry module imports a network API.

## Where it lives

`~/.gg/sidekick/telemetry/YYYY-MM-DD.jsonl` (under `$ROAMIES_DATA_DIR/sidekick/` when that is set). One JSON
object per line, one file per local day. The folder is created with mode `0700` and files with `0600`.
Tray: **Settings ▸ Telemetry ▸ Open Telemetry Folder**.

Only the sidecar writes the file. The other layers hand their events to it:

| layer | module | how events reach the file |
|---|---|---|
| Rust host | `src-tauri/src/telemetry.rs` | `{type:'telemetry', events}` on the sidecar's stdin |
| voice helpers (Windows) | `voice-core/src/telemetry.rs` | `{"type":"telemetry","event":…}` protocol lines on stdout; the host forwards them |
| Node sidecar | `sidecar/telemetry.mjs` | writes the file |
| webview | `showcase/roamies/telemetry.js` | `invoke('sidecar_send', {msg:{type:'telemetry', events}})`, batched every 1 s |

All four have the same API: **start** a step (returns a handle), **end** it with an outcome, **record** a
one-off event. None imports another layer's code.

## Event schema, version 1

| field | type | meaning |
|---|---|---|
| `schema` | `1` | bumped on a breaking change |
| `ts` | integer | Unix epoch milliseconds (UTC) when the event happened, producer's wall clock |
| `app_version` | string | Roamies version (filled in by the sidecar if the producer left it empty) |
| `os` | string | `darwin`, `win32`, `linux` (filled in by the sidecar if empty) |
| `request_id` | 32 hex chars or `null` | one per user action; `null` only for app-level events (startup, model download) |
| `step_id` | 16 hex chars | the same id on a step's `start` and `end` |
| `parent_step_id` | 16 hex chars or `null` | the step this one runs inside |
| `kind` | `start`, `end` or `event` | |
| `step` | dotted name | one of the steps below |
| `component` | `host`, `voice`, `sidecar` or `webview` | which layer produced it |
| `duration_ms` | number or `null` | on `end`: measured with a monotonic clock |
| `outcome` | `ok`, `error`, `cancelled` or `null` | on `end` |
| `error_code` | snake_case or `null` | e.g. `nothing_heard`, `not_signed_in`, `rate_limited` |
| `attrs` | object | small typed map, see below |

`attrs` values are numbers, booleans or short identifier strings (`/^[\w.:\/-]{0,64}$/`): engine names,
model ids, tool names. No free text. Anything else is dropped from the event (the rest of the event is kept).
The only exception is the `text` and `reply` keys, which hold what was said and the reply, and only when
**Include What Was Said** is on (see Privacy).

Durations: every step writes a `start` and an `end` with the same `step_id`, so any interval can be computed
by pairing events or subtracting `ts` (for example "chord down → first reply text" across components). The
`end` event also carries `duration_ms` for the common case.

## Steps

| step | component | from → to | attrs |
|---|---|---|---|
| `voice.session` | voice | chord down (back-dated) → idle | `engine`, `mode`, `streaming`, `audio_ms`, `chars` |
| `voice.listen` | voice | listening shown → finish | `mode` |
| `voice.finalize` | voice | engine `finish()` call | `chars` |
| `voice.mic_open` | voice | chord armed → microphone open (child of `voice.session`) | |
| `voice.engine_start` | voice | engine `start()` for this talk | `engine`, `warm` |
| `voice.stt` | voice | speech end (finish) → final text, Windows engines | `chars` |
| `voice.warmup` | voice | model load (`prepare()`), no request id | `engine`, `model` |
| `host.voice_session` | host | `listening` → `idle` (all platforms, incl. macOS) | `mode`, `streaming`, `retry`, `retry_of` |
| `host.stt` | host | helper `processing` → `final` (any engine, incl. macOS) | Windows engines: `engine`, `role` (`primary`) and the voice metrics from `final` (or the `nothing_heard` error): `audio_s`, `compute_s`, `rtf`, `warmup_ms`, `speech_end_to_final_ms`, `time_to_first_partial_ms`, `partial_count`, `revision_rate`, `peak_rss_mb`, `empty`. Missing values are left out. See `docs/voice-engines.md` |
| `host.stt_shadow` | host | event: shadow mode's other engine finished the same take (outcome `cancelled` when skipped) | `engine`, `primary_engine`, `role` (`shadow`), the same metrics (no `time_to_first_partial_ms`), `agreement`, `sub`, `ins`, `del`. Never text |
| `stt_correction` | sidecar | event: a voice request re-asked or a dictation re-dictated within 30 s | `kind` (`reask`, `redictate`), `edit_distance`, `chars`, `of`, `engine`; `text` only with include text on |
| `host.dictation_paste` | host | paste start → done | |
| `host.clipboard_save` / `host.clipboard_set` / `host.key_send` / `host.clipboard_restore` | host | the parts of a paste (children of `host.dictation_paste`) | |
| `host.dictation_copy` | host | copy-only dictation (no paste) | |
| `host.request_typed` | host | event: a typed request was sent | |
| `agent.handoff` | sidecar | host sent the message (`sent_ms`) → sidecar received it | |
| `agent.request` | sidecar | enqueued → reply done | `source` (`voice`, `typed`, `reminder`, `snap`), `model`, `provider`, `calls`, `tools`, `in`, `cacheRead`, `cacheWrite`, `out`, `image`, `first_text_ms`, `retry`, `retry_of`, `retry_after_ms` |
| `agent.queue_wait` | sidecar | enqueued → run starts | |
| `agent.first_text` | sidecar | event: first reply text from the model | |
| `agent.turn` | sidecar | one model call (generation span) | `model`, `provider`, `ttft_ms` (call start → first streamed token), `stream_ms` (first → last token), `in`, `cacheRead`, `cacheWrite`, `out` |
| `agent.tool` | sidecar | tool call start → end | `name`, `anim`, `variant` |
| `agent.safety` | sidecar | one `safety.mjs` check (child of its `agent.tool`) | `check` (`read`, `write`, `url`, `open`, `command`, `click`), `level` |
| `dictation.check` | sidecar | safety check of the dictation target | `level` |
| `voice_model.download` | sidecar | download start → ready/error | `engine` |
| `ui.error_shown` | sidecar | event: an error bubble was shown | |
| `ui.listen_shown` | webview | event: listening bubble on screen | `mode` |
| `ui.first_bubble` | webview | agent `start` → first text shown | |
| `ui.reply_paint` | webview | reply event reached the page → bubble painted (`performance.mark`/`measure`; "painted" is two `requestAnimationFrame`s later) | |
| `telemetry.dropped` | sidecar | event: events dropped (queue full or write failed) | `count`, `reason` |
| `telemetry.capped` | sidecar | event: day file hit the size cap | `bytes` |
| `sidecar.error` | sidecar | event: a logged `console.error` (outcome `error`, code from its label), with the request id when one is running | |

### Error codes

Every error path that shows a bubble or logs also writes an event with outcome `error` and one of these codes.

| where | codes |
|---|---|
| `agent.request`, `agent.turn` | `not_signed_in`, `rate_limited`, `auth`, `failed`; cancels (outcome `cancelled`): `user_stop` (Stop menu), `interrupted` (a new talk), `aborted` |
| `agent.tool` / `agent.safety` | `tool_error` / `safety_blocked` |
| `voice.session` | `no_input`, `unavailable`, `nothing_heard`, `permission`, `user_cancel` (cancelled) |
| `voice.warmup` | `model_load_failed` |
| `ui.error_shown` (the bubble) | `sign_in_needed`, `permission`, `no_input`, `nothing_heard`, `dictation_off`, `stt_failed`, `dictation_blocked`, `paste_failed`, `login_failed`, `login_busy`, `login_item_approval`, `snap_failed`, `update_failed`, `update_download_failed`, voice model download codes |
| `dictation.check` | `dictation_blocked` |
| `host.dictation_paste` and its parts | `paste_failed`, `copy_failed`, `key_send_failed` |
| `host.helper_start` / `host.helper_exit` | `helper_missing`, `helper_spawn_failed` / `helper_crashed` |
| `host.sidecar_start` / `host.sidecar_exit` | `node_missing`, `sidecar_spawn_failed` / `sidecar_exited` |
| `host.update_check` / `host.update_download` | `update_check_failed` / `update_download_failed` |
| `host.shortcut`, `host.error` | `shortcut_taken`; `hotkeys_unavailable`, `menu_build_failed`, `guide_open_failed` |
| `sidecar.error` | the `console.error` label (`prompt_failed`, …) or `unexpected` |
| `host.telemetry_backlog` | `telemetry_dropped` |
| `host.stt_shadow` (cancelled) | `battery_saver`, `busy`, `not_installed`, `not_running` |

### Retries and cancels

A request or talk that starts within 10 s of a failed or cancelled one gets `retry: true` and `retry_of` (the
earlier request id); `agent.request` also gets `retry_after_ms`.

## App lifecycle

No request id. Startup and restarts:

| step | component | from → to | attrs / codes |
|---|---|---|---|
| `host.cold_start` | host | process start → tray ready | |
| `host.sidecar_start` | host | sidecar spawn → first line on its stdout | `attempt` |
| `host.sidecar_exit` | host | event: the sidecar exited | `code`; outcome `error`, `sidecar_exited` |
| `sidecar.boot` | sidecar | Node process start → start-up done | |
| `host.helper_start` | host | voice helper spawn → `ready` | `engine`, `attempt` |
| `host.helper_exit` | host | event: the helper exited on its own | `code`, `crashes`, `restart`; `helper_crashed` |
| `host.update_check` / `host.update_download` | host | updater check / download and install | `found` |
| `app.memory` | sidecar | event, every 60 s while there was a request, talk or dictation in the last 60 s | `host_mb`, `sidecar_mb`, `helper_mb`, `heap_mb` |
| `host.shortcut` | host | event: a shortcut couldn't be registered | `which` |
| `host.error` | host | event: a host failure that is otherwise only logged | |
| `host.telemetry_backlog` | host | event: held host events were dropped before a sidecar was running | `dropped` |

The helper is restarted after up to 3 crashes in a row; `ready` resets the count. Memory: the sidecar sends
`{type:'memory_probe'}` and the host answers `{type:'memory', host, helper}` (RSS in bytes, or `null`); host
values are left out if there is no answer within 2 s.

Host events written while the sidecar isn't running (start-up, a crash), and `voice.*` events the host
forwards from the voice helper in that time, wait in a backlog of 500 (oldest
dropped and counted in a `host.telemetry_backlog` event) and are sent when the next sidecar starts.

### Hand-off

The host adds `sent_ms` (epoch ms) to `voice`, `dictation` and typed `answer` messages. The sidecar turns it into
`agent.handoff`, ignored if missing, in the future or older than 60 s.

## Request ids

One id per user action, minted by the host (`telemetry::new_request_id()`), except requests that start in
the sidecar (reminders, the area-snap typed fallback), which the sidecar mints in the same format.

- **Talk chord.** The host keeps one pending id and sends it to the helper as
  `{"cmd":"request","request_id":…}` when the helper starts and after each use. The id is bound when a
  press becomes a talk (the `listening` state), so presses that were shortcuts never use one up. The helper
  back-dates its `voice.session` start to the chord-down time. If the helper has no pending id it mints one,
  and the host takes the id from the helper's `voice.session` start.
- **Area snap.** `{"cmd":"listen","request_id":…}`.
- **Typed request.** The webview's `{type:'answer'}` goes through the host's `sidecar_send`, which adds
  `request_id` to non-empty answers.
- The host adds `request_id` to `voice`, `voice_state`, `voice_error` and `dictation` messages for the
  sidecar, and to voice messages for the overlays. The sidecar adds it to `agent` `start`/`done`/`error` ui
  events, so the webview can tag its own steps, and to `dictation_paste`/`dictation_copy` for the host.

The macOS Swift helper is unchanged: it ignores unknown commands and fields. On macOS the host's
`host.voice_session` covers the voice part.

## Turning it off

The menu toggle (Settings > Telemetry) stops all writing. `ROAMIES_TELEMETRY=off` in the sidecar's environment
forces it off whatever the config says. `npm run test:telemetry-off` runs the whole sidecar suite that way;
`test/telemetry-chain.test.mjs` runs one mocked request with telemetry on and off and checks the UI output is
the same and nothing is written.

## Reading it

```sh
npm run telemetry:report -- chain <request_id>   # one request's steps in order, indented by parent
npm run telemetry:report -- p95 [days]           # steps ranked by p95, with error and retry rates
npm run telemetry:report -- stt [days]           # voice engines compared by engine and role (primary, shadow)
```

It reads `~/.gg/sidekick/telemetry` (or `ROAMIES_DATA_DIR`, or `--dir <folder>`).

## Defaults

| setting | default |
|---|---|
| flush | every 2 s, or at 200 queued events, and when the app quits |
| queue cap | 2000 events; the oldest are dropped and counted in a `telemetry.dropped` event |
| size cap | 20 MB per day file; later events that day are dropped, with one `telemetry.capped` event |
| retention | 14 days; older day files are deleted at start-up and at each new day |
| webview batch | every 1 s |

Writes are async (`fs.promises.appendFile`). Every write error is swallowed and counted; the app never waits
on or fails because of telemetry.

## Privacy

- On by default (`telemetry: true` in `sidekick.json`); **Settings ▸ Telemetry ▸ Record Telemetry (stays on
  this computer)** turns it off everywhere. Off: the sidecar drops all events and tells the host, which stops
  the helper's and overlays' events too.
- No audio, transcript or reply text is ever recorded unless **Include What Was Said** is on
  (`telemetryText: false` by default). Only the sidecar adds text, and it runs through gg-ai's
  `redactText`/`redactValue` (API keys, tokens, `password=` values) first.
- Tool arguments go through `redactArgs` from `safety.mjs`, and only identifiers survive (tool name, which
  animation it played). File paths, commands and URLs are not recorded.

## OTLP mapping

The schema maps onto OpenTelemetry spans, so an `otlp-sink` module can be added beside the JSONL sink
without changing producers:

| ours | OTLP span |
|---|---|
| `request_id` | `traceId` |
| `step_id` | `spanId` |
| `parent_step_id` | `parentSpanId` |
| `step` | `name` |
| `start.ts`, `end.ts` | `startTimeUnixNano`, `endTimeUnixNano` (× 1e6) |
| `outcome` | `status.code` (`ok` → OK, `error` → ERROR, `cancelled` → UNSET + attribute) |
| `error_code` | `status.message` |
| `component`, `app_version`, `os` | resource attributes `service.name`, `service.version`, `os.type` |
| `attrs` | span attributes |
| `kind: event` | a zero-length span, or a span event on its parent |

## Overhead

Cost of one `start` + `end` pair on the calling thread, p95 over 2000 pairs (Windows dev machine,
debug builds):

| layer | p95 | measured by |
|---|---|---|
| host (Rust, incl. JSON encoding) | 0.15 ms | `src-tauri` `telemetry::tests::overhead_p95_under_one_ms` |
| voice helper (Rust, incl. the stdout JSON line) | 0.07 ms | `voice-core` `telemetry::tests::overhead_p95_under_one_ms` |
| sidecar (Node, queueing only) | 0.01 ms | `npm run bench:telemetry` (20 000 pairs written to a temp dir; heap +0.06 MB, RSS +1–2 MB) |
| webview (JS, queueing only) | 0.03 ms | one-off run of `roamies/telemetry.js` under Node (no test) |

The tests fail if p95 reaches 1 ms. File writes happen off the hot path: batched every 2 s or 200 events,
appended asynchronously by the sidecar.
