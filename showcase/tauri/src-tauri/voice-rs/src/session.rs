//! The hands-free session state machine, ported from voice/main.swift. Time is passed in so tests
//! and `--wav` runs are deterministic.

use crate::audio;
use crate::engine::{EngineError, SpeechEngine};
use crate::protocol::{Emitter, ErrorCode, Event, Mode, SessionState};
use std::io::Write;

const PAUSE_ENDS: f64 = 1.5;
const NOTHING_HEARD_CANCEL: f64 = 8.0;
const MAX_SESSION: f64 = 60.0;
/// Keep listening a moment after the end so a word said while stopping isn't clipped.
const TAIL: f64 = 0.3;
const LEVEL_EVERY: f64 = 0.05;
const VOICE_LEVEL: f64 = 0.2;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Listening,
    Finishing { until: f64 },
}

pub struct Session<E: SpeechEngine, W: Write> {
    engine: E,
    out: Emitter<W>,
    phase: Phase,
    best: String,
    listen_at: f64,
    heard_at: f64,
    voice_at: f64,
    level_at: f64,
}

impl<E: SpeechEngine, W: Write> Session<E, W> {
    pub fn new(engine: E, out: Emitter<W>) -> Self {
        Session {
            engine,
            out,
            phase: Phase::Idle,
            best: String::new(),
            listen_at: 0.0,
            heard_at: 0.0,
            voice_at: 0.0,
            level_at: f64::NEG_INFINITY,
        }
    }

    pub fn emit(&mut self, event: &Event) {
        if let Err(e) = self.out.emit(event) {
            log(&format!("stdout: {e}"));
        }
    }

    pub fn engine_name(&self) -> String {
        self.engine.name().to_string()
    }

    /// True while the mic should be open (listening or in the end tail).
    pub fn wants_audio(&self) -> bool {
        self.phase != Phase::Idle
    }

    #[cfg(test)]
    pub fn is_idle(&self) -> bool {
        self.phase == Phase::Idle
    }

    /// Starts a hands-free session (the `listen` command). Ignored unless idle.
    /// `now` is read after the engine starts: the first start loads the model, which can take seconds.
    pub fn listen(&mut self, now: impl FnOnce() -> f64) -> Result<(), EngineError> {
        if self.phase != Phase::Idle {
            return Ok(());
        }
        if let Err(e) = self.engine.start() {
            log(&e.to_string());
            self.emit(&Event::error(ErrorCode::Unavailable));
            self.emit(&Event::State { state: SessionState::Idle, mode: None, cancelled: Some(true) });
            return Err(e);
        }
        let now = now();
        self.phase = Phase::Listening;
        self.best.clear();
        self.listen_at = now;
        self.heard_at = now;
        self.voice_at = now;
        self.level_at = f64::NEG_INFINITY;
        self.emit(&Event::State { state: SessionState::Listening, mode: Some(Mode::Handsfree), cancelled: None });
        Ok(())
    }

    /// 16 kHz mono audio from the mic or a WAV.
    pub fn audio(&mut self, samples: &[f32], now: f64) {
        if self.phase == Phase::Idle || samples.is_empty() {
            return;
        }
        let v = audio::level(samples);
        if v > VOICE_LEVEL {
            self.voice_at = now;
        }
        if self.phase == Phase::Listening && now - self.level_at >= LEVEL_EVERY {
            self.level_at = now;
            self.emit(&Event::level(v));
        }
        self.engine.accept(samples);
        if let Some(text) = self.engine.partial() {
            let text = text.trim().to_string();
            if text != self.best && !text.is_empty() {
                self.best = text.clone();
                self.heard_at = now;
                self.emit(&Event::Partial { text });
            }
        }
    }

    /// The mic couldn't open or died: same as the Mac helper's `no_input`.
    pub fn audio_failed(&mut self) {
        if self.phase == Phase::Idle {
            return;
        }
        self.emit(&Event::error(ErrorCode::NoInput));
        self.cancel();
    }

    pub fn tick(&mut self, now: f64) {
        match self.phase {
            Phase::Idle => {}
            Phase::Listening => {
                let quiet = now - self.heard_at.max(self.voice_at);
                if !self.best.is_empty() && quiet > PAUSE_ENDS {
                    self.end("pause", now);
                    self.finish(now);
                } else if self.best.is_empty() && now - self.listen_at > NOTHING_HEARD_CANCEL {
                    self.end("nothing heard", now);
                    self.cancel();
                } else if now - self.listen_at > MAX_SESSION {
                    self.end("max length", now);
                    self.finish(now);
                }
            }
            Phase::Finishing { until } => {
                if now >= until {
                    self.finalize();
                }
            }
        }
    }

    /// Stops taking new speech: `processing`, then the result after the tail.
    pub fn finish(&mut self, now: f64) {
        if self.phase != Phase::Listening {
            return;
        }
        self.phase = Phase::Finishing { until: now + TAIL };
        self.emit(&Event::state(SessionState::Processing));
    }

    fn finalize(&mut self) {
        let heard = self.engine.finish();
        self.phase = Phase::Idle;
        let heard = heard.trim();
        let text = if heard.is_empty() { self.best.trim().to_string() } else { heard.to_string() };
        if !text.is_empty() {
            self.emit(&Event::Final { text: text.clone() });
        }
        self.emit(&Event::state(SessionState::Idle));
        if text.is_empty() {
            let spoke = self.voice_at > self.listen_at + 0.05;
            self.emit(&Event::Error { code: ErrorCode::NothingHeard, spoke: Some(spoke), message: None });
        }
    }

    /// The `cancel` command; a session already finishing still delivers its text, like the Mac helper.
    pub fn cancel(&mut self) {
        if self.phase != Phase::Listening {
            return;
        }
        self.engine.cancel();
        self.phase = Phase::Idle;
        self.emit(&Event::State { state: SessionState::Idle, mode: None, cancelled: Some(true) });
    }

    fn end(&self, why: &str, now: f64) {
        log(&format!("session end: {why} after {:.1}s", now - self.listen_at));
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
            if self.started && audio::level(samples) > VOICE_LEVEL {
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

    fn events(s: &Session<FakeEngine, Vec<u8>>) -> Vec<Value> {
        String::from_utf8_lossy(s.output()).lines().map(|l| serde_json::from_str(l).unwrap()).collect()
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
            s.tick(t);
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
        s.tick(t + 0.31);
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
        s.tick(t + 0.31);
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
        s.tick(t + 0.31);
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
        s.tick(12.1);
        assert!(s.wants_audio(), "the 8 s timer starts after loading, not before");
    }
}
