// Shadow mode (docs/voice-engines.md): the other engine re-transcribes each take in the background, for
// comparison only. Like GitHub Scientist's control/candidate, the primary's text is the only one ever used;
// this module can only write `host.stt_shadow` telemetry, never to the overlays, the sidecar's voice or
// dictation messages, or the UI.

use super::*;
use roamies_voice_core::score;
use std::collections::VecDeque;
use std::process::ChildStdin;
use std::sync::Arc;

/// Primary finals kept for comparison (memory only, dropped once used).
const KEEP: usize = 4;
/// A job the shadow never answered stops counting as busy after this.
const BUSY_FOR: Duration = Duration::from_secs(90);

/// Where a primary helper line goes. Shadow audio and anything shadow-shaped never reach the UI routes.
#[derive(Debug, PartialEq)]
pub(crate) enum Route {
    Ui,
    Shadow,
    Drop,
}

pub(crate) fn route(msg: &Value) -> Route {
    match msg.get("type").and_then(Value::as_str) {
        Some("audio") => Route::Shadow,
        Some("shadow") => Route::Drop,
        _ => Route::Ui,
    }
}

/// The shadow's bookkeeping: recent primary finals by request id and the one job in flight.
#[derive(Default)]
pub(crate) struct Book {
    finals: VecDeque<(String, String, Option<String>)>,
    busy: Option<(String, Instant)>,
    engine: Option<String>,
}

impl Book {
    fn note_final(&mut self, rid: &str, text: &str, primary_engine: Option<&str>) {
        self.finals.retain(|(r, ..)| r != rid);
        self.finals.push_back((rid.to_owned(), text.to_owned(), primary_engine.map(str::to_owned)));
        while self.finals.len() > KEEP {
            self.finals.pop_front();
        }
    }

    /// Claims the shadow for a job, or says why not.
    fn claim(&mut self, rid: &str, now: Instant) -> Result<(), &'static str> {
        if self.busy.as_ref().is_some_and(|(_, at)| now.duration_since(*at) < BUSY_FOR) {
            return Err("busy");
        }
        self.busy = Some((rid.to_owned(), now));
        Ok(())
    }
}

/// One `host.stt_shadow` result: its request id, attrs and error code.
#[derive(Debug)]
pub(crate) struct Shadowed {
    pub rid: String,
    pub attrs: telemetry::Attrs,
    pub error: Option<String>,
}

/// Word agreement between the two engines, and S/I/D with the primary as the reference.
fn agreement(primary: &str, shadow: &str) -> telemetry::Attrs {
    let (p, s) = (score::normalize(primary), score::normalize(shadow));
    let e = score::word_alignment(&p, &s);
    let longest = p.len().max(s.len());
    let a = if longest == 0 { 1.0 } else { 1.0 - e.total() as f64 / longest as f64 };
    telemetry::attrs(json!({ "agreement": (a * 10_000.0).round() / 10_000.0, "sub": e.sub, "ins": e.ins, "del": e.del }))
}

/// The shadow helper's one output that matters. Every other line, whatever it is, gives nothing.
pub(crate) fn on_line(book: &mut Book, msg: &Value) -> Option<Shadowed> {
    if msg.get("type").and_then(Value::as_str) != Some("shadow") {
        return None;
    }
    let rid = msg.get("request_id").and_then(Value::as_str).filter(|r| telemetry::is_request_id(r))?.to_owned();
    if book.busy.as_ref().is_some_and(|(r, _)| *r == rid) {
        book.busy = None;
    }
    let primary = book.finals.iter().position(|(r, ..)| *r == rid).and_then(|i| book.finals.remove(i));
    let mut a = telemetry::Attrs::new();
    if let Some(m) = msg.get("metrics").and_then(|m| serde_json::from_value::<roamies_voice_core::protocol::Metrics>(m.clone()).ok()) {
        if let Ok(Value::Object(fields)) = serde_json::to_value(m) {
            a.extend(fields.into_iter().filter(|(_, v)| !v.is_null()));
        }
    }
    if let Some(e) = &book.engine {
        a.insert("engine".into(), json!(e));
    }
    a.insert("role".into(), json!("shadow"));
    let error = msg.get("error").and_then(Value::as_str).map(str::to_owned);
    if let (Some((_, text, engine)), None) = (primary, &error) {
        if let Some(e) = engine {
            a.insert("primary_engine".into(), json!(e));
        }
        a.extend(agreement(&text, msg.get("text").and_then(Value::as_str).unwrap_or("")));
    }
    Some(Shadowed { rid, attrs: a, error })
}

/// The shadow engine the sidecar asked for in `voice_config.shadow` (only sent when its model is ready).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Want {
    pub engine: String,
    pub model: String,
}

pub(crate) fn want_from(config: &Value) -> Option<Want> {
    if config.get("enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let s = config.get("shadow")?;
    if s.get("ready").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let field = |k: &str| s.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned);
    Some(Want { engine: field("engine")?, model: field("model")? })
}

struct Proc {
    want: Want,
    pid: u32,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

static PROC: Mutex<Option<Proc>> = Mutex::new(None);
static BOOK: Mutex<Option<Book>> = Mutex::new(None);
/// Whether the primary helper should keep each take for the shadow (resent whenever it restarts).
static ON: AtomicBool = AtomicBool::new(false);

fn book<R>(f: impl FnOnce(&mut Book) -> R) -> R {
    f(BOOK.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Book::default))
}

pub(crate) fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

/// Starts, switches or stops the shadow helper to match the sidecar's config, and tells the primary.
pub(crate) fn sync(app: &AppHandle, want: Option<Want>) {
    let mut slot = PROC.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().map(|p| &p.want) != want.as_ref() {
        if let Some(p) = slot.take() {
            retire(p);
        }
        if let Some(w) = want.clone() {
            *slot = spawn(w);
        }
    }
    let on = slot.is_some();
    drop(slot);
    ON.store(on, Ordering::Relaxed);
    book(|b| {
        b.engine = want.map(|w| w.engine);
        if !on {
            *b = Book::default();
        }
    });
    to_voice(app, &json!({ "cmd": "shadow", "on": on }));
}

/// Closing stdin ends the helper's loop; kill it only if it hangs.
fn retire(mut p: Proc) {
    drop(p.stdin);
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = p.child.try_wait() {
                return voice_log(&format!("shadow stop pid {} exited", p.pid));
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = p.child.kill();
        let _ = p.child.wait();
        voice_log(&format!("shadow stop pid {} killed", p.pid));
    });
}

fn spawn(want: Want) -> Option<Proc> {
    let e = engines::get(&want.engine)?;
    let bin = helper_binary(&e.helper)?;
    let mut args = engines::args(e, bin.parent()?, Some(&want.model));
    args.push("--shadow".into());
    let mut cmd = Command::new(&bin);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_4000); // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
    }
    let mut child = match cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log_stdio("sidekick-voice.log")).spawn() {
        Ok(c) => c,
        Err(err) => {
            voice_log(&format!("shadow {} failed to start: {err}", want.engine));
            return None;
        }
    };
    let pid = child.id();
    let stdout = child.stdout.take()?;
    let stdin = Arc::new(Mutex::new(child.stdin.take()?));
    voice_log(&format!("shadow start {} pid {pid} model {}", want.engine, want.model));
    thread::spawn(move || {
        // Isolation: this thread's only outputs are `on_line` and telemetry.
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(s) = book(|b| on_line(b, &msg)) {
                match s.error {
                    Some(code) => telemetry::record_error("host.stt_shadow", Some(&s.rid), &code, s.attrs),
                    None => telemetry::record("host.stt_shadow", Some(&s.rid), None, s.attrs),
                }
            }
        }
        voice_log(&format!("shadow pid {pid} output closed"));
    });
    Some(Proc { want, pid, child, stdin })
}

/// Windows battery saver is on (shadow work waits for mains power or the saver to switch off).
fn battery_saver() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        // SAFETY: a plain out-pointer to a stack struct of the right type.
        unsafe { GetSystemPowerStatus(&mut s) != 0 && s.SystemStatusFlag == 1 }
    }
    #[cfg(not(windows))]
    false
}

/// The primary's final, kept (memory only) to compare with the shadow's text.
pub(crate) fn note_final(rid: Option<&str>, text: &str, primary_engine: Option<&str>) {
    if let Some(r) = rid.filter(|_| on()) {
        book(|b| b.note_final(r, text, primary_engine));
    }
}

fn skip(rid: &str, code: &str) {
    let a = telemetry::attrs(json!({ "role": "shadow", "engine": book(|b| b.engine.clone()) }));
    telemetry::record_outcome("host.stt_shadow", Some(rid), telemetry::Outcome::Cancelled, code, a);
}

/// A primary `audio` line: hand it to the shadow as a `transcribe` job, or record why it was skipped.
pub(crate) fn on_audio(msg: &Value) {
    let Some(rid) = msg.get("request_id").and_then(Value::as_str).filter(|r| telemetry::is_request_id(r)) else { return };
    let Some(pcm) = msg.get("pcm").and_then(Value::as_str) else { return };
    if battery_saver() {
        return skip(rid, "battery_saver");
    }
    let Some(stdin) = PROC.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|p| p.stdin.clone()) else {
        return skip(rid, "not_installed");
    };
    if let Err(code) = book(|b| b.claim(rid, Instant::now())) {
        return skip(rid, code);
    }
    let job = json!({ "cmd": "transcribe", "request_id": rid, "pcm": pcm }).to_string();
    let rid = rid.to_owned();
    // A 60 s take is ~2.6 MB of base64: written off the main thread.
    thread::spawn(move || {
        let ok = writeln!(stdin.lock().unwrap_or_else(|e| e.into_inner()), "{job}").is_ok();
        if !ok {
            book(|b| b.busy = None);
            skip(&rid, "not_running");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rid() -> String {
        telemetry::new_request_id()
    }

    fn shadow_line(rid: &str, text: &str) -> Value {
        json!({ "type": "shadow", "request_id": rid, "text": text,
                "metrics": { "audio_s": 2.0, "compute_s": 0.5, "rtf": 0.25, "warmup_ms": 3.0, "speech_end_to_final_ms": 500.0,
                             "time_to_first_partial_ms": null, "partial_count": 0, "empty": false } })
    }

    #[test]
    fn audio_and_shadow_lines_never_take_a_ui_route() {
        assert_eq!(route(&json!({ "type": "audio", "request_id": "r", "pcm": "" })), Route::Shadow);
        assert_eq!(route(&json!({ "type": "shadow", "request_id": "r", "text": "hi" })), Route::Drop);
        for t in ["final", "partial", "state", "level", "error", "ready", "telemetry"] {
            assert_eq!(route(&json!({ "type": t })), Route::Ui, "{t}");
        }
    }

    #[test]
    fn only_shadow_lines_give_telemetry_and_never_text() {
        let mut b = Book { engine: Some("parakeet".into()), ..Default::default() };
        let r = rid();
        b.note_final(&r, "turn on the lights", Some("moonshine"));
        // A shadow helper that misbehaves and prints primary-style events: none of it goes anywhere.
        for t in ["final", "partial", "state", "level", "error", "audio"] {
            assert!(on_line(&mut b, &json!({ "type": t, "request_id": r, "text": "turn off the lights" })).is_none(), "{t}");
        }
        assert!(on_line(&mut b, &json!({ "type": "shadow", "request_id": "not-an-id", "text": "x" })).is_none());
        let s = on_line(&mut b, &shadow_line(&r, "Turn off the lights.")).unwrap();
        assert_eq!(s.rid, r);
        assert!(s.error.is_none());
        let a = &s.attrs;
        assert_eq!(a["role"], "shadow");
        assert_eq!(a["engine"], "parakeet");
        assert_eq!(a["primary_engine"], "moonshine");
        assert_eq!(a["agreement"], 0.75);
        assert_eq!((a["sub"].clone(), a["ins"].clone(), a["del"].clone()), (json!(1), json!(0), json!(0)));
        assert_eq!(a["rtf"], 0.25);
        assert!(!a.contains_key("time_to_first_partial_ms"), "nulls left out");
        assert!(!a.contains_key("text") && !a.values().any(|v| v.as_str().is_some_and(|s| s.contains("lights"))), "{a:?}");
        // The primary's text is used once, then gone.
        assert!(b.finals.is_empty());
        assert!(!on_line(&mut b, &shadow_line(&r, "x")).unwrap().attrs.contains_key("agreement"));
    }

    #[test]
    fn agreement_maths() {
        assert_eq!(agreement("", "")["agreement"], 1.0);
        assert_eq!(agreement("Hello, world", "hello world")["agreement"], 1.0);
        assert_eq!(agreement("a b c d", "")["agreement"], 0.0);
        assert_eq!(agreement("a b c d", "")["del"], 4);
        let a = agreement("the cat sat", "a cat sat down");
        assert_eq!(a["agreement"], 0.5);
        assert_eq!((a["sub"].clone(), a["ins"].clone(), a["del"].clone()), (json!(1), json!(1), json!(0)));
    }

    #[test]
    fn one_job_at_a_time_and_finals_are_bounded() {
        let mut b = Book::default();
        let t0 = Instant::now();
        let (r1, r2) = (rid(), rid());
        assert_eq!(b.claim(&r1, t0), Ok(()));
        assert_eq!(b.claim(&r2, t0), Err("busy"));
        assert_eq!(b.claim(&r2, t0 + BUSY_FOR), Ok(()), "a stuck job stops blocking");
        on_line(&mut b, &shadow_line(&r2, "x"));
        assert_eq!(b.claim(&r1, t0 + BUSY_FOR), Ok(()), "an answer frees it");
        for i in 0..10 {
            b.note_final(&format!("{i}"), "t", None);
        }
        assert_eq!(b.finals.len(), KEEP);
        assert_eq!(b.finals.front().unwrap().0, "6");
    }

    #[test]
    fn errors_carry_their_code_and_no_agreement() {
        let mut b = Book::default();
        let r = rid();
        b.note_final(&r, "hi", None);
        let s = on_line(&mut b, &json!({ "type": "shadow", "request_id": r, "text": "", "error": "no_input" })).unwrap();
        assert_eq!(s.error.as_deref(), Some("no_input"));
        assert!(!s.attrs.contains_key("agreement"));
    }

    #[test]
    fn want_needs_voice_on_and_a_ready_model() {
        let cfg = |enabled: bool, shadow: Value| json!({ "type": "voice_config", "enabled": enabled, "shadow": shadow });
        let ok = json!({ "engine": "parakeet", "model": "C:/m/p", "ready": true });
        assert_eq!(want_from(&cfg(true, ok.clone())), Some(Want { engine: "parakeet".into(), model: "C:/m/p".into() }));
        assert_eq!(want_from(&cfg(false, ok)), None, "voice off");
        assert_eq!(want_from(&cfg(true, json!({ "engine": "parakeet", "model": "C:/m/p", "ready": false }))), None);
        assert_eq!(want_from(&cfg(true, json!({ "engine": "parakeet", "ready": true }))), None);
        assert_eq!(want_from(&json!({ "type": "voice_config", "enabled": true })), None, "setting off");
    }

    #[test]
    fn battery_saver_is_queryable() {
        let _ = battery_saver();
    }
}
