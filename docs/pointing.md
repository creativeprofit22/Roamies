# Pointing

How `point_at` turns "where is X?" into a box on screen. The sidecar decides (`sidecar/pointing.mjs`, pure and
tested on every OS); the screen helpers only capture, read controls and draw (`image` verb, see `docs/hands.md`).

## Paths, in the order the model is told to try them

| Path | When | Where the box comes from |
| --- | --- | --- |
| `text` | The target has visible text | The helper's `find-text` match |
| `mark` | A window shot with known controls | The chosen mark's real control rect (`lastShot.marks`) |
| `id` | A control id from `ui` | That control's rect |
| `box` / `point` | Anything else (thumbnails, canvas, OCR-less areas) | The model's pixel box or point, mapped through the shot |
| `refine` | A `box` smaller than 80 image px on both sides, when refine is on | A second answer on a crop around the first box |

- **Numbered marks.** For `window:<id>` shots `take_screenshot` runs `ui` (Windows: `--budget-ms 1500`) in
  parallel with the capture. `pickMarks` keeps visible controls (or OCR lines) whose centre is on the shot,
  at least 6 px on each side, drops near-duplicates (IoU > 0.8), sorts top to bottom by row then left to right,
  numbers them 1..N (at most 60) and the helper draws them. The tool text lists them (`3 button "Save"`).
  Whole-screen shots get no marks.
- **Crop-and-refine.** The target is recaptured at native resolution and cropped around the box (side =
  max(3 × box side, 160 px), kept on the shot), upscaled up to 2×, and sent back asking for the box again in
  the crop's pixels. The crop becomes the shot map (offset = crop origin), flagged so that answer always points:
  at most one extra pass.
- Settings: `POINTING` in `sidecar/pointing.mjs`. Telemetry: `hands.marks`, `hands.crop`, `pointing.locate`
  (see `docs/telemetry.md`).

## Benchmark

```sh
cd showcase/tauri/sidecar
npm run bench:pointing -- [dir] [--model <id>] [--modes raw,marks,refine] [--repeat n] [--out file]
```

Needs a signed-in model (like the app) and spends tokens (about 90 calls); not run in CI. Each case replays the
real `take_screenshot` and `point_at` tools on a saved window, with the real Windows helper drawing marks and
crops, and stops at the first point. Scores: centre of the box inside the expected box, and IoU ≥ 0.5 (overlap
over union). Modes: `raw` (no marks, no refine), `marks` (marks only), `refine` (refine only). Writes
`bench-pointing.json`.

Fixtures: `sidecar/test/fixtures/pointing/<name>/` with `shot.jpg`, `ui.json` (the helper's `ui` reply plus
the shot bounds) and `cases.json` (`[{ask, truth: [x, y, w, h]}]` in screen pixels). Stock Windows apps only,
no personal data. Add one with `node bench/capture-fixture.mjs <name> window:<id>`, then write its cases.

## Results

4 November 2026, `claude-haiku-5-5`, Windows 11, 7 windows (Calculator, Character Map, Control Panel, Edge on
example.com, Notepad, Paint, Settings), 29 cases, one run each:

| mode | n | centre in | IoU ≥ 0.5 | p50 ms | p95 ms | paths |
| --- | --- | --- | --- | --- | --- | --- |
| raw | 29 | 93% | 79% | 3268 | 6509 | box 26, point 3 |
| marks | 29 | 100% | 90% | 3577 | 6050 | mark 12, box 17 |
| refine | 29 | 97% | 66% | 3960 | 7636 | box 13, refine 14, point 2 |

- Marks: every case where the model chose a mark was exact (IoU 1.00), and its plain boxes also got tighter
  with the numbers on screen. It fixed both raw misses (Control Panel date format, Paint rectangle shape).
- Refine: ran on 14 cases and made the box worse on most of them (IoU ≥ 0.5 drops from 79% to 66%) while
  adding about 2 s per refined case. It only helped on the Paint rectangle shape (IoU 0 → 0.79).

## Default

**Marks on, refine off** (`POINTING = { marks: true, refine: false, … }`). Refine stays in the code and can be
switched on to re-measure (for example with a stronger model or a set of tiny targets).
