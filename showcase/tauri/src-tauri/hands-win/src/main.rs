// Hands helper for Roamies on Windows: lets the agent see windows, capture one, read its controls and find
// text on screen. One command per run; prints one JSON object as its last stdout line (see docs/hands.md).
//
//   roamies-hands windows                                    visible windows, front to back
//   roamies-hands locate front|screen|screen:<n>|app:<name>|window:<id>  which window that is, without capturing
//   roamies-hands capture <out.jpg> <target> [--fit <edge>x<tokens>]  JPEG sized for the model
//   roamies-hands ui front|app:<name>|window:<id>            the window's controls and text
//   roamies-hands find-text <target> <text> [scroll]         where that text is on screen
mod budget;
mod cli;
mod fit;
mod geom;
mod hands_off;
mod protocol;
mod rank;
mod roles;
mod target;

#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod cmd;
#[cfg(windows)]
mod com;
#[cfg(windows)]
mod dpi;
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
    budget::run(c.budget_ms, move |snap| cmd::dispatch(c, snap))
}

#[cfg(not(windows))]
fn run(_c: cli::Cmd) -> Value {
    protocol::fail("unsupported", "roamies-hands runs only on Windows")
}
