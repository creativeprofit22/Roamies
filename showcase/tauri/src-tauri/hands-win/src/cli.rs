// Command-line parsing: the same verbs and arguments as hands/main.swift, plus two flags
// (--budget-ms N for tests, --fake-exe NAME to test the hands-off refusal), and --fit <edge>x<tokens> to
// size capture's image for the model (tokens 0 = no token limit).
use crate::protocol::fail;
use crate::target::{parse as parse_target, Target};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verb {
    Windows,
    Locate(Target),
    Capture { out: String, target: Target },
    Ui(Target),
    FindText { target: Target, text: String, scroll: bool },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cmd {
    pub verb: Verb,
    pub budget_ms: u64,
    pub fake_exe: Option<String>,
    pub fit: Option<(u32, u32)>,
}

/// Default time budget per verb, in milliseconds.
pub fn default_budget(v: &Verb) -> u64 {
    match v {
        Verb::Windows | Verb::Locate(_) => 2000,
        Verb::Capture { .. } => 5000,
        Verb::Ui(_) => 4000,
        Verb::FindText { .. } => 6000,
    }
}

pub const UI_NODES: usize = 3000;
pub const FIND_NODES_PER_WINDOW: usize = 4000;
pub const FIND_WINDOWS: usize = 12;

fn target(s: &str, usage: &str) -> Result<Target, Value> {
    parse_target(s).ok_or_else(|| fail("usage", &format!("bad target {s:?}; {usage}")))
}

pub fn parse(argv: &[String]) -> Result<Cmd, Value> {
    let mut args: Vec<&str> = Vec::new();
    let mut budget = None;
    let mut fake_exe = None;
    let mut fit = None;
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--budget-ms" => {
                let n = it.next().and_then(|n| n.parse::<u64>().ok()).ok_or_else(|| fail("usage", "--budget-ms needs a number"))?;
                budget = Some(n);
            }
            "--fit" => {
                let bad = || fail("usage", "--fit needs <max edge>x<max tokens>, like 1568x1568");
                let v = it.next().ok_or_else(bad)?;
                let (e, t) = v.split_once('x').ok_or_else(bad)?;
                let (e, t) = (e.parse::<u32>().map_err(|_| bad())?, t.parse::<u32>().map_err(|_| bad())?);
                if e == 0 {
                    return Err(bad());
                }
                fit = Some((e, t));
            }
            "--fake-exe" => fake_exe = Some(it.next().ok_or_else(|| fail("usage", "--fake-exe needs an exe name"))?.clone()),
            _ => args.push(a),
        }
    }
    let Some(&verb) = args.first() else { return Err(fail("usage", "no command")) };
    let verb = match verb {
        "windows" => Verb::Windows,
        "locate" => {
            let u = "usage: locate front|screen|screen:<n>|app:<name>|window:<id>";
            Verb::Locate(target(args.get(1).ok_or_else(|| fail("usage", u))?, u)?)
        }
        "capture" => {
            let u = "usage: capture <out.jpg> front|screen|screen:<n>|app:<name>|window:<id> [--fit <edge>x<tokens>]";
            if args.len() < 3 {
                return Err(fail("usage", u));
            }
            Verb::Capture { out: args[1].to_string(), target: target(args[2], u)? }
        }
        "ui" => {
            let u = "usage: ui front|app:<name>|window:<id>";
            let t = target(args.get(1).ok_or_else(|| fail("usage", u))?, u)?;
            if matches!(t, Target::Screen | Target::Monitor(_)) {
                return Err(fail("usage", u));
            }
            Verb::Ui(t)
        }
        "find-text" => {
            let u = "usage: find-text front|screen|screen:<n>|app:<name>|window:<id> <text> [scroll]";
            if args.len() < 3 || args[2].trim().is_empty() {
                return Err(fail("usage", u));
            }
            Verb::FindText { target: target(args[1], u)?, text: args[2].to_string(), scroll: args.get(3) == Some(&"scroll") }
        }
        "select" | "act" | "trusted" | "locate-control" => {
            return Err(fail("usage", &format!("{verb} is only available on macOS")));
        }
        other => return Err(fail("usage", &format!("unknown command {other:?}"))),
    };
    let budget_ms = budget.unwrap_or_else(|| default_budget(&verb));
    Ok(Cmd { verb, budget_ms, fake_exe, fit })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &[&str]) -> Result<Cmd, Value> {
        parse(&s.iter().map(|x| x.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_every_verb() {
        assert_eq!(p(&["windows"]).unwrap().verb, Verb::Windows);
        assert_eq!(p(&["locate", "screen"]).unwrap().verb, Verb::Locate(Target::Screen));
        assert_eq!(p(&["capture", "o.jpg", "app:Notepad"]).unwrap().verb, Verb::Capture { out: "o.jpg".into(), target: Target::App("Notepad".into()) });
        assert_eq!(p(&["ui", "front"]).unwrap().verb, Verb::Ui(Target::Front));
        let c = p(&["find-text", "screen", "Example Domain", "scroll", "--budget-ms", "5"]).unwrap();
        assert_eq!(c.verb, Verb::FindText { target: Target::Screen, text: "Example Domain".into(), scroll: true });
        assert_eq!(c.budget_ms, 5);
        assert_eq!(p(&["ui", "front", "--fake-exe", "keepass.exe"]).unwrap().fake_exe.as_deref(), Some("keepass.exe"));
        assert_eq!(p(&["windows"]).unwrap().budget_ms, 2000);
        let c = p(&["capture", "o.jpg", "screen:2", "--fit", "1568x0"]).unwrap();
        assert_eq!(c.verb, Verb::Capture { out: "o.jpg".into(), target: Target::Monitor(2) });
        assert_eq!(c.fit, Some((1568, 0)));
        assert_eq!(p(&["capture", "o.jpg", "front"]).unwrap().fit, None);
    }

    #[test]
    fn usage_errors_carry_a_code() {
        for bad in [&[][..], &["nope"], &["capture", "o.jpg"], &["ui", "screen"], &["find-text", "front"], &["find-text", "front", " "], &["locate", "Notepad"], &["act", "{}"], &["windows", "--budget-ms", "x"], &["ui", "screen:1"], &["capture", "o.jpg", "screen:0"], &["capture", "o.jpg", "front", "--fit", "x"], &["capture", "o.jpg", "front", "--fit", "0x0"], &["capture", "o.jpg", "front", "--fit"]] {
            let e = p(bad).unwrap_err();
            assert_eq!(e["ok"], false, "{bad:?}");
            assert_eq!(e["code"], "usage", "{bad:?}");
        }
    }
}
