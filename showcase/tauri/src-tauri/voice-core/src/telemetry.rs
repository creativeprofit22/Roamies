//! Voice helper telemetry (schema v1, see docs/telemetry.md): start a step, end it, record an event.
//! Events go out as `{"type":"telemetry","event":…}` protocol lines; the helper never writes files.

use crate::protocol::{Emitter, Event};
use serde_json::{json, Map, Value};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const SCHEMA: u32 = 1;
pub type Attrs = Map<String, Value>;

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
    on: bool,
}

impl Default for Telemetry {
    fn default() -> Self {
        Telemetry { on: true }
    }
}

impl Telemetry {
    pub fn set_enabled(&mut self, on: bool) {
        self.on = on;
    }

    pub fn enabled(&self) -> bool {
        self.on
    }

    pub fn start<W: Write>(
        &self,
        out: &mut Emitter<W>,
        name: &'static str,
        request_id: Option<&str>,
        parent: Option<&Step>,
        attrs: Attrs,
    ) -> Step {
        self.start_ago(out, name, request_id, parent, attrs, Duration::ZERO)
    }

    /// Like `start`, but the step began `ago` earlier (the chord went down before it became a talk).
    pub fn start_ago<W: Write>(
        &self,
        out: &mut Emitter<W>,
        name: &'static str,
        request_id: Option<&str>,
        parent: Option<&Step>,
        attrs: Attrs,
        ago: Duration,
    ) -> Step {
        let step = Step {
            id: new_step_id(),
            name,
            request_id: request_id.map(str::to_string),
            parent: parent.map(|p| p.id.clone()),
            started: Instant::now().checked_sub(ago).unwrap_or_else(Instant::now),
        };
        if self.on {
            let ts = now_ms().saturating_sub(ago.as_millis() as u64);
            send(out, event(ts, "start", &step, None, None, None, attrs));
        }
        step
    }

    pub fn end<W: Write>(&self, out: &mut Emitter<W>, step: Step, outcome: Outcome, error_code: Option<&str>, attrs: Attrs) {
        if !self.on {
            return;
        }
        let ms = (step.started.elapsed().as_secs_f64() * 1000.0 * 1000.0).round() / 1000.0;
        send(out, event(now_ms(), "end", &step, Some(ms), Some(outcome), error_code, attrs));
    }

    pub fn record<W: Write>(
        &self,
        out: &mut Emitter<W>,
        name: &'static str,
        request_id: Option<&str>,
        parent: Option<&Step>,
        attrs: Attrs,
    ) {
        if !self.on {
            return;
        }
        let step = Step {
            id: new_step_id(),
            name,
            request_id: request_id.map(str::to_string),
            parent: parent.map(|p| p.id.clone()),
            started: Instant::now(),
        };
        send(out, event(now_ms(), "event", &step, None, None, None, attrs));
    }
}

fn send<W: Write>(out: &mut Emitter<W>, event: Value) {
    if let Err(e) = out.emit(&Event::Telemetry { event }) {
        eprintln!("[voice] telemetry: {e}");
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
        "app_version": "",
        "os": os(),
        "request_id": step.request_id,
        "step_id": step.id,
        "parent_step_id": step.parent,
        "kind": kind,
        "step": step.name,
        "component": "voice",
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

fn now_ms() -> u64 {
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

    fn lines(em: &Emitter<Vec<u8>>) -> Vec<Value> {
        String::from_utf8_lossy(em.get_ref()).lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn start_and_end_share_a_step_id_and_match_the_schema() {
        let tel = Telemetry::default();
        let mut em = Emitter::new(Vec::new());
        let rid = new_request_id();
        let mut a = Attrs::new();
        a.insert("engine".into(), json!("fake"));
        let parent = tel.start(&mut em, "voice.session", Some(&rid), None, a);
        let child = tel.start(&mut em, "voice.listen", Some(&rid), Some(&parent), Attrs::new());
        tel.end(&mut em, child, Outcome::Ok, None, Attrs::new());
        tel.end(&mut em, parent, Outcome::Error, Some("nothing_heard"), Attrs::new());
        let ev = lines(&em);
        assert_eq!(ev.len(), 4);
        for e in &ev {
            assert_eq!(e["type"], "telemetry");
            let t = &e["event"];
            assert_eq!(t["schema"], 1);
            assert_eq!(t["component"], "voice");
            assert_eq!(t["request_id"], rid.as_str());
            assert_eq!(t["step_id"].as_str().unwrap().len(), 16);
            assert!(t["ts"].as_u64().unwrap() > 1_600_000_000_000);
        }
        assert_eq!(ev[0]["event"]["step_id"], ev[3]["event"]["step_id"]);
        assert_eq!(ev[1]["event"]["parent_step_id"], ev[0]["event"]["step_id"]);
        assert_eq!(ev[0]["event"]["attrs"]["engine"], "fake");
        assert_eq!(ev[3]["event"]["kind"], "end");
        assert_eq!(ev[3]["event"]["outcome"], "error");
        assert_eq!(ev[3]["event"]["error_code"], "nothing_heard");
        assert!(ev[3]["event"]["duration_ms"].is_number());
        assert!(ev[0]["event"]["duration_ms"].is_null());
    }

    #[test]
    fn back_dated_start() {
        let tel = Telemetry::default();
        let mut em = Emitter::new(Vec::new());
        let before = now_ms();
        let s = tel.start_ago(&mut em, "voice.session", None, None, Attrs::new(), Duration::from_millis(300));
        let ts = lines(&em)[0]["event"]["ts"].as_u64().unwrap();
        assert!(ts <= before.saturating_sub(299), "{ts} vs {before}");
        tel.end(&mut em, s, Outcome::Ok, None, Attrs::new());
        assert!(lines(&em)[1]["event"]["duration_ms"].as_f64().unwrap() >= 299.0);
    }

    #[test]
    fn off_emits_nothing() {
        let mut tel = Telemetry::default();
        tel.set_enabled(false);
        let mut em = Emitter::new(Vec::new());
        let s = tel.start(&mut em, "voice.session", None, None, Attrs::new());
        tel.record(&mut em, "voice.x", None, Some(&s), Attrs::new());
        tel.end(&mut em, s, Outcome::Ok, None, Attrs::new());
        assert!(em.get_ref().is_empty());
    }

    #[test]
    fn ids_have_the_right_shape_and_differ() {
        let a = new_request_id();
        let b = new_request_id();
        assert!(is_request_id(&a) && is_request_id(&b) && a != b);
        assert_eq!(new_step_id().len(), 16);
        assert!(!is_request_id("ABC") && !is_request_id(&"g".repeat(32)));
    }

    #[test]
    fn overhead_p95_under_one_ms() {
        let tel = Telemetry::default();
        let mut em = Emitter::new(Vec::new());
        let rid = new_request_id();
        let mut times: Vec<f64> = (0..2000)
            .map(|_| {
                let t = Instant::now();
                let s = tel.start(&mut em, "voice.session", Some(&rid), None, Attrs::new());
                tel.end(&mut em, s, Outcome::Ok, None, Attrs::new());
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        times.sort_by(|a, b| a.total_cmp(b));
        let p95 = times[times.len() * 95 / 100];
        println!("voice telemetry start+end p95: {p95:.4} ms (incl. JSON line)");
        assert!(p95 < 1.0, "p95 {p95} ms");
    }
}
