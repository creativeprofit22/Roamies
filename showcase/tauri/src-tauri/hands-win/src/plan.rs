// The act verb's plan: {steps:[{do, ...}], window?: id, app?: name}, with the step kinds and argument names of
// hands/main.swift (892-1151). Everything that can be checked without touching an app is checked here, before
// any input: unknown actions and keys, blocked key combos, click_at without x and y, too many steps.
use crate::keys::{self, Combo, KeyError};
use crate::target::Target;
use serde_json::{json, Value};

pub const MAX_STEPS: usize = 40;
const STEP_MS: u64 = 6000;
const CHOOSE_MS: u64 = 10_000;
const TO_END_MS: u64 = 27_000;
/// Setup: bringing the window to front, then the first walk of its controls, plus a margin for the rest.
pub const FOCUS_MS: u64 = 2500;
pub const WALK_MS: u64 = 2500;
pub const SETUP_MS: u64 = FOCUS_MS + WALK_MS + 1000;
/// Kept free at the end of the whole budget, so the deadline falls between steps, not during input.
pub const STEP_MARGIN_MS: u64 = 1000;
const TOTAL_CAP_MS: u64 = 120_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Focus,
    Click,
    Set,
    PressButton,
    ClickText,
    Type,
    Fill,
    Choose,
    Scroll,
    Key,
    ClickAt,
    Wait,
}

impl Action {
    fn from(s: &str) -> Option<Action> {
        Some(match s {
            "focus" => Action::Focus,
            "click" => Action::Click,
            "set" => Action::Set,
            "press_button" => Action::PressButton,
            "click_text" => Action::ClickText,
            "type" => Action::Type,
            "fill" => Action::Fill,
            "choose" => Action::Choose,
            "scroll" => Action::Scroll,
            "key" => Action::Key,
            "click_at" => Action::ClickAt,
            "wait" => Action::Wait,
            _ => return None,
        })
    }

    /// Steps after which the page may look different, so the reply carries fresh controls (Swift `changing`).
    pub fn changes(self) -> bool {
        !matches!(self, Action::Focus | Action::Type | Action::Wait)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub action: Action,
    /// A control id from `ui` (1-based); for fill and choose a numeric `field` counts too.
    pub id: Option<usize>,
    /// The id as given, for the "no control with id" error.
    pub id_raw: Option<String>,
    pub text: String,
    pub field: String,
    pub near: String,
    pub option: String,
    pub confirmed: bool,
    pub direction: Dir,
    pub amount: u32,
    pub to_end: bool,
    pub key: Option<Combo>,
    pub key_name: String,
    pub x: f64,
    pub y: f64,
    pub global: bool,
    pub seconds: f64,
}

impl Step {
    /// How long this step may take before it's reported as hung.
    pub fn budget_ms(&self) -> u64 {
        match self.action {
            Action::Choose => CHOOSE_MS,
            Action::Scroll if self.to_end => TO_END_MS,
            Action::Wait => (self.seconds * 1000.0) as u64 + 1000,
            _ => STEP_MS,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub target: Target,
    pub steps: Vec<Step>,
}

impl Plan {
    /// The whole verb's budget: every step's plus setup (finding and focusing the window), capped.
    pub fn budget_ms(&self) -> u64 {
        (self.steps.iter().map(Step::budget_ms).sum::<u64>() + SETUP_MS).min(TOTAL_CAP_MS)
    }

    pub fn changes(&self) -> bool {
        self.steps.iter().any(|s| s.action.changes())
    }
}

/// An act failure: which steps already ran is part of every error.
pub fn act_error(code: &str, msg: &str, done: &[String]) -> Value {
    json!({"ok": false, "code": code, "error": msg, "done": done})
}

fn text(s: &Value, k: &str) -> String {
    s[k].as_str().unwrap_or("").to_string()
}

fn int(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 1e15).map(|f| f as i64))
}

fn step(i: usize, s: &Value) -> Result<Step, Value> {
    let n = i + 1;
    let bad = |code: &str, msg: String| act_error(code, &msg, &[]);
    let what = s["do"].as_str().unwrap_or("");
    let action = Action::from(what).ok_or_else(|| bad("usage", format!("Step {n}: unknown action {what}")))?;
    let field = match &s["field"] {
        Value::String(f) => f.clone(),
        Value::Number(f) => f.to_string(),
        _ => String::new(),
    };
    let mut id_raw = match &s["id"] {
        Value::Null => None,
        Value::String(v) => Some(v.clone()),
        v => Some(v.to_string()),
    };
    let mut id = int(&s["id"]).or_else(|| s["id"].as_str().and_then(|v| v.trim().parse().ok()));
    if id_raw.is_none() && matches!(action, Action::Fill | Action::Choose) {
        id = field.trim().parse().ok();
        if id.is_some() {
            id_raw = Some(field.trim().to_string());
        }
    }
    let id = id.filter(|&v| v >= 1).map(|v| v as usize);
    let direction = match s["direction"].as_str().unwrap_or("down").to_lowercase().as_str() {
        "up" => Dir::Up,
        "left" => Dir::Left,
        "right" => Dir::Right,
        _ => Dir::Down,
    };
    let amount = int(&s["amount"]).unwrap_or(5).clamp(1, 30) as u32;
    let key_name = text(s, "key");
    let key = if action == Action::Key {
        match keys::parse(&key_name) {
            Ok(c) => Some(c),
            Err(KeyError::Unknown) => return Err(bad("usage", format!("Step {n}: unknown key {key_name}"))),
            Err(KeyError::Blocked) => {
                return Err(bad("blocked_key", format!("Step {n}: {key_name} would switch windows or leave the app, so I never press it. Ask the user to do it.")))
            }
        }
    } else {
        None
    };
    let (x, y) = (s["x"].as_f64(), s["y"].as_f64());
    if action == Action::ClickAt && (x.is_none() || y.is_none()) {
        return Err(bad("usage", format!("Step {n}: click_at needs x and y")));
    }
    let option = s["option"].as_str().map(str::to_string).unwrap_or_else(|| text(s, "text"));
    Ok(Step {
        action,
        id,
        id_raw,
        text: text(s, "text"),
        field,
        near: text(s, "near").trim().to_string(),
        option,
        confirmed: s["confirmed"].as_bool() == Some(true),
        direction,
        amount,
        to_end: s["to_end"].as_bool() == Some(true) && matches!(direction, Dir::Up | Dir::Down),
        key,
        key_name,
        x: x.unwrap_or(0.0),
        y: y.unwrap_or(0.0),
        global: s["global"].as_bool() == Some(true),
        seconds: s["seconds"].as_f64().unwrap_or(0.5).clamp(0.0, 5.0),
    })
}

pub fn parse(src: &str) -> Result<Plan, Value> {
    let usage = |msg: &str| act_error("usage", msg, &[]);
    let v: Value = serde_json::from_str(src).map_err(|_| usage("bad plan: act needs a JSON plan like {\"steps\":[{\"do\":\"click\",\"id\":3}]}"))?;
    let steps = v["steps"].as_array().filter(|s| !s.is_empty()).ok_or_else(|| usage("bad plan: no steps"))?;
    if steps.len() > MAX_STEPS {
        return Err(usage(&format!("bad plan: {} steps; at most {MAX_STEPS} per call", steps.len())));
    }
    let target = match (int(&v["window"]), v["app"].as_str().map(str::trim).filter(|a| !a.is_empty())) {
        (Some(id), _) => Target::Window(id),
        (None, Some(app)) => Target::App(app.to_string()),
        _ => Target::Front,
    };
    let steps = steps.iter().enumerate().map(|(i, s)| step(i, s)).collect::<Result<Vec<_>, _>>()?;
    Ok(Plan { target, steps })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(s: Value) -> Result<Step, Value> {
        parse(&json!({"steps": [s]}).to_string()).map(|p| p.steps[0].clone())
    }

    #[test]
    fn parses_target_and_steps() {
        let p = parse(r#"{"window": 42, "steps": [{"do": "click", "id": 3, "confirmed": true}, {"do": "fill", "field": "Email", "text": "a@b.c", "near": " Bob "}]}"#).unwrap();
        assert_eq!(p.target, Target::Window(42));
        assert_eq!(p.steps[0].action, Action::Click);
        assert_eq!(p.steps[0].id, Some(3));
        assert!(p.steps[0].confirmed);
        assert_eq!((p.steps[1].field.as_str(), p.steps[1].text.as_str(), p.steps[1].near.as_str()), ("Email", "a@b.c", "Bob"));
        assert_eq!(p.steps[1].id, None);
        assert_eq!(parse(r#"{"app": "Notepad", "steps": [{"do": "wait"}]}"#).unwrap().target, Target::App("Notepad".into()));
        assert_eq!(parse(r#"{"steps": [{"do": "wait"}]}"#).unwrap().target, Target::Front);
    }

    #[test]
    fn a_numeric_field_is_an_id_for_fill_and_choose() {
        assert_eq!(one(json!({"do": "fill", "field": "4", "text": "x"})).unwrap().id, Some(4));
        assert_eq!(one(json!({"do": "choose", "field": 7, "option": "Red"})).unwrap().id, Some(7));
        assert_eq!(one(json!({"do": "click_text", "field": "4", "text": "x"})).unwrap().id, None);
        assert_eq!(one(json!({"do": "click", "id": 0})).unwrap().id, None);
        assert_eq!(one(json!({"do": "click", "id": "x"})).unwrap().id_raw.as_deref(), Some("x"));
    }

    #[test]
    fn argument_defaults_match_the_mac_helper() {
        let s = one(json!({"do": "scroll"})).unwrap();
        assert_eq!((s.direction, s.amount, s.to_end), (Dir::Down, 5, false));
        let s = one(json!({"do": "scroll", "direction": "UP", "amount": 99, "to_end": true})).unwrap();
        assert_eq!((s.direction, s.amount, s.to_end), (Dir::Up, 30, true));
        assert!(!one(json!({"do": "scroll", "direction": "left", "to_end": true})).unwrap().to_end);
        assert_eq!(one(json!({"do": "choose", "text": "Blue"})).unwrap().option, "Blue");
        assert_eq!(one(json!({"do": "choose", "option": "Red", "text": "Blue"})).unwrap().option, "Red");
        assert_eq!(one(json!({"do": "wait"})).unwrap().seconds, 0.5);
        assert_eq!(one(json!({"do": "wait", "seconds": 60})).unwrap().seconds, 5.0);
        let c = one(json!({"do": "click_at", "x": 10, "y": 20.5, "global": true})).unwrap();
        assert_eq!((c.x, c.y, c.global), (10.0, 20.5, true));
    }

    #[test]
    fn static_checks_fail_before_anything_runs() {
        for (plan, code) in [
            (json!({}), "usage"),
            (json!({"steps": []}), "usage"),
            (json!({"steps": [{"do": "dance"}]}), "usage"),
            (json!({"steps": [{"do": "key", "key": "hyper"}]}), "usage"),
            (json!({"steps": [{"do": "click_at", "x": 1}]}), "usage"),
            (json!({"steps": [{"do": "wait"}, {"do": "key", "key": "win+l"}]}), "blocked_key"),
            (json!({"steps": [{"do": "key", "key": "alt+shift+tab"}]}), "blocked_key"),
        ] {
            let e = parse(&plan.to_string()).unwrap_err();
            assert_eq!(e["ok"], false);
            assert_eq!(e["code"], code, "{plan}");
            assert_eq!(e["done"], json!([]), "{plan}");
        }
        assert_eq!(parse("not json").unwrap_err()["code"], "usage");
        let many: Vec<Value> = (0..41).map(|_| json!({"do": "wait"})).collect();
        assert_eq!(parse(&json!({"steps": many}).to_string()).unwrap_err()["code"], "usage");
        assert!(parse(&json!({"steps": [{"do": "key", "key": "ctrl+shift+tab"}]}).to_string()).is_ok());
    }

    #[test]
    fn budgets_per_step_and_in_total() {
        let p = parse(r#"{"steps": [{"do": "click", "id": 1}, {"do": "choose", "id": 2, "option": "a"}, {"do": "scroll", "to_end": true}, {"do": "wait", "seconds": 2}]}"#).unwrap();
        assert_eq!(p.steps.iter().map(Step::budget_ms).collect::<Vec<_>>(), vec![6000, 10_000, 27_000, 3000]);
        assert_eq!(p.budget_ms(), 6000 + 10_000 + 27_000 + 3000 + SETUP_MS);
        let many: Vec<Value> = (0..40).map(|_| json!({"do": "scroll", "to_end": true})).collect();
        assert_eq!(parse(&json!({"steps": many}).to_string()).unwrap().budget_ms(), 120_000);
        assert!(p.changes());
        assert!(!parse(r#"{"steps": [{"do": "type", "text": "x"}, {"do": "wait"}]}"#).unwrap().changes());
    }

    #[test]
    fn setup_reservation_covers_focus_and_the_first_walk() {
        const _: () = assert!(SETUP_MS >= FOCUS_MS + WALK_MS + STEP_MARGIN_MS);
        let p = parse(r#"{"steps": [{"do": "click", "id": 1}]}"#).unwrap();
        assert!(p.budget_ms() >= FOCUS_MS + WALK_MS + p.steps[0].budget_ms());
    }
}
