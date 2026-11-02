// The JSON the helper prints (one object, last line of stdout). Shapes match hands/main.swift; the key sets
// are pinned by tests/fixtures/shapes.json and docs/hands.md. Every rect is [x, y, w, h] in physical screen
// pixels (virtual-desktop coordinates), so success replies carry unit:"px".
use crate::budget::Stop;
use crate::geom::Rect;
use serde_json::{json, Map, Value};

pub const UNIT: &str = "px";

pub fn fail(code: &str, msg: &str) -> Value {
    json!({"ok": false, "error": msg, "code": code})
}

#[derive(Clone, Debug, Default)]
pub struct WinInfo {
    pub id: i64,
    pub pid: u32,
    pub app: String,
    pub exe: String,
    pub class: String,
    pub title: String,
    pub bounds: Rect,
    pub scale: f64,
    pub minimized: bool,
}

#[derive(Clone, Debug)]
pub struct Monitor {
    pub bounds: Rect,
    pub scale: f64,
    pub primary: bool,
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

pub fn win_info(w: &WinInfo) -> Value {
    json!({"id": w.id, "app": w.app, "title": w.title, "bounds": w.bounds.json(), "scale": round2(w.scale)})
}

pub fn monitors(ms: &[Monitor]) -> Value {
    Value::Array(
        ms.iter()
            .map(|m| json!({"bounds": m.bounds.json(), "origin": [m.bounds.x, m.bounds.y], "scale": round2(m.scale), "primary": m.primary}))
            .collect(),
    )
}

fn ok(fields: Value) -> Value {
    let mut o = Map::new();
    o.insert("ok".into(), json!(true));
    o.insert("unit".into(), json!(UNIT));
    if let Value::Object(f) = fields {
        o.extend(f);
    }
    Value::Object(o)
}

pub fn windows_reply(wins: &[WinInfo], front_pid: Option<u32>, mons: &[Monitor]) -> Value {
    let list: Vec<Value> = wins
        .iter()
        .take(30)
        .map(|w| {
            let mut i = win_info(w);
            if Some(w.pid) == front_pid {
                i["frontApp"] = json!(true);
            }
            i
        })
        .collect();
    ok(json!({"windows": list, "monitors": monitors(mons)}))
}

pub fn locate_reply(w: &WinInfo, mons: &[Monitor]) -> Value {
    ok(json!({"window": win_info(w), "monitors": monitors(mons)}))
}

pub fn locate_screen_reply(mons: &[Monitor]) -> Value {
    ok(json!({"what": "screen", "monitors": monitors(mons)}))
}

/// `sent` is the image's own size in pixels (the bounds scaled by --fit).
pub fn capture_window_reply(file: &str, w: &WinInfo, sent: (u32, u32), mons: &[Monitor]) -> Value {
    ok(json!({"file": file, "window": win_info(w), "sent": [sent.0, sent.1], "monitors": monitors(mons)}))
}

pub fn capture_screen_reply(file: &str, bounds: Rect, sent: (u32, u32), mons: &[Monitor]) -> Value {
    ok(json!({"file": file, "what": "screen", "bounds": bounds.json(), "sent": [sent.0, sent.1], "monitors": monitors(mons)}))
}

pub const NO_CONTROLS: &str = "This app shares no controls. Use a screenshot plus click at coordinates instead.";

pub fn ui_reply(w: &WinInfo, controls: Vec<Value>, texts: Vec<String>, elsewhere: Vec<String>) -> Value {
    let note = if controls.is_empty() { NO_CONTROLS } else { "" };
    ok(json!({"window": win_info(w), "controls": controls, "texts": texts, "elsewhere": elsewhere, "note": note}))
}

pub struct Control {
    pub role: String,
    pub label: String,
    pub bounds: Rect,
    pub value: Option<String>,
    pub focused: bool,
    pub offscreen: bool,
}

pub fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

pub fn control(id: usize, c: &Control) -> Value {
    let mut v = json!({"id": id, "role": c.role, "label": clip(&c.label, 80), "bounds": c.bounds.json()});
    if let Some(val) = c.value.as_deref().filter(|s| !s.is_empty()) {
        v["value"] = json!(clip(val, 80));
    }
    if c.focused {
        v["focused"] = json!(true);
    }
    if c.offscreen {
        v["offscreen"] = json!(true);
    }
    v
}

/// One find-text hit before it's tied to a window (window and rank are added per window).
pub fn hit(text: &str, score: u8, role: &str, bounds: Rect) -> Value {
    json!({"text": clip(text, 80), "match": crate::rank::MATCH_NAMES[score as usize], "role": role, "bounds": bounds.json()})
}

pub fn find_reply(matches: Vec<Value>) -> Value {
    ok(json!({"matches": matches}))
}

pub fn mark_partial(v: &mut Value, stop: Option<Stop>) {
    if let Some(s) = stop {
        v["partial"] = json!(true);
        v["partialReason"] = json!(s.reason());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const SHAPES: &str = include_str!("../tests/fixtures/shapes.json");

    fn keys(v: &Value) -> BTreeSet<String> {
        v.as_object().expect("object").keys().cloned().collect()
    }

    fn want(shapes: &Value, name: &str) -> BTreeSet<String> {
        shapes[name].as_array().unwrap_or_else(|| panic!("shapes.json: {name}")).iter().map(|k| k.as_str().unwrap().to_string()).collect()
    }

    fn sample() -> (WinInfo, Vec<Monitor>) {
        let w = WinInfo { id: 42, pid: 7, app: "Notepad".into(), title: "a.txt".into(), bounds: Rect::new(10, 20, 800, 600), scale: 1.5, ..Default::default() };
        (w, vec![Monitor { bounds: Rect::new(0, 0, 2560, 1440), scale: 1.5, primary: true }])
    }

    #[test]
    fn builders_match_the_pinned_shapes() {
        let s: Value = serde_json::from_str(SHAPES).unwrap();
        let (w, m) = sample();
        assert_eq!(keys(&win_info(&w)), want(&s, "windowInfo"));
        let wr = windows_reply(std::slice::from_ref(&w), Some(7), &m);
        assert_eq!(keys(&wr), want(&s, "windows"));
        let mut front = want(&s, "windowInfo");
        front.insert("frontApp".into());
        assert_eq!(keys(&wr["windows"][0]), front);
        assert_eq!(keys(&wr["monitors"][0]), want(&s, "monitor"));
        assert_eq!(keys(&locate_reply(&w, &m)), want(&s, "locate"));
        assert_eq!(keys(&locate_screen_reply(&m)), want(&s, "locateScreen"));
        assert_eq!(keys(&capture_window_reply("o.jpg", &w, (400, 300), &m)), want(&s, "captureWindow"));
        assert_eq!(keys(&capture_screen_reply("o.jpg", Rect::new(0, 0, 1, 1), (1, 1), &m)), want(&s, "captureScreen"));
        assert_eq!(keys(&ui_reply(&w, vec![], vec![], vec![])), want(&s, "ui"));
        let bare = Control { role: "button".into(), label: "OK".into(), bounds: Rect::new(1, 2, 3, 4), value: None, focused: false, offscreen: false };
        assert_eq!(keys(&control(1, &bare)), want(&s, "control"));
        let full = Control { value: Some("x".into()), focused: true, offscreen: true, ..bare };
        let mut all = want(&s, "control");
        all.extend(want(&s, "controlOptional"));
        assert_eq!(keys(&control(2, &full)), all);
        let mut h = hit("Example Domain", 0, "heading", Rect::new(0, 0, 10, 10));
        h["window"] = win_info(&w);
        h["rank"] = json!(0);
        assert_eq!(keys(&h), want(&s, "match"));
        assert_eq!(keys(&find_reply(vec![])), want(&s, "findText"));
        assert_eq!(keys(&fail("usage", "x")), want(&s, "error"));
        let mut p = find_reply(vec![]);
        mark_partial(&mut p, Some(Stop::Nodes));
        let mut partial = want(&s, "findText");
        partial.extend(want(&s, "partial"));
        assert_eq!(keys(&p), partial);
    }

    #[test]
    fn ui_note_only_when_no_controls() {
        let (w, _) = sample();
        assert_eq!(ui_reply(&w, vec![], vec![], vec![])["note"], NO_CONTROLS);
        assert_eq!(ui_reply(&w, vec![json!({})], vec![], vec![])["note"], "");
    }
}
