//! Host telemetry (schema v1, see docs/telemetry.md): start a step, end it, record an event.
//! Events go to the sidecar as `{type:'telemetry', events}`; the host never writes telemetry files.

use serde_json::{json, Map, Value};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const SCHEMA: u32 = 1;
pub type Attrs = Map<String, Value>;
type Sink = Box<dyn Fn(Value) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Error,
    Cancelled,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Error => "error",
            Outcome::Cancelled => "cancelled",
        }
    }
}

/// An open step; pass it to `end`.
#[derive(Debug, Clone)]
pub struct Step {
    pub id: String,
    pub name: &'static str,
    pub request_id: Option<String>,
    pub parent: Option<String>,
    started: Instant,
}

pub struct Telemetry {
    on: AtomicBool,
    sink: Mutex<Option<Sink>>,
}

impl Telemetry {
    pub const fn new() -> Self {
        Telemetry { on: AtomicBool::new(true), sink: Mutex::new(None) }
    }

    pub fn set_sink(&self, sink: impl Fn(Value) + Send + Sync + 'static) {
        *self.sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(sink));
    }

    pub fn set_enabled(&self, on: bool) {
        self.on.store(on, Ordering::Relaxed);
    }

    pub fn enabled(&self) -> bool {
        self.on.load(Ordering::Relaxed)
    }

    pub fn start(&self, name: &'static str, request_id: Option<&str>, parent: Option<&Step>, attrs: Attrs) -> Step {
        let step = new_step(name, request_id, parent);
        self.emit(|| event(now_ms(), "start", &step, None, None, None, attrs));
        step
    }

    /// A step that began at `at`, measured before it could be reported (e.g. before the sink existed).
    pub fn start_at(&self, name: &'static str, request_id: Option<&str>, parent: Option<&Step>, at: Instant, attrs: Attrs) -> Step {
        let mut step = new_step(name, request_id, parent);
        step.started = at;
        let ago = at.elapsed().as_millis() as u64;
        self.emit(|| event(now_ms().saturating_sub(ago), "start", &step, None, None, None, attrs));
        step
    }

    pub fn end(&self, step: Step, outcome: Outcome, error_code: Option<&str>, attrs: Attrs) {
        let ms = (step.started.elapsed().as_secs_f64() * 1_000_000.0).round() / 1000.0;
        self.emit(|| event(now_ms(), "end", &step, Some(ms), Some(outcome), error_code, attrs));
    }

    pub fn record(&self, name: &'static str, request_id: Option<&str>, parent: Option<&Step>, attrs: Attrs) {
        let step = new_step(name, request_id, parent);
        self.emit(|| event(now_ms(), "event", &step, None, None, None, attrs));
    }

    /// A failure with no step around it: an `event` with outcome error and a stable code.
    pub fn record_error(&self, name: &'static str, request_id: Option<&str>, code: &str, attrs: Attrs) {
        let step = new_step(name, request_id, None);
        self.emit(|| event(now_ms(), "event", &step, None, Some(Outcome::Error), Some(code), attrs));
    }

    fn emit(&self, make: impl FnOnce() -> Value) {
        if !self.enabled() {
            return;
        }
        if let Some(sink) = self.sink.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            sink(make());
        }
    }
}

impl Default for Telemetry {
    fn default() -> Self {
        Self::new()
    }
}

/// The app's one host telemetry instance.
pub static TEL: Telemetry = Telemetry::new();

pub fn start(name: &'static str, request_id: Option<&str>, parent: Option<&Step>, attrs: Attrs) -> Step {
    TEL.start(name, request_id, parent, attrs)
}

pub fn end(step: Step, outcome: Outcome, error_code: Option<&str>, attrs: Attrs) {
    TEL.end(step, outcome, error_code, attrs)
}

pub fn start_at(name: &'static str, request_id: Option<&str>, parent: Option<&Step>, at: Instant, attrs: Attrs) -> Step {
    TEL.start_at(name, request_id, parent, at, attrs)
}

pub fn record_error(name: &'static str, request_id: Option<&str>, code: &str, attrs: Attrs) {
    TEL.record_error(name, request_id, code, attrs)
}

#[allow(dead_code)] // part of the shared start/end/record API; host events use start/end and record_error
pub fn record(name: &'static str, request_id: Option<&str>, parent: Option<&Step>, attrs: Attrs) {
    TEL.record(name, request_id, parent, attrs)
}

/// Builds an attrs map from `json!({...})`; anything but an object gives an empty map.
pub fn attrs(v: Value) -> Attrs {
    match v {
        Value::Object(m) => m,
        _ => Attrs::new(),
    }
}

/// A typed answer from the webview: give a non-empty one a request id (unless it has a valid one) and record it.
/// Returns the id it carries.
pub fn stamp_answer(tel: &Telemetry, msg: &mut Value) -> Option<String> {
    if msg.get("type").and_then(Value::as_str) != Some("answer") {
        return None;
    }
    if msg.get("text").and_then(Value::as_str).is_none_or(|t| t.trim().is_empty()) {
        return None;
    }
    let rid = match msg.get("request_id").and_then(Value::as_str) {
        Some(r) if is_request_id(r) => r.to_string(),
        _ => new_request_id(),
    };
    msg["request_id"] = json!(rid);
    msg["sent_ms"] = json!(now_ms());
    tel.record("host.request_typed", Some(&rid), None, Attrs::new());
    Some(rid)
}

fn new_step(name: &'static str, request_id: Option<&str>, parent: Option<&Step>) -> Step {
    Step {
        id: new_step_id(),
        name,
        request_id: request_id.map(str::to_string),
        parent: parent.map(|p| p.id.clone()),
        started: Instant::now(),
    }
}

fn event(
    ts: u64,
    kind: &str,
    step: &Step,
    duration_ms: Option<f64>,
    outcome: Option<Outcome>,
    error_code: Option<&str>,
    attrs: Attrs,
) -> Value {
    json!({
        "schema": SCHEMA,
        "ts": ts,
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": os(),
        "request_id": step.request_id,
        "step_id": step.id,
        "parent_step_id": step.parent,
        "kind": kind,
        "step": step.name,
        "component": "host",
        "duration_ms": duration_ms,
        "outcome": outcome.map(Outcome::as_str),
        "error_code": error_code,
        "attrs": Value::Object(attrs),
    })
}

fn os() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// Epoch ms; also `sent_ms` on messages to the sidecar, for `agent.handoff`.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_u64() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

pub fn new_step_id() -> String {
    format!("{:016x}", random_u64())
}

pub fn new_request_id() -> String {
    format!("{:016x}{:016x}", random_u64(), random_u64())
}

/// 32 lowercase hex chars, the request id format.
pub fn is_request_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn capture() -> (Telemetry, Arc<Mutex<Vec<Value>>>) {
        let tel = Telemetry::new();
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        tel.set_sink(move |e| g.lock().unwrap().push(e));
        (tel, got)
    }

    #[test]
    fn start_end_round_trip_matches_the_schema() {
        let (tel, got) = capture();
        let rid = new_request_id();
        let s = tel.start("host.voice_session", Some(&rid), None, attrs(json!({ "mode": "hold" })));
        tel.record("host.request_typed", Some(&rid), Some(&s), Attrs::new());
        tel.end(s, Outcome::Cancelled, None, Attrs::new());
        let ev = got.lock().unwrap().clone();
        assert_eq!(ev.len(), 3);
        let keys = ["schema", "ts", "app_version", "os", "request_id", "step_id", "parent_step_id", "kind", "step", "component", "duration_ms", "outcome", "error_code", "attrs"];
        for e in &ev {
            let round: Value = serde_json::from_str(&e.to_string()).unwrap();
            assert_eq!(&round, e);
            for k in keys {
                assert!(e.get(k).is_some(), "missing {k}");
            }
            assert_eq!(e["component"], "host");
            assert_eq!(e["request_id"], rid.as_str());
        }
        assert_eq!(ev[0]["kind"], "start");
        assert_eq!(ev[0]["attrs"]["mode"], "hold");
        assert_eq!(ev[1]["parent_step_id"], ev[0]["step_id"]);
        assert_eq!(ev[2]["step_id"], ev[0]["step_id"]);
        assert_eq!(ev[2]["outcome"], "cancelled");
        assert!(ev[2]["duration_ms"].is_number());
    }

    #[test]
    fn off_sends_nothing() {
        let (tel, got) = capture();
        tel.set_enabled(false);
        let s = tel.start("host.voice_session", None, None, Attrs::new());
        tel.end(s, Outcome::Ok, None, Attrs::new());
        assert!(got.lock().unwrap().is_empty());
    }

    #[test]
    fn typed_answers_get_a_request_id() {
        let (tel, got) = capture();
        let mut m = json!({ "type": "answer", "id": 3, "text": "hi" });
        let rid = stamp_answer(&tel, &mut m).unwrap();
        assert!(is_request_id(&rid));
        assert_eq!(m["request_id"], rid.as_str());
        assert!(m["sent_ms"].as_u64().is_some_and(|t| t > 0));
        assert_eq!(got.lock().unwrap()[0]["step"], "host.request_typed");
        assert_eq!(got.lock().unwrap()[0]["request_id"], rid.as_str());

        let keep = new_request_id();
        let mut m = json!({ "type": "answer", "id": 4, "text": "hi", "request_id": keep });
        assert_eq!(stamp_answer(&tel, &mut m).as_deref(), Some(keep.as_str()));

        for mut m in [json!({ "type": "answer", "id": 5, "text": null }), json!({ "type": "answer", "text": "  " }), json!({ "type": "menu", "id": "x" })] {
            assert_eq!(stamp_answer(&tel, &mut m), None);
            assert!(m.get("request_id").is_none());
        }
    }

    #[test]
    fn start_at_is_back_dated_and_errors_carry_a_code() {
        let (tel, got) = capture();
        let at = Instant::now() - std::time::Duration::from_millis(250);
        let s = tel.start_at("host.cold_start", None, None, at, Attrs::new());
        tel.end(s, Outcome::Ok, None, Attrs::new());
        tel.record_error("host.error", None, "menu_build_failed", Attrs::new());
        let ev = got.lock().unwrap().clone();
        let start_ts = ev[0]["ts"].as_u64().unwrap();
        assert!(ev[1]["ts"].as_u64().unwrap() - start_ts >= 240);
        assert!(ev[1]["duration_ms"].as_f64().unwrap() >= 250.0);
        assert_eq!((&ev[2]["kind"], &ev[2]["outcome"], &ev[2]["error_code"]), (&json!("event"), &json!("error"), &json!("menu_build_failed")));
    }

    #[test]
    fn ids_have_the_right_shape() {
        let a = new_request_id();
        assert!(is_request_id(&a) && a != new_request_id());
        assert_eq!(new_step_id().len(), 16);
        assert!(!is_request_id("abc") && !is_request_id(&"A".repeat(32)));
    }

    #[test]
    fn overhead_p95_under_one_ms() {
        let tel = Telemetry::new();
        tel.set_sink(|e| {
            std::hint::black_box(e.to_string());
        });
        let rid = new_request_id();
        let mut times: Vec<f64> = (0..5000)
            .map(|_| {
                let t = Instant::now();
                let s = tel.start("host.voice_session", Some(&rid), None, attrs(json!({ "mode": "hold", "streaming": true })));
                tel.end(s, Outcome::Ok, None, Attrs::new());
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        times.sort_by(f64::total_cmp);
        let p95 = times[times.len() * 95 / 100];
        eprintln!("host telemetry start+end p95: {p95:.4} ms (incl. JSON encoding)");
        assert!(p95 < 1.0, "p95 {p95} ms");
    }
}
