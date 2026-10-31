//! Runs the talk session: `chord::SessionMachine` decides, this executes its actions on the engine
//! and emits events. Time is passed in so tests and `--wav` runs are deterministic.

use crate::level::level;
use crate::chord::{Action, KeySource, Mods, Phase, SessionMachine};
use crate::engine::{EngineError, SpeechEngine};
#[cfg(test)]
use crate::engine::VOICE_LEVEL;
use crate::protocol::{Emitter, ErrorCode, Event, Mode, SessionState};
use crate::telemetry::{is_request_id, new_request_id, Attrs, Outcome, Step, Telemetry};
use serde_json::json;
use std::io::Write;
use std::time::Duration;

const LEVEL_EVERY: f64 = 0.05;

pub struct Session<E: SpeechEngine, W: Write> {
    engine: E,
    out: Emitter<W>,
    machine: SessionMachine,
    best: String,
    level_at: f64,
    engine_ok: bool,
    /// The mic failed while armed: stay quiet (it may be a shortcut) and don't retry until it's a talk.
    mic_down: bool,
    shown: bool,
    tel: Telemetry,
    /// The host's id for the next chord talk, bound when a press becomes a talk.
    pending_rid: Option<String>,
    armed_at: Option<f64>,
    audio_samples: usize,
    session_step: Option<Step>,
    listen_step: Option<Step>,
    fail_code: Option<&'static str>,
}

impl<E: SpeechEngine, W: Write> Session<E, W> {
    pub fn new(engine: E, out: Emitter<W>) -> Self {
        let mut machine = SessionMachine::new();
        machine.set_finish_only(!engine.streaming());
        Session {
            engine,
            out,
            machine,
            best: String::new(),
            level_at: f64::NEG_INFINITY,
            engine_ok: false,
            mic_down: false,
            shown: false,
            tel: Telemetry::default(),
            pending_rid: None,
            armed_at: None,
            audio_samples: 0,
            session_step: None,
            listen_step: None,
            fail_code: None,
        }
    }

    /// `{"cmd":"request"}`: the id for the next chord talk; malformed ids are ignored.
    pub fn set_request_id(&mut self, id: &str) {
        if is_request_id(id) {
            self.pending_rid = Some(id.to_string());
        }
    }

    /// `{"cmd":"telemetry"}`.
    pub fn set_telemetry(&mut self, on: bool) {
        self.tel.set_enabled(on);
    }

    pub fn emit(&mut self, event: &Event) {
        if let Err(e) = self.out.emit(event) {
            log(&format!("stdout: {e}"));
        }
    }

    pub fn engine_name(&self) -> String {
        self.engine.name().to_string()
    }

    pub fn engine_model(&self) -> Option<String> {
        self.engine.model()
    }

    /// Loads the model up front so arming never waits on it; failures surface when a talk starts.
    pub fn prepare(&mut self) {
        if let Err(e) = self.engine.prepare() {
            log(&e.to_string());
        }
    }

    /// True while the mic should be open: from the chord going down until the end tail is over.
    pub fn wants_audio(&self) -> bool {
        self.machine.phase() != Phase::Idle && !self.mic_down
    }

    #[cfg(test)]
    pub fn is_idle(&self) -> bool {
        self.machine.phase() == Phase::Idle
    }

    fn talking(&self) -> bool {
        matches!(self.machine.phase(), Phase::Holding | Phase::HandsFree)
    }

    /// Starts a hands-free session (the `listen` command). Ignored unless idle.
    /// `now` is read after the engine starts: the first start loads the model, which can take seconds.
    pub fn listen(&mut self, now: impl FnOnce() -> f64) -> Result<(), EngineError> {
        self.listen_with(None, now)
    }

    /// `listen` for a request the host already has an id for; without one a fresh id is minted, so
    /// the chord's pending id is kept.
    pub fn listen_with(&mut self, request_id: Option<String>, now: impl FnOnce() -> f64) -> Result<(), EngineError> {
        if self.machine.phase() != Phase::Idle {
            return Ok(());
        }
        self.best.clear();
        self.mic_down = false;
        self.armed_at = None;
        self.audio_samples = 0;
        let rid = request_id.filter(|r| is_request_id(r)).unwrap_or_else(new_request_id);
        self.begin(Mode::Handsfree, 0.0, Some(rid));
        if let Err(e) = self.engine.start() {
            log(&e.to_string());
            self.unavailable();
            return Err(e);
        }
        self.engine_ok = true;
        let now = now();
        let actions: Vec<Action> = self.machine.listen_now(now).into_iter().filter(|a| *a != Action::Arm).collect();
        self.run(actions, now)
    }

    /// Polls the talk chord and the session timers.
    pub fn tick(&mut self, now: f64, keys: &mut dyn KeySource) {
        let actions = self.machine.tick(now, keys);
        let _ = self.run(actions, now);
    }

    /// Ends now and delivers after the tail (`--wav` end of file).
    pub fn finish(&mut self, now: f64) {
        let actions = self.machine.finish_now(now);
        let _ = self.run(actions, now);
    }

    /// The `cancel` command; a session already finishing still delivers its text, like the Mac helper.
    pub fn cancel(&mut self) {
        let actions = self.machine.external_cancel();
        let _ = self.run(actions, 0.0);
    }

    /// `--chord` and `{"cmd":"chord"}`; bad names keep the current chord.
    pub fn set_chord(&mut self, names: &[String]) {
        match Mods::parse(names) {
            Some(m) => {
                log(&format!("talk chord: {}", names.join("+")));
                let actions = self.machine.set_chord(m);
                let _ = self.run(actions, 0.0);
            }
            None => log(&format!("ignoring talk chord {:?}: need two of control, alt, win, shift", names)),
        }
    }

    /// 16 kHz mono audio from the mic or a WAV.
    pub fn audio(&mut self, samples: &[f32], now: f64) {
        if self.machine.phase() == Phase::Idle || samples.is_empty() {
            return;
        }
        self.audio_samples += samples.len();
        let v = level(samples);
        if v > self.engine.voice_level() {
            self.machine.on_voice(now);
        }
        // Armed may still turn out to be a shortcut, so nothing shows until it's a talk.
        let shown = self.talking();
        if shown && now - self.level_at >= LEVEL_EVERY {
            self.level_at = now;
            self.emit(&Event::level(v));
        }
        self.engine.accept(samples);
        if let Some(text) = self.engine.partial() {
            let text = text.trim().to_string();
            if text != self.best && !text.is_empty() {
                self.best = text.clone();
                self.machine.on_text(now, true);
                if shown {
                    self.emit(&Event::Partial { text });
                }
            }
        }
        if self.engine.endpoint() {
            self.machine.on_endpoint();
        }
    }

    /// The mic couldn't open or died: same as the Mac helper's `no_input` once it's a talk.
    pub fn audio_failed(&mut self) {
        self.fail_audio(Event::error(ErrorCode::NoInput), "no_input");
    }

    /// The mic is off in Windows privacy settings: like `audio_failed`, but the host can point there.
    pub fn mic_denied(&mut self) {
        self.fail_audio(
            Event::Error { code: ErrorCode::Permission, spoke: None, message: None, what: Some("microphone") },
            "permission",
        );
    }

    fn fail_audio(&mut self, event: Event, code: &'static str) {
        match self.machine.phase() {
            Phase::Idle => {}
            Phase::Armed => self.mic_down = true,
            // The tail can't be cancelled; deliver what was heard and stop retrying the mic.
            Phase::Finishing { .. } => self.mic_down = true,
            Phase::Holding | Phase::HandsFree => {
                self.emit(&event);
                self.fail_code = Some(code);
                self.cancel();
            }
        }
    }

    fn run(&mut self, actions: Vec<Action>, now: f64) -> Result<(), EngineError> {
        for a in actions {
            match a {
                Action::Arm => {
                    self.best.clear();
                    self.mic_down = false;
                    self.armed_at = Some(now);
                    self.audio_samples = 0;
                    self.engine_ok = match self.engine.start() {
                        Ok(()) => true,
                        Err(e) => {
                            log(&e.to_string());
                            false
                        }
                    };
                }
                Action::Listen(mode) => self.show(mode, now)?,
                Action::Finish { shown } => {
                    self.shown = shown;
                    if let Some(step) = self.listen_step.take() {
                        self.tel.end(&mut self.out, step, Outcome::Ok, None, Attrs::new());
                    }
                    if shown {
                        self.emit(&Event::state(SessionState::Processing));
                    }
                }
                Action::Finalize => self.finalize(),
                Action::Cancel => {
                    self.engine.cancel();
                    self.mic_down = false;
                    self.emit(&Event::State { state: SessionState::Idle, mode: None, cancelled: Some(true) });
                    match self.fail_code.take() {
                        Some(code) => self.end_session(Outcome::Error, Some(code), None),
                        None => self.end_session(Outcome::Cancelled, None, None),
                    }
                }
            }
        }
        Ok(())
    }

    fn show(&mut self, mode: Mode, now: f64) -> Result<(), EngineError> {
        // The session started when the chord went down, before it was known to be a talk.
        let ago = self.armed_at.take().map_or(0.0, |a| now - a);
        self.begin(mode, ago, None);
        if !self.engine_ok {
            if let Err(e) = self.engine.start() {
                log(&e.to_string());
                let _ = self.machine.external_cancel();
                self.unavailable();
                return Err(e);
            }
            self.engine_ok = true;
        }
        // It's a talk now, so a mic that failed while armed is retried and reported for real.
        self.mic_down = false;
        self.level_at = f64::NEG_INFINITY;
        let mut a = Attrs::new();
        a.insert("mode".into(), json!(mode));
        let parent = self.session_step.as_ref();
        let rid = parent.and_then(|p| p.request_id.clone());
        self.listen_step = Some(self.tel.start(&mut self.out, "voice.listen", rid.as_deref(), parent, a));
        self.emit(&Event::State { state: SessionState::Listening, mode: Some(mode), cancelled: None });
        if !self.best.is_empty() {
            let text = self.best.clone();
            self.emit(&Event::Partial { text });
        }
        Ok(())
    }

    fn unavailable(&mut self) {
        self.mic_down = false;
        self.emit(&Event::error(ErrorCode::Unavailable));
        self.emit(&Event::State { state: SessionState::Idle, mode: None, cancelled: Some(true) });
        self.end_session(Outcome::Error, Some("unavailable"), None);
    }

    /// Opens `voice.session` (once per talk), binding the request id.
    fn begin(&mut self, mode: Mode, ago: f64, request_id: Option<String>) {
        if self.session_step.is_some() {
            return;
        }
        let rid = request_id.or_else(|| self.pending_rid.take()).unwrap_or_else(new_request_id);
        let mut a = Attrs::new();
        a.insert("engine".into(), json!(self.engine.name()));
        a.insert("mode".into(), json!(mode));
        a.insert("streaming".into(), json!(self.engine.streaming()));
        let ago = Duration::from_secs_f64(ago.clamp(0.0, 3600.0));
        self.session_step = Some(self.tel.start_ago(&mut self.out, "voice.session", Some(&rid), None, a, ago));
    }

    fn end_session(&mut self, outcome: Outcome, code: Option<&str>, chars: Option<usize>) {
        if let Some(step) = self.listen_step.take() {
            self.tel.end(&mut self.out, step, outcome, code, Attrs::new());
        }
        let Some(step) = self.session_step.take() else { return };
        let mut a = Attrs::new();
        a.insert("audio_ms".into(), json!(self.audio_samples / 16));
        if let Some(n) = chars {
            a.insert("chars".into(), json!(n));
        }
        self.tel.end(&mut self.out, step, outcome, code, a);
    }

    fn finalize(&mut self) {
        let parent = self.session_step.as_ref();
        let rid = parent.and_then(|p| p.request_id.clone());
        let step = parent.map(|p| self.tel.start(&mut self.out, "voice.finalize", rid.as_deref(), Some(p), Attrs::new()));
        let heard = self.engine.finish();
        if let Some(step) = step {
            let mut a = Attrs::new();
            a.insert("chars".into(), json!(heard.trim().chars().count()));
            self.tel.end(&mut self.out, step, Outcome::Ok, None, a);
        }
        let heard = heard.trim();
        let text = if heard.is_empty() { self.best.trim().to_string() } else { heard.to_string() };
        if !text.is_empty() {
            self.emit(&Event::Final { text: text.clone() });
        }
        self.emit(&Event::state(SessionState::Idle));
        if text.is_empty() && self.shown {
            let spoke = self.machine.spoke();
            self.emit(&Event::Error { code: ErrorCode::NothingHeard, spoke: Some(spoke), message: None, what: None });
        }
        let chars = Some(text.chars().count());
        match (text.is_empty(), self.shown) {
            (false, _) => self.end_session(Outcome::Ok, None, chars),
            (true, true) => self.end_session(Outcome::Error, Some("nothing_heard"), chars),
            (true, false) => self.end_session(Outcome::Cancelled, None, chars),
        }
    }

    #[cfg(test)]
    pub fn output(&self) -> &W {
        self.out.get_ref()
    }
}

fn log(s: &str) {
    eprintln!("[voice] {s}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chord::NoKeys;
    use serde_json::{json, Value};

    /// Hears `words` one by one, one word per `per` samples of loud audio.
    struct FakeEngine {
        words: Vec<&'static str>,
        per: usize,
        loud: usize,
        available: bool,
        started: bool,
        on_start: Option<Box<dyn FnMut()>>,
    }

    impl FakeEngine {
        fn new(words: &[&'static str]) -> Self {
            FakeEngine { words: words.to_vec(), per: 1600, loud: 0, available: true, started: false, on_start: None }
        }
        fn text(&self) -> String {
            let n = (self.loud / self.per).min(self.words.len());
            self.words[..n].join(" ")
        }
    }

    impl SpeechEngine for FakeEngine {
        fn name(&self) -> &str {
            "fake"
        }
        fn start(&mut self) -> Result<(), EngineError> {
            if !self.available {
                return Err(EngineError::Unavailable("no model".into()));
            }
            if let Some(f) = self.on_start.as_mut() {
                f();
            }
            self.started = true;
            self.loud = 0;
            Ok(())
        }
        fn accept(&mut self, samples: &[f32]) {
            if self.started && level(samples) > VOICE_LEVEL {
                self.loud += samples.len();
            }
        }
        fn partial(&mut self) -> Option<String> {
            Some(self.text())
        }
        fn finish(&mut self) -> String {
            self.started = false;
            self.text()
        }
        fn cancel(&mut self) {
            self.started = false;
        }
    }

    fn session(engine: FakeEngine) -> Session<FakeEngine, Vec<u8>> {
        Session::new(engine, Emitter::new(Vec::new()))
    }

    fn all_lines(out: &[u8]) -> Vec<Value> {
        String::from_utf8_lossy(out).lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    /// Protocol events without telemetry.
    fn plain(out: &[u8]) -> Vec<Value> {
        all_lines(out).into_iter().filter(|e| e["type"] != "telemetry").collect()
    }

    fn events(s: &Session<FakeEngine, Vec<u8>>) -> Vec<Value> {
        plain(s.output())
    }

    fn tele(s: &Session<FakeEngine, Vec<u8>>) -> Vec<Value> {
        all_lines(s.output()).into_iter().filter(|e| e["type"] == "telemetry").map(|e| e["event"].clone()).collect()
    }

    /// Telemetry events as `kind:step`.
    fn tele_kinds(s: &Session<FakeEngine, Vec<u8>>) -> Vec<String> {
        tele(s).iter().map(|e| format!("{}:{}", e["kind"].as_str().unwrap(), e["step"].as_str().unwrap())).collect()
    }

    /// Event types, with the state name for `state` events.
    fn kinds(s: &Session<FakeEngine, Vec<u8>>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for e in events(s) {
            let k = match e["type"].as_str().unwrap() {
                "state" => e["state"].as_str().unwrap().to_string(),
                "error" => format!("error:{}", e["code"].as_str().unwrap()),
                t => t.to_string(),
            };
            if out.last() != Some(&k) {
                out.push(k);
            }
        }
        out
    }

    const LOUD: [f32; 1600] = [0.3; 1600];
    const QUIET: [f32; 1600] = [0.0; 1600];

    /// Feeds 100 ms chunks and ticks, from `t`; returns the new time.
    fn feed(s: &mut Session<FakeEngine, Vec<u8>>, chunk: &[f32], n: usize, mut t: f64) -> f64 {
        for _ in 0..n {
            s.audio(chunk, t);
            s.tick(t, &mut NoKeys);
            t += 0.1;
        }
        t
    }

    #[test]
    fn full_session_event_order() {
        let mut s = session(FakeEngine::new(&["hello", "there"]));
        s.listen(|| 0.0).unwrap();
        let t = feed(&mut s, &LOUD, 2, 0.0);
        s.finish(t);
        s.tick(t + 0.31, &mut NoKeys);
        assert_eq!(kinds(&s), ["listening", "level", "partial", "level", "partial", "processing", "final", "idle"]);
        let ev = events(&s);
        assert_eq!(ev[0], json!({"type":"state","state":"listening","mode":"handsfree"}));
        assert!(ev.contains(&json!({"type":"partial","text":"hello"})));
        assert!(ev.contains(&json!({"type":"final","text":"hello there"})));
        assert_eq!(ev.last().unwrap(), &json!({"type":"state","state":"idle"}));
        assert!(s.is_idle() && !s.wants_audio());
    }

    #[test]
    fn levels_are_throttled_to_50ms() {
        let mut s = session(FakeEngine::new(&[]));
        s.listen(|| 0.0).unwrap();
        for i in 0..10 {
            s.audio(&QUIET[..160], i as f64 * 0.01);
        }
        let levels = events(&s).iter().filter(|e| e["type"] == "level").count();
        assert_eq!(levels, 2);
    }

    #[test]
    fn empty_session_reports_nothing_heard() {
        let mut s = session(FakeEngine::new(&[]));
        s.listen(|| 0.0).unwrap();
        let t = feed(&mut s, &QUIET, 3, 0.0);
        s.finish(t);
        s.tick(t + 0.31, &mut NoKeys);
        assert_eq!(kinds(&s), ["listening", "level", "processing", "idle", "error:nothing_heard"]);
        assert_eq!(events(&s).last().unwrap(), &json!({"type":"error","code":"nothing_heard","spoke":false}));
    }

    #[test]
    fn spoke_is_true_when_voice_was_loud_but_no_words() {
        let mut fake = FakeEngine::new(&[]);
        fake.per = usize::MAX;
        let mut s = session(fake);
        s.listen(|| 0.0).unwrap();
        let t = feed(&mut s, &LOUD, 3, 0.0);
        s.finish(t);
        s.tick(t + 0.31, &mut NoKeys);
        assert_eq!(events(&s).last().unwrap(), &json!({"type":"error","code":"nothing_heard","spoke":true}));
    }

    #[test]
    fn cancel_goes_idle_cancelled() {
        let mut s = session(FakeEngine::new(&["hi"]));
        s.listen(|| 0.0).unwrap();
        feed(&mut s, &LOUD, 1, 0.0);
        s.cancel();
        assert_eq!(events(&s).last().unwrap(), &json!({"type":"state","state":"idle","cancelled":true}));
        assert!(!events(&s).iter().any(|e| e["type"] == "final"));
        let n = events(&s).len();
        s.cancel();
        assert_eq!(events(&s).len(), n, "cancel when idle does nothing");
    }

    #[test]
    fn unavailable_engine_errors_and_stays_idle() {
        let mut fake = FakeEngine::new(&["hi"]);
        fake.available = false;
        let mut s = session(fake);
        assert!(s.listen(|| 0.0).is_err());
        assert_eq!(
            events(&s),
            [json!({"type":"error","code":"unavailable"}), json!({"type":"state","state":"idle","cancelled":true})]
        );
        assert!(!s.wants_audio());
    }

    #[test]
    fn mic_failure_is_no_input() {
        let mut s = session(FakeEngine::new(&[]));
        s.listen(|| 0.0).unwrap();
        s.audio_failed();
        assert_eq!(kinds(&s), ["listening", "error:no_input", "idle"]);
    }

    #[test]
    fn denied_mic_is_a_permission_error() {
        let mut s = session(FakeEngine::new(&[]));
        s.listen(|| 0.0).unwrap();
        s.mic_denied();
        assert!(events(&s).contains(&json!({"type":"error","code":"permission","what":"microphone"})));
        assert_eq!(kinds(&s), ["listening", "error:permission", "idle"]);
    }

    #[test]
    fn pause_after_words_ends_the_session() {
        let mut s = session(FakeEngine::new(&["hello"]));
        s.listen(|| 0.0).unwrap();
        let t = feed(&mut s, &LOUD, 1, 0.0);
        // Last quiet chunk at 1.4 s; 0.1-step float sums make an exact 1.5 s check flaky.
        let t = feed(&mut s, &QUIET, 14, t);
        assert!(!events(&s).iter().any(|e| e["state"] == "processing"), "1.5 s isn't over yet");
        let t = feed(&mut s, &QUIET, 3, t);
        feed(&mut s, &QUIET, 4, t);
        assert_eq!(kinds(&s), ["listening", "level", "partial", "level", "processing", "final", "idle"]);
    }

    #[test]
    fn eight_seconds_of_nothing_cancels() {
        let mut s = session(FakeEngine::new(&[]));
        s.listen(|| 0.0).unwrap();
        feed(&mut s, &QUIET, 79, 0.0);
        assert!(s.wants_audio());
        feed(&mut s, &QUIET, 3, 7.9);
        assert_eq!(events(&s).last().unwrap(), &json!({"type":"state","state":"idle","cancelled":true}));
    }

    #[test]
    fn caps_at_sixty_seconds() {
        let mut fake = FakeEngine::new(&["word"; 1000]);
        fake.per = 1600;
        let mut s = session(fake);
        s.listen(|| 0.0).unwrap();
        feed(&mut s, &LOUD, 602, 0.0);
        assert!(events(&s).iter().any(|e| e["state"] == "processing"));
    }

    #[test]
    fn listen_while_active_is_ignored() {
        let mut s = session(FakeEngine::new(&[]));
        s.listen(|| 0.0).unwrap();
        s.listen(|| 0.1).unwrap();
        assert_eq!(events(&s).iter().filter(|e| e["state"] == "listening").count(), 1);
    }

    #[test]
    fn slow_model_load_does_not_eat_the_nothing_heard_timer() {
        let clock = std::rc::Rc::new(std::cell::Cell::new(0.0));
        let mut fake = FakeEngine::new(&[]);
        let c = clock.clone();
        fake.on_start = Some(Box::new(move || c.set(12.0)));
        let mut s = session(fake);
        s.listen(|| clock.get()).unwrap();
        s.tick(12.1, &mut NoKeys);
        assert!(s.wants_audio(), "the 8 s timer starts after loading, not before");
    }

    /// Like the Parakeet engine: no partials, the text only comes from `finish`.
    struct FinishOnly(FakeEngine);

    impl SpeechEngine for FinishOnly {
        fn name(&self) -> &str {
            "finish-only"
        }
        fn start(&mut self) -> Result<(), EngineError> {
            self.0.start()
        }
        fn accept(&mut self, samples: &[f32]) {
            self.0.accept(samples)
        }
        fn partial(&mut self) -> Option<String> {
            None
        }
        fn finish(&mut self) -> String {
            self.0.finish()
        }
        fn cancel(&mut self) {
            self.0.cancel()
        }
        fn streaming(&self) -> bool {
            false
        }
    }

    #[test]
    fn finish_only_engine_ends_on_a_voice_pause_and_delivers() {
        let mut s = Session::new(FinishOnly(FakeEngine::new(&["hello", "there"])), Emitter::new(Vec::new()));
        s.listen(|| 0.0).unwrap();
        let mut t = 0.0;
        for chunk in [&LOUD; 3].into_iter().chain([&QUIET; 22]) {
            s.audio(chunk, t);
            s.tick(t, &mut NoKeys);
            t += 0.1;
        }
        let out = String::from_utf8_lossy(s.output()).to_string();
        let ev = plain(s.output());
        assert!(!ev.iter().any(|e| e["type"] == "partial"));
        assert!(ev.contains(&json!({"type":"final","text":"hello there"})), "{out}");
        assert_eq!(ev.last().unwrap(), &json!({"type":"state","state":"idle"}));
    }

    /// Like Parakeet: reads a take once its peak level reaches 0.15, below the default voice level.
    struct QuietReader {
        peak: f64,
    }

    impl SpeechEngine for QuietReader {
        fn name(&self) -> &str {
            "quiet-reader"
        }
        fn start(&mut self) -> Result<(), EngineError> {
            self.peak = 0.0;
            Ok(())
        }
        fn accept(&mut self, samples: &[f32]) {
            self.peak = self.peak.max(level(samples));
        }
        fn partial(&mut self) -> Option<String> {
            None
        }
        fn finish(&mut self) -> String {
            if self.peak >= 0.15 { "quiet words".into() } else { String::new() }
        }
        fn cancel(&mut self) {
            self.peak = 0.0;
        }
        fn streaming(&self) -> bool {
            false
        }
        fn voice_level(&self) -> f64 {
            0.15
        }
    }

    #[test]
    fn finish_only_quiet_speaker_ends_on_a_pause_instead_of_nothing_heard() {
        // About level 0.17: above the engine's speech level, below the default voice level.
        let soft = [0.0039f32; 1600];
        assert!((0.15..VOICE_LEVEL).contains(&level(&soft)));
        let mut s = Session::new(QuietReader { peak: 0.0 }, Emitter::new(Vec::new()));
        s.listen(|| 0.0).unwrap();
        let mut t = 0.0;
        for chunk in [&soft; 20].into_iter().chain([&QUIET; 70]) {
            s.audio(chunk, t);
            s.tick(t, &mut NoKeys);
            t += 0.1;
        }
        let out = String::from_utf8_lossy(s.output()).to_string();
        let ev = plain(s.output());
        assert!(ev.contains(&json!({"type":"final","text":"quiet words"})), "{out}");
        assert!(!ev.iter().any(|e| e["cancelled"] == true), "{out}");
    }

    const CA: [&str; 2] = ["control", "option"];

    /// Holds a fixed set of modifiers.
    struct Held(Mods);

    impl KeySource for Held {
        fn mods(&mut self) -> Mods {
            self.0
        }
        fn other_key_down(&mut self) -> bool {
            false
        }
    }

    fn ca() -> Held {
        Held(Mods::CONTROL.union(Mods::ALT))
    }

    /// Feeds 100 ms chunks and ticks with `keys`, from `t`; returns the new time.
    fn drive(s: &mut Session<FakeEngine, Vec<u8>>, keys: &mut Held, chunk: &[f32], n: usize, mut t: f64) -> f64 {
        for _ in 0..n {
            s.audio(chunk, t);
            s.tick(t, keys);
            t += 0.1;
        }
        t
    }

    #[test]
    fn arming_opens_the_mic_without_showing_anything() {
        let mut s = session(FakeEngine::new(&["hello"]));
        s.tick(0.0, &mut ca());
        assert!(s.wants_audio());
        s.audio(&LOUD, 0.05);
        assert!(events(&s).is_empty(), "armed may still be a shortcut");
    }

    #[test]
    fn hold_session_event_order() {
        let mut s = session(FakeEngine::new(&["hello"]));
        let t = drive(&mut s, &mut ca(), &LOUD, 4, 0.0);
        drive(&mut s, &mut Held(Mods::NONE), &QUIET, 6, t);
        assert_eq!(kinds(&s), ["listening", "partial", "level", "processing", "final", "idle"]);
        let ev = events(&s);
        assert_eq!(ev[0], json!({"type":"state","state":"listening","mode":"hold"}));
        assert_eq!(ev[1], json!({"type":"partial","text":"hello"}), "words heard while armed show up");
        assert!(ev.contains(&json!({"type":"final","text":"hello"})));
        assert!(s.is_idle() && !s.wants_audio(), "the mic closes when the session ends");
    }

    #[test]
    fn mic_failure_while_armed_is_silent_until_it_is_a_talk() {
        let mut s = session(FakeEngine::new(&[]));
        s.tick(0.0, &mut ca());
        s.audio_failed();
        assert!(events(&s).is_empty());
        assert!(!s.wants_audio(), "no retry spin while armed");
        s.tick(0.3, &mut ca());
        assert!(s.wants_audio(), "retried once it's a talk");
        s.audio_failed();
        assert_eq!(kinds(&s), ["listening", "error:no_input", "idle"]);
    }

    #[test]
    fn mic_failure_while_finishing_still_delivers_without_error() {
        let mut s = session(FakeEngine::new(&["hello"]));
        let t = drive(&mut s, &mut ca(), &LOUD, 4, 0.0);
        let mut t = t;
        while !matches!(s.machine.phase(), Phase::Finishing { .. }) {
            assert!(t < 1.0, "the release should start the tail");
            s.tick(t, &mut Held(Mods::NONE));
            t += 0.01;
        }
        s.audio_failed();
        s.audio_failed();
        assert!(!kinds(&s).iter().any(|k| k == "error:no_input"));
        assert!(!s.wants_audio(), "no retry spin during the tail");
        s.tick(t + 0.31, &mut Held(Mods::NONE));
        assert_eq!(kinds(&s), ["listening", "partial", "processing", "final", "idle"]);
        assert!(events(&s).contains(&json!({"type":"final","text":"hello"})));
    }

    #[test]
    fn unavailable_engine_reports_when_the_chord_becomes_a_talk() {
        let mut fake = FakeEngine::new(&[]);
        fake.available = false;
        let mut s = session(fake);
        s.tick(0.0, &mut ca());
        assert!(events(&s).is_empty());
        s.tick(0.3, &mut ca());
        assert_eq!(kinds(&s), ["error:unavailable", "idle"]);
        assert!(!s.wants_audio());
        s.tick(0.6, &mut ca());
        assert_eq!(events(&s).len(), 2, "a still-held chord doesn't retry");
    }

    #[test]
    fn set_chord_switches_keys_and_ignores_bad_names() {
        let mut s = session(FakeEngine::new(&[]));
        s.set_chord(&["ctrl".to_string()]);
        s.set_chord(&["win".to_string(), "shift".to_string()]);
        s.tick(0.0, &mut ca());
        assert!(!s.wants_audio(), "ctrl+alt no longer arms");
        s.tick(0.1, &mut Held(Mods::NONE));
        s.tick(0.2, &mut Held(Mods::WIN.union(Mods::SHIFT)));
        assert!(s.wants_audio());
        s.set_chord(&CA.map(String::from));
        assert_eq!(events(&s).last().unwrap(), &json!({"type":"state","state":"idle","cancelled":true}));
    }

    const RID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn chord_talk_binds_the_pending_id_and_back_dates_the_session() {
        let mut s = session(FakeEngine::new(&["hello"]));
        s.set_request_id(RID);
        let t = drive(&mut s, &mut ca(), &LOUD, 4, 0.0);
        drive(&mut s, &mut Held(Mods::NONE), &QUIET, 6, t);
        assert_eq!(
            tele_kinds(&s),
            [
                "start:voice.session",
                "start:voice.listen",
                "end:voice.listen",
                "start:voice.finalize",
                "end:voice.finalize",
                "end:voice.session"
            ]
        );
        let ev = tele(&s);
        assert!(ev.iter().all(|e| e["request_id"] == RID && e["component"] == "voice"));
        assert_eq!(all_lines(s.output())[0]["type"], "telemetry", "session start precedes `listening` so the host can take its id");
        let end = ev.last().unwrap();
        assert_eq!(end["step_id"], ev[0]["step_id"]);
        assert_eq!(end["outcome"], "ok");
        assert_eq!(end["attrs"]["chars"], 5);
        assert!(end["attrs"]["audio_ms"].as_u64().unwrap() >= 400);
        assert!(end["duration_ms"].as_f64().unwrap() >= 250.0, "back-dated to the chord going down");
        assert_eq!(ev[0]["attrs"]["mode"], "hold");
        assert_eq!(ev[0]["attrs"]["engine"], "fake");
        assert_eq!(ev[1]["parent_step_id"], ev[0]["step_id"]);
        // The pending id is used up; the next talk mints its own.
        drive(&mut s, &mut ca(), &LOUD, 4, 5.0);
        let rid2 = tele(&s).iter().rev().find(|e| e["step"] == "voice.session").unwrap()["request_id"].clone();
        assert_ne!(rid2, RID);
        assert_eq!(rid2.as_str().unwrap().len(), 32);
    }

    #[test]
    fn shortcut_press_emits_no_telemetry_and_keeps_the_id() {
        let mut s = session(FakeEngine::new(&["hello"]));
        s.set_request_id(RID);
        struct ChordPlusKey;
        impl KeySource for ChordPlusKey {
            fn mods(&mut self) -> Mods {
                Mods::CONTROL.union(Mods::ALT)
            }
            fn other_key_down(&mut self) -> bool {
                true
            }
        }
        s.tick(0.0, &mut ca());
        s.audio(&LOUD, 0.02);
        s.tick(0.03, &mut ChordPlusKey);
        s.tick(0.5, &mut ChordPlusKey);
        s.tick(1.0, &mut Held(Mods::NONE));
        assert!(!s.wants_audio());
        assert!(tele(&s).is_empty(), "{:?}", tele_kinds(&s));
        assert_eq!(s.pending_rid.as_deref(), Some(RID));
    }

    #[test]
    fn listen_command_uses_its_own_id_and_reports_nothing_heard() {
        let mut s = session(FakeEngine::new(&[]));
        s.set_request_id("ffffffffffffffffffffffffffffffff");
        s.listen_with(Some(RID.into()), || 0.0).unwrap();
        let t = feed(&mut s, &QUIET, 3, 0.0);
        s.finish(t);
        s.tick(t + 0.31, &mut NoKeys);
        let ev = tele(&s);
        assert!(ev.iter().all(|e| e["request_id"] == RID));
        let end = ev.last().unwrap();
        assert_eq!((end["step"].as_str(), end["outcome"].as_str()), (Some("voice.session"), Some("error")));
        assert_eq!(end["error_code"], "nothing_heard");
        assert_eq!(s.pending_rid.as_deref(), Some("ffffffffffffffffffffffffffffffff"), "the chord id is kept");
    }

    #[test]
    fn failures_and_cancels_end_the_session_with_codes() {
        let mut s = session(FakeEngine::new(&[]));
        s.listen(|| 0.0).unwrap();
        s.mic_denied();
        let end = tele(&s).last().unwrap().clone();
        assert_eq!((end["outcome"].as_str(), end["error_code"].as_str()), (Some("error"), Some("permission")));

        let mut s = session(FakeEngine::new(&["hi"]));
        s.listen(|| 0.0).unwrap();
        s.cancel();
        let end = tele(&s).last().unwrap().clone();
        assert_eq!((end["step"].as_str(), end["outcome"].as_str()), (Some("voice.session"), Some("cancelled")));
        assert!(end["error_code"].is_null());

        let mut fake = FakeEngine::new(&[]);
        fake.available = false;
        let mut s = session(fake);
        let _ = s.listen(|| 0.0);
        assert_eq!(tele_kinds(&s), ["start:voice.session", "end:voice.session"]);
        assert_eq!(tele(&s)[1]["error_code"], "unavailable");
    }

    #[test]
    fn telemetry_off_emits_nothing() {
        let mut s = session(FakeEngine::new(&["hello"]));
        s.set_telemetry(false);
        s.listen(|| 0.0).unwrap();
        let t = feed(&mut s, &LOUD, 2, 0.0);
        s.finish(t);
        s.tick(t + 0.31, &mut NoKeys);
        assert!(tele(&s).is_empty());
        assert!(events(&s).contains(&json!({"type":"final","text":"hello"})));
    }
}
