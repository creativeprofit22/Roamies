# Screen helper (roamies-hands)

The sidecar reads the screen through a small helper it finds in `ROAMIES_HANDS`:

- macOS: `showcase/tauri/src-tauri/hands/main.swift` (Swift, accessibility tree).
- Windows x64: `showcase/tauri/src-tauri/hands-win` (Rust, UI Automation), built by `build.rs` into
  `binaries/roamies-hands-x86_64-pc-windows-msvc.exe` and bundled next to `roamies.exe`.

Both take their arguments on the command line and print one JSON object as the **last line** of stdout.
They always exit 0; failure is `{"ok": false, "error": "...", "code": "..."}`. Key sets are pinned in
`hands-win/tests/fixtures/shapes.json` and checked by the `protocol.rs` tests.

## Targets

`front` (the front window), `screen` (the primary monitor), `screen:<n>` (Windows only: monitor `n`, 1-based in
`monitors` order; `find-text` searches the windows whose centre is on it, `ui` refuses it), `app:<name>` (front-most window whose app name
or exe contains `<name>`, or the reverse, case-insensitive; `app:browser` means any of Chrome, Edge, Brave,
Firefox, Opera, Vivaldi, Chromium) and `window:<id>` (an id from `windows`).

## Verbs (shared with macOS)

| Verb | Reply |
| --- | --- |
| `windows` | `{ok, windows:[window]}` (the front app's windows have `frontApp: true`): up to 30 on-screen windows, front to back, at least 80×60, Roamies left out |
| `locate <target>` | `{ok, window}`, or `{ok, what:"screen"}` for `screen` |
| `capture <out.jpg> <target> [--fit <edge>x<tokens>]` | `{ok, file, window}`, or `{ok, file, what:"screen", bounds}` for `screen` / `screen:<n>`; Windows adds `sent: [w, h]` |
| `ui <target>` | `{ok, window, controls:[control], texts, elsewhere, note}` |
| `find-text <target> <text> [scroll]` | `{ok, matches:[match]}` |

- `window`: `{id, app, title, bounds}`.
- `control`: `{id, role, label, bounds, value?, focused?, offscreen?}`. At most 260, visible ones first and
  at most 40 offscreen. Roles use the macOS names (button, text field, password field, checkbox, radio,
  combo box, link, slider, tab, menu item, menu button, stepper, heading). Password values are never read.
- `texts`: visible text top to bottom (5000 characters max); `elsewhere`: text scrolled out of view (4000 max).
- `match`: `{text, match, role, bounds, window, rank}`. `match` is `exact`, `word` (whole word) or `partial`.
  Within a window: exact, then whole word, then partial; web-page text before browser toolbars; then the
  smallest box. Across windows: any exact match first, then by `rank` (front window first). At most 8 per
  window and 12 windows.
- `scroll`: if nothing whole is visible, scroll the best hidden whole match into view and search again.

`select`, `act`, `trusted` and `locate-control` are macOS-only for now.

## Units

- macOS: points, global display coordinates.
- Windows: **physical screen pixels** in virtual-desktop coordinates (the helper is Per-Monitor V2 DPI
  aware). Every successful Windows reply adds `unit: "px"`; `windows`, `locate` and `capture` also add
  `monitors: [{bounds, origin, scale, primary}]`, and each window has its monitor's `scale` (1.0 = 96 DPI).
  To get logical points for a monitor, subtract its `origin` and divide by its `scale`. The captured image
  covers exactly `window.bounds` (or `bounds` for a monitor) and is `sent` pixels big.
- `--fit <edge>x<tokens>` (Windows): resize the capture to the model's size, the same rule as `resizedSize` in
  `sidecar/pointing.mjs` (`tokens` 0 = no token limit). Both are checked against
  `hands-win/tests/fixtures/resize.json`. Without it, `sent` is the bounds' own size.

## Budgets and partial results (Windows)

Each verb runs on a worker thread with a deadline, and every UI Automation node visited counts toward a cap:

| Verb | Time | Nodes |
| --- | --- | --- |
| `windows`, `locate` | 2 s | – |
| `capture` | 5 s | – |
| `ui` | 4 s | 3000 |
| `find-text` | 6 s total | 4000 per window, 12 windows |

When the time or node cap runs out the reply is what was found so far, plus `partial: true` and
`partialReason: "time" | "nodes"`. If an app stops answering mid-call, the helper still answers 0.5 s after
the deadline and exits. A capture that runs out of time is an error (`code: "timeout"`), never half an image.
`--budget-ms N` overrides the time budget (tests).

The tree is read one level at a time with one cached property request, never a whole-subtree fetch, so a
slow app can't make one call build an unbounded tree. Chromium browsers are asked to build their page tree
first, so links and headings inside pages are found.

## Error codes (Windows)

`usage`, `not_found`, `minimized` (capture/ui of a minimized window), `access_denied` (the app runs as
administrator; Roamies can't read it), `hands_off`, `timeout`, `dpi` (the thread isn't Per-Monitor V2),
`capture_failed`, `unavailable` (the Windows screen-reading service, COM/UI Automation, couldn't start or
couldn't read this window; try again), `unsupported` (the helper was run on a system other than Windows).

## Hands-off

Roamies can point at any window but never reads, captures or types into secrets. On Windows the list is
`hands-win/hands-off.json` (password managers, Windows Security, admin and sign-in prompts, by exe and
window class): `capture`, `ui` and `find-text` refuse those windows with `code: "hands_off"`, and
`find-text screen` skips them. Every exe in it is also in `DICTATION_BLOCK` in `sidecar/safety.mjs`
(checked by `test/safety.test.mjs`). On macOS the list is `HANDS_OFF` in `hands/main.swift`.

## Testing

```sh
cd showcase/tauri/src-tauri/hands-win
cargo test --locked                     # unit tests + CLI tests
cargo test --locked -- --ignored        # opens Notepad and finds a known sentence (Windows desktop)
cargo run --release -- find-text app:browser "Example Domain"
```
