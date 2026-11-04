// Hands helper for Roamies on Windows: lets the agent see windows, capture one, read its controls and find
// text on screen. One command per run; prints one JSON object as its last stdout line (see docs/hands.md).
//
//   roamies-hands windows                                    visible windows, front to back
//   roamies-hands locate front|screen|screen:<n>|app:<name>|window:<id>  which window that is, without capturing
//   roamies-hands capture <out.jpg> <target> [--fit <edge>x<tokens>]  JPEG sized for the model
//   roamies-hands ui front|app:<name>|window:<id>            the window's controls and text
//   roamies-hands find-text <target> <text> [scroll]         where that text is on screen
//   roamies-hands ocr-file <image.png> [--origin x,y]        test only: OCR an image as if it were a window
//   roamies-hands act '<plan json>'                          click, fill, choose, scroll, press keys (docs/hands.md)
//   roamies-hands image <in> <out.jpg> [--crop x,y,w,h] [--size w,h] [--marks m.json]  crop, resize, draw numbered marks
//   roamies-hands locate-control <target> <id>               where control <id> (from `ui`) is now
//   roamies-hands select <out.png> [--fit <edge>x<tokens>]   the user drags an area (or clicks a window); Esc cancels
//   roamies-hands trusted [--prompt]                         always true: Windows has no permission to grant
mod budget;
mod cli;
mod draw;
mod elevation;
mod fill;
mod fit;
mod focus;
mod forms;
mod geom;
mod hands_off;
mod input;
mod keys;
mod ocr_map;
mod plan;
mod risky;
mod protocol;
mod rank;
mod roles;
mod target;

#[cfg(windows)]
mod act;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod cmd;
#[cfg(windows)]
mod controls;
#[cfg(windows)]
mod com;
#[cfg(windows)]
mod dpi;
#[cfg(windows)]
mod ocr;
#[cfg(windows)]
mod select;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod windows;

use serde_json::Value;
use std::io::Write;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let reply = match cli::parse(&argv) {
        Ok(c) => run(c),
        Err(e) => e,
    };
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{reply}");
    let _ = out.flush();
    // Exits even when a worker is still stuck inside a COM call.
    std::process::exit(0);
}

#[cfg(windows)]
fn run(c: cli::Cmd) -> Value {
    dpi::set_process();
    // act's per-step snapshot already says how far it got, so it's returned as is.
    let partial = !matches!(c.verb, cli::Verb::Act(_));
    budget::run_with(c.budget_ms, partial, move |snap| cmd::dispatch(c, snap))
}

#[cfg(not(windows))]
fn run(_c: cli::Cmd) -> Value {
    protocol::fail("unsupported", "roamies-hands runs only on Windows")
}
