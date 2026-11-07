// Command-line parsing: the same verbs and arguments as hands/main.swift, plus two flags
// (--budget-ms N for tests, --fake-exe NAME to test the hands-off refusal), and --fit <edge>x<tokens> to
// size capture's image for the model (tokens 0 = no token limit).
use crate::geom::Rect;
use crate::plan::{self, Plan};
use crate::protocol::fail;
use crate::target::{parse as parse_target, Target};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Verb {
    Windows,
    Locate(Target),
    Capture { out: String, target: Target },
    Ui(Target),
    FindText { target: Target, text: String, scroll: bool },
    /// Test-only: OCR a PNG as if it were a window whose top-left corner is at `origin`.
    OcrFile { file: String, origin: (i32, i32) },
    /// Crop (source pixels), resize to exactly `size`, draw numbered marks (output pixels), write JPEG.
    Image { input: String, out: String, crop: Option<Rect>, size: Option<(u32, u32)>, marks: Option<String> },
    /// Click, fill, choose, scroll and press keys in a window, step by step (checked before anything runs).
    Act(Plan),
    /// Always trusted: Windows has no Accessibility permission to grant.
    Trusted,
    /// Where one control from `ui` (numbered from 1, the same ids) is on screen.
    LocateControl { target: Target, id: usize },
    /// The user drags an area (or clicks a window) on screen; it is saved as PNG to `out`.
    Select { out: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Cmd {
    pub verb: Verb,
    pub budget_ms: u64,
    pub fake_exe: Option<String>,
    pub fit: Option<(u32, u32)>,
}

/// Default time budget per verb, in milliseconds.
pub fn default_budget(v: &Verb) -> u64 {
    match v {
        Verb::Windows | Verb::Locate(_) | Verb::Trusted => 2000,
        Verb::LocateControl { .. } => 4000,
        // The sidecar kills the helper after 120 s; the user gets most of that to pick an area.
        Verb::Select { .. } => 110_000,
        Verb::Capture { .. } => 5000,
        Verb::Ui(_) => 4000,
        Verb::FindText { .. } => 6000,
        Verb::OcrFile { .. } => 15000,
        Verb::Image { .. } => 5000,
        Verb::Act(plan) => plan.budget_ms(),
    }
}

pub const UI_NODES: usize = 3000;
pub const FIND_NODES_PER_WINDOW: usize = 4000;
pub const FIND_WINDOWS: usize = 12;

fn numbers(s: &str, n: usize) -> Option<Vec<i64>> {
    let v: Vec<i64> = s.split(',').map(|p| p.trim().parse().ok()).collect::<Option<_>>()?;
    (v.len() == n).then_some(v)
}

fn image(args: &[&str]) -> Result<Verb, Value> {
    let u = "usage: image <in> <out.jpg> [--crop x,y,w,h] [--size w,h] [--marks <marks.json>]";
    let bad = || fail("usage", u);
    let [input, out, rest @ ..] = args else { return Err(bad()) };
    let (mut crop, mut size, mut marks) = (None, None, None);
    let mut it = rest.iter();
    while let Some(flag) = it.next() {
        let v = it.next().ok_or_else(bad)?;
        match *flag {
            "--crop" => match numbers(v, 4).as_deref() {
                Some(&[x, y, w, h]) if w > 0 && h > 0 && x >= 0 && y >= 0 => crop = Some(Rect::new(x as i32, y as i32, w as i32, h as i32)),
                _ => return Err(bad()),
            },
            "--size" => match numbers(v, 2).as_deref() {
                Some(&[w, h]) if (1..=10000).contains(&w) && (1..=10000).contains(&h) => size = Some((w as u32, h as u32)),
                _ => return Err(bad()),
            },
            "--marks" => marks = Some(v.to_string()),
            _ => return Err(bad()),
        }
    }
    Ok(Verb::Image { input: input.to_string(), out: out.to_string(), crop, size, marks })
}

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
        "ocr-file" => {
            let u = "usage: ocr-file <image.png> [--origin x,y]";
            let file = args.get(1).ok_or_else(|| fail("usage", u))?.to_string();
            let origin = match &args[2..] {
                [] => (0, 0),
                ["--origin", xy] => {
                    let (x, y) = xy.split_once(',').ok_or_else(|| fail("usage", u))?;
                    (x.trim().parse().map_err(|_| fail("usage", u))?, y.trim().parse().map_err(|_| fail("usage", u))?)
                }
                _ => return Err(fail("usage", u)),
            };
            Verb::OcrFile { file, origin }
        }
        "image" => image(&args[1..])?,
        "act" => {
            let u = "usage: act '<plan json>', like {\"app\":\"Notepad\",\"steps\":[{\"do\":\"click\",\"id\":3}]}";
            let [_, json] = args[..] else { return Err(plan::act_error("usage", u, &[])) };
            Verb::Act(plan::parse(json)?)
        }
        "trusted" => match &args[1..] {
            [] | ["--prompt"] => Verb::Trusted,
            _ => return Err(fail("usage", "usage: trusted [--prompt]")),
        },
        "locate-control" => {
            let u = "usage: locate-control <target> <id>";
            let [_, t, id] = args[..] else { return Err(fail("usage", u)) };
            let t = target(t, u)?;
            let id = id.parse::<usize>().ok().filter(|&n| n >= 1).ok_or_else(|| fail("usage", u))?;
            if matches!(t, Target::Screen | Target::Monitor(_)) {
                return Err(fail("usage", u));
            }
            Verb::LocateControl { target: t, id }
        }
        "select" => {
            let u = "usage: select <out.png> [--fit <edge>x<tokens>]";
            let [_, out] = args[..] else { return Err(fail("usage", u)) };
            Verb::Select { out: out.to_string() }
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
        assert_eq!(p(&["ocr-file", "a.png"]).unwrap().verb, Verb::OcrFile { file: "a.png".into(), origin: (0, 0) });
        assert_eq!(p(&["ocr-file", "a.png", "--origin", "-1920,40"]).unwrap().verb, Verb::OcrFile { file: "a.png".into(), origin: (-1920, 40) });
        assert_eq!(p(&["image", "a.png", "b.jpg"]).unwrap().verb, Verb::Image { input: "a.png".into(), out: "b.jpg".into(), crop: None, size: None, marks: None });
        let c = p(&["image", "a.png", "b.jpg", "--crop", "10,20,300,200", "--size", "600,400", "--marks", "m.json"]).unwrap();
        assert_eq!(c.verb, Verb::Image { input: "a.png".into(), out: "b.jpg".into(), crop: Some(Rect::new(10, 20, 300, 200)), size: Some((600, 400)), marks: Some("m.json".into()) });
        assert_eq!(c.budget_ms, 5000);
        let c = p(&["act", r#"{"app":"Notepad","steps":[{"do":"wait","seconds":1}]}"#]).unwrap();
        let Verb::Act(plan) = &c.verb else { panic!("act") };
        assert_eq!(plan.target, Target::App("Notepad".into()));
        assert_eq!(c.budget_ms, plan.budget_ms());
        assert_eq!(p(&["act", r#"{"steps":[{"do":"wait"}]}"#, "--budget-ms", "900"]).unwrap().budget_ms, 900);
    }

    #[test]
    fn act_is_no_longer_mac_only() {
        let e = p(&["act", r#"{"steps":[{"do":"click","id":1}]}"#]).map(|c| c.verb);
        assert!(matches!(e, Ok(Verb::Act(_))));
        assert_eq!(p(&["act"]).unwrap_err()["done"], serde_json::json!([]));
        assert!(!p(&["act", "{}"]).unwrap_err()["error"].as_str().unwrap().contains("macOS"));
        let k = p(&["act", r#"{"steps":[{"do":"key","key":"win+l"}]}"#]).unwrap_err();
        assert_eq!((k["code"].as_str(), &k["done"]), (Some("blocked_key"), &serde_json::json!([])));
    }

    #[test]
    fn mac_only_verbs_parse_on_windows_too() {
        assert_eq!(p(&["trusted"]).unwrap().verb, Verb::Trusted);
        assert_eq!(p(&["trusted", "--prompt"]).unwrap().budget_ms, 2000);
        let c = p(&["locate-control", "app:Notepad", "3"]).unwrap();
        assert_eq!(c.verb, Verb::LocateControl { target: Target::App("Notepad".into()), id: 3 });
        assert_eq!(c.budget_ms, 4000);
        let c = p(&["select", "a.png", "--fit", "1568x1568"]).unwrap();
        assert_eq!((c.verb, c.fit, c.budget_ms), (Verb::Select { out: "a.png".into() }, Some((1568, 1568)), 110_000));
        for verb in ["select", "locate-control"] {
            assert!(!p(&[verb]).unwrap_err()["error"].as_str().unwrap().contains("macOS"), "{verb}");
        }
    }

    #[test]
    fn usage_errors_carry_a_code() {
        for bad in [&[][..], &["nope"], &["capture", "o.jpg"], &["ui", "screen"], &["find-text", "front"], &["find-text", "front", " "], &["locate", "Notepad"], &["act", "{}"], &["act"], &["act", "{}", "extra"], &["windows", "--budget-ms", "x"], &["ui", "screen:1"], &["capture", "o.jpg", "screen:0"], &["capture", "o.jpg", "front", "--fit", "x"], &["capture", "o.jpg", "front", "--fit", "0x0"], &["capture", "o.jpg", "front", "--fit"], &["ocr-file"], &["ocr-file", "a.png", "--origin"], &["ocr-file", "a.png", "--origin", "1x2"], &["ocr-file", "a.png", "x"], &["image", "a.png"], &["image", "a.png", "b.jpg", "--crop", "1,2,3"], &["image", "a.png", "b.jpg", "--crop", "-1,0,3,3"], &["image", "a.png", "b.jpg", "--crop", "0,0,0,3"], &["image", "a.png", "b.jpg", "--size", "0,3"], &["image", "a.png", "b.jpg", "--size"], &["image", "a.png", "b.jpg", "--what", "x"], &["trusted", "x"], &["locate-control", "front"], &["locate-control", "front", "0"], &["locate-control", "front", "x"], &["locate-control", "screen", "1"], &["locate-control", "front", "1", "2"], &["select"], &["select", "a.png", "b"]] {
            let e = p(bad).unwrap_err();
            assert_eq!(e["ok"], false, "{bad:?}");
            assert_eq!(e["code"], "usage", "{bad:?}");
        }
    }
}
