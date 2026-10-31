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
| `host.voice_session` | host | `listening` → `idle` (all platforms, incl. macOS) | `mode`, `streaming` |
| `host.dictation_paste` | host | paste start → done | |
| `host.request_typed` | host | event: a typed request was sent | |
| `agent.request` | sidecar | enqueued → reply done | `source` (`voice`, `typed`, `reminder`, `snap`), `model`, `provider`, `calls`, `tools`, `in`, `cacheRead`, `cacheWrite`, `out`, `image` |
| `agent.queue_wait` | sidecar | enqueued → run starts | |
| `agent.first_text` | sidecar | event: first reply text from the model | |
| `agent.turn` | sidecar | one model call | `in`, `cacheRead`, `cacheWrite`, `out` |
| `agent.tool` | sidecar | tool call start → end | `name`, `anim`, `variant` |
| `dictation.check` | sidecar | event: safety verdict for a dictation | `level` |
| `voice_model.download` | sidecar | download start → ready/error | `engine` |
| `ui.listen_shown` | webview | event: listening bubble on screen | `mode` |
| `ui.first_bubble` | webview | agent `start` → first text shown | |
| `telemetry.dropped` | sidecar | event: events dropped (queue full or write failed) | `count`, `reason` |
| `telemetry.capped` | sidecar | event: day file hit the size cap | `bytes` |

Error codes on `agent.request`: `not_signed_in`, `rate_limited`, `auth`, `aborted` (outcome `cancelled`),
`failed`. On `voice.session`: `no_input`, `unavailable`, `nothing_heard`, `permission`.

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
