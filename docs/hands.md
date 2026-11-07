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
| `ui <target>` | `{ok, window, controls:[control], texts, elsewhere, note}`; Windows adds `source` (`"uia"` or `"ocr"`), and `ocr`, `ocrMs`, `ocrLang` when text recognition ran (see [Text recognition fallback (Windows)](#text-recognition-fallback-windows)) |
| `find-text <target> <text> [scroll]` | `{ok, matches:[match]}` |
| `image <in> <out.jpg> [--crop x,y,w,h] [--size w,h] [--marks <marks.json>]` | `{ok, file, sent:[w, h]}`: crop (source pixels), resize to exactly `size`, draw numbered boxes (`[{n, rect:[x,y,w,h]}]` in output pixels), write a JPEG. Used for numbered marks and closer looks (see `docs/pointing.md`) |
| `select <out.png> [--fit <edge>x<tokens>]` | `{ok, file}` after the user drags an area (a click picks the window under the pointer); Windows adds `sent: [w, h]` and scales to `--fit`. Esc, a right-click or running out of time gives exactly `{ok: false, cancelled: true}`. An area over a hands-off window is refused (`hands_off`) |
| `trusted [--prompt]` | `{ok, trusted}`. On Windows always `true`: there is no Accessibility permission to grant |
| `locate-control <target> <id>` | `{ok, window, control}`: where control `id` (the same ids as `ui`) is now; `not_found` if it's gone. `screen` targets are refused like `ui` |

- `window`: `{id, app, title, bounds}`.
- `control`: `{id, role, label, bounds, value?, focused?, offscreen?}`. At most 260, visible ones first and
  at most 40 offscreen. Roles use the macOS names (button, text field, password field, checkbox, radio,
  combo box, link, slider, tab, menu item, menu button, stepper, heading). Password values are never read.
- `texts`: visible text top to bottom (5000 characters max); `elsewhere`: text scrolled out of view (4000 max).
- `match`: `{text, match, role, bounds, window, rank}`; Windows adds `source` (`uia` or `ocr`). `match` is `exact`, `word` (whole word) or `partial`.
  Within a window: exact, then whole word, then partial; web-page text before browser toolbars; then the
  smallest box. Across windows: any exact match first, then by `rank` (front window first). At most 8 per
  window and 12 windows.
- `scroll`: if nothing whole is visible, scroll the best hidden whole match into view and search again.

## act: click and type in other apps

`act '<plan json>'` runs a list of steps in one window, the same steps and replies as `act` in
`hands/main.swift`. The plan is `{steps: [step], window?: <id from windows>, app?: <name>}` (neither = the
front window); at most 40 steps. Steps (`do` plus its arguments):

| `do` | Arguments | What it does |
| --- | --- | --- |
| `click`, `press_button` | `id` (from `ui`), `confirmed` | presses a control; text fields get the cursor |
| `focus` | `id` | puts the keyboard focus on a control |
| `set` | `id` (from `ui`), `text` | replaces the text of the control with that id and reads it back |
| `fill` | `field` (label, placeholder or `ui` id; empty = the only field in view), `text`, `near`, `id` | finds a field by its label, replaces its text and reads it back |
| `click_text` | `text`, `near`, `confirmed` | clicks visible text (a checkbox or radio by its label first) |
| `type` | `text` | types into the field that has the cursor |
| `choose` | `id` or `field`, `option`, `confirmed` | picks an option in a dropdown |
| `scroll` | `id` or `text` (visible words in the panel to scroll), `direction` (`up`/`down`/`left`/`right`), `amount`, `to_end` | scrolls a control or the window |
| `key` | `key` (`"enter"`, `"ctrl+shift+tab"`, …) | presses a key combo; `cmd` means Ctrl on Windows, `opt` Alt |
| `click_at` | `x`, `y`, `global` | clicks a point: window pixels from its top-left, or with `global: true` physical screen pixels (what pointing sends) |
| `wait` | `seconds` (max 5) | waits |

Replies: `{ok, unit, done, window}`; when a step changed something, also `controls` (same ids as `ui`) and
`texts` (2000 characters), read after the window settles. Errors: `{ok: false, code, error, done}`, where
`done` lists the steps that ran before it stopped.

How each step works on Windows (the window is brought to the front first and checked; the user watches):

- Clicks try UI Automation first (Invoke, then Toggle, then SelectionItem), then a real mouse click at the
  control's centre after scrolling it into view. An Invoke that times out (the app opened a dialog) counts as
  done and is never clicked twice.
- `set`/`fill` put the value in with ValuePattern and read it back; if it doesn't match, they select all and
  type it as Unicode keystrokes and read it back again. Still different = `mismatch`. Web page fields are typed
  first (pages ignore set values). Password fields are typed and reported as `••••`: Windows never gives
  their value back, so they can't be checked.
- Paste fallback (chat apps, some web editors): when both read-backs fail, `set`/`fill` paste the text with
  Ctrl+V and read it back once more (`done` says `(pasted)`). The clipboard is saved first and put back right
  after the paste, also when it fails; the pasted text is kept out of clipboard history and cloud clipboard.
  Only text and images are put back (files or formatting are lost, the same as dictation), and something the
  user copies in those ~350 ms is overwritten. Only Ctrl+A and Ctrl+V are sent, never Enter. Never used for
  password fields or for clearing a field. If the paste doesn't show either, the old text is put back where
  possible and the step fails with `mismatch`, saying whether it was put back.
- Mouse and keys go through `SendInput`; if Windows takes fewer events than sent, the step fails (`input`).
  Before sending, the helper waits up to 1.5 s for the user to let go of Ctrl, Alt, Shift or Win (`keys_held`).
- Before every step the front window is checked again: hands-off, input-only or administrator apps stop the
  plan, and `key`, `type` and `click_at` stop if another app came to the front and can't be sent back.

Safety (all checked before any input is sent):

- Hands-off apps (below) and input-only apps (`noInput` in `hands-off.json`, plus console and terminal windows by class in `noInputClasses`, whatever shell runs inside: terminals, PowerShell,
  Registry Editor, the management console; typing there would run commands past `sidecar/safety.mjs`) are
  refused with `code: "hands_off"`.
- Apps running at a higher integrity level than the helper (as administrator) are refused with
  `access_denied`: Windows would silently drop the input. An unknown level counts as higher.
- Key combos that switch windows or reach the secure desktop are refused with `blocked_key` before anything
  runs: Alt+Tab, Alt+Esc, Ctrl+Alt+Tab, Ctrl+Esc, Ctrl+Shift+Esc, Ctrl+Alt+Del, Ctrl+Alt+End and every combo
  with the Win key, also with extra modifiers.
- Risky labels (delete, send, pay, buy, …; the `RISKY` list in `hands/main.swift`, pinned by
  `hands-win/tests/fixtures/risky.json` and checked against `isRiskyClick` in `sidecar/safety.mjs`) need
  `confirmed: true`, else `code: "confirm"`.

Budgets: 6 s per step (`choose` 10 s, `scroll` with `to_end` 27 s, `wait` its seconds + 1), plus 6 s setup
(2.5 s to bring the window to front, 2.5 s for the first walk, 1 s margin), at most 120 s in all. Each step
gets only the time really left (minus 1 s), so a slow app runs out between steps, not halfway through input.
A step whose app stops answering returns `{ok: false, code: "timeout", error: "Step N: … didn't answer in
time", done}` instead of hanging.

## Text recognition fallback (Windows)

Games, videos, images and canvas apps share no UI Automation text. For those, the Windows helper reads the
window's own pixels (the same grab as `capture`, never written to disk) with `Windows.Media.Ocr`, in memory.

- `ui`: when the window has no named controls or no text, it is OCR'd. The reply gets `source: "ocr"`,
  `ocr: [{text, bounds, words:[{text, bounds}]}]` (at most 200 lines) and the line texts appended to `texts`.
  Otherwise `source: "uia"`.
- `find-text`: every match has `source: "uia"` or `"ocr"`. Each window whose UI Automation search had no
  visible hit is OCR'd, front to back while time lasts (hands-off and administrator windows are still
  skipped). OCR hits have role `text`, bounds narrowed to the matching words, and are ranked like the rest.
- Replies that ran OCR add `ocrMs` and `ocrLang`. Rects are physical screen pixels like everything else.
- Language: the user's Windows display languages, else `en-US` if installed. With neither, `ui` on a window
  with nothing through UI Automation replies `code: "ocr_unavailable"` (install a language with text
  recognition in Settings ▸ Time & language ▸ Language & region); with UI Automation content it keeps that and
  adds a note. `find-text` skips OCR, so a miss is still an empty `matches`.
- Budget: OCR starts only with at least 0.8 s left, otherwise the reply is `partial: true`. Images bigger than
  the engine's maximum are scaled down first and the rects scaled back.
- Speed: a 1920×1080 image with 36 lines of text takes p50 187 ms, p95 249 ms (release build, 30 runs,
  Intel i7-8700, Windows 10 22H2, `ocr_p95_full_hd`).

## Units

- macOS: points, global display coordinates.
- Windows: **physical screen pixels** in virtual-desktop coordinates (the helper is Per-Monitor V2 DPI
  aware). Every successful Windows reply adds `unit: "px"`; `windows`, `locate`, `locate-control` and `capture` also add
  `monitors: [{bounds, origin, scale, primary}]`, and each window has its monitor's `scale` (1.0 = 96 DPI).
  To get logical points for a monitor, subtract its `origin` and divide by its `scale`. The captured image
  covers exactly `window.bounds` (or `bounds` for a monitor) and is `sent` pixels big.
- `--fit <edge>x<tokens>` (Windows): resize the capture (or the `select` area) to the model's size, the same rule as `resizedSize` in
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
| `trusted` | 2 s | – |
| `locate-control` | 4 s | 3000 |
| `select` | 110 s (the sidecar stops the helper at 120 s) | – |

When the time or node cap runs out the reply is what was found so far, plus `partial: true` and
`partialReason: "time" | "nodes"`. If an app stops answering mid-call, the helper still answers 0.5 s after
the deadline and exits. A capture that runs out of time is an error (`code: "timeout"`), never half an image.
`--budget-ms N` overrides the time budget (tests).

The tree is read one level at a time with one cached property request, never a whole-subtree fetch, so a
slow app can't make one call build an unbounded tree. Chromium browsers are asked to build their page tree
first, so links and headings inside pages are found.

## Error codes (Windows)

`usage`, `not_found`, `minimized` (capture/ui of a minimized window, or one `act` can't restore), `access_denied` (the app runs as
administrator; Roamies can't read it), `hands_off`, `timeout`, `dpi` (the thread isn't Per-Monitor V2),
`capture_failed`, `unavailable` (the Windows screen-reading service, COM/UI Automation, couldn't start or
couldn't read this window; try again), `unsupported` (the helper was run on a system other than Windows),
`ocr_unavailable` (no text recognition language installed), `ocr_failed` (text recognition or the image
file failed). `act` adds `blocked_key`, `confirm` (risky label without `confirmed`), `focus` (Windows
wouldn't bring the window to the front, so nothing was sent), `not_editable` (`type` without a text field
focused), `mismatch` (a field didn't show the text after typing), `covered` (another window is over the
spot), `keys_held`, `input` (Windows dropped input).

## Hands-off

Roamies can point at any window but never reads, captures or types into secrets. On Windows the list is
`hands-win/hands-off.json` (password managers, Windows Security, admin and sign-in prompts, by exe and
window class): `capture`, `ui` and `find-text` refuse those windows with `code: "hands_off"`, and
`find-text screen` skips them. `act` also refuses them, and the `noInput` apps (terminals and system tools) too. Every exe in it is also in `DICTATION_BLOCK` in `sidecar/safety.mjs`
(checked by `test/safety.test.mjs`). On macOS the list is `HANDS_OFF` in `hands/main.swift`.

## Testing

```sh
cd showcase/tauri/src-tauri/hands-win
cargo test --locked                     # unit tests + CLI tests
cargo test --locked notepad -- --ignored  # opens Notepad and finds a known sentence (Windows desktop)
cargo test --locked act_fills -- --ignored --test-threads=1  # act fills Notepad and clicks a button in a WinForms window (moves the mouse and types: hands off the keyboard)
cargo test --release --locked ocr_p95_full_hd -- --ignored --nocapture   # OCR timing, p50/p95
cargo test --locked write_ocr_fixture -- --ignored                       # rebuilds tests/fixtures/ocr.png + ocr.json
cargo run --release -- find-text app:browser "Example Domain"
cargo run --release -- ocr-file tests/fixtures/ocr.png --origin -1920,240
```

`ocr-file <image.png> [--origin x,y]` (test-only) runs a PNG through the same text recognition path and prints
`{ok, unit, source: "ocr", lang, lines, ocrMs}`, rects shifted by `origin`. The fixture test checks every
word in `ocr.json` within 6 px. CI installs the English OCR language (`Language.OCR~~~en-US~0.0.1.0`)
first, so the test never skips.
