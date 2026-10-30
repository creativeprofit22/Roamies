//! Runs the talk session: `chord::SessionMachine` decides, this executes its actions on the engine
//! and emits events. Time is passed in so tests and `--wav` runs are deterministic.

use crate::audio;
use crate::chord::{Action, KeySource, Mods, Phase, SessionMachine};
use crate::engine::{EngineError, SpeechEngine};
use crate::protocol::{Emitter, ErrorCode, Event, Mode, SessionState};
use std::io::Write;

const LEVEL_EVERY: f64 = 0.05;
const VOICE_LEVEL: f64 = 0.2;

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
}

impl<E: SpeechEngine, W: Write> Session<E, W> {
    pub fn new(engine: E, out: Emitter<W>) -> Self {
        Session {
            engine,
            out,
            machine: SessionMachine::new(),
            best: String::new(),
            level_at: f64::NEG_INFINITY,
            engine_ok: false,
            mic_down: false,
            shown: false,
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
        if self.machine.phase() != Phase::Idle {
            return Ok(());
        }
        self.best.clear();
        self.mic_down = false;
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
        let v = audio::level(samples);
        if v > VOICE_LEVEL {
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
        match self.machine.phase() {
            Phase::Idle => {}
            Phase::Armed => self.mic_down = true,
            _ => {
                self.emit(&Event::error(ErrorCode::NoInput));
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
                    if shown {
                        self.emit(&Event::state(SessionState::Processing));
                    }
                }
                Action::Finalize => self.finalize(),
                Action::Cancel => {
                    self.engine.cancel();
                    self.mic_down = false;
                    self.emit(&Event::State { state: SessionState::Idle, mode: None, cancelled: Some(true) });
                }
            }
        }
        Ok(())
    }

    fn show(&mut self, mode: Mode, _now: f64) -> Result<(), EngineError> {
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
    }

    fn finalize(&mut self) {
        let heard = self.engine.finish();
        let heard = heard.trim();
        let text = if heard.is_empty() { self.best.trim().to_string() } else { heard.to_string() };
        if !text.is_empty() {
            self.emit(&Event::Final { text: text.clone() });
        }
        self.emit(&Event::state(SessionState::Idle));
        if text.is_empty() && self.shown {
            let spoke = self.machine.spoke();
            self.emit(&Event::Error { code: ErrorCode::NothingHeard, spoke: Some(spoke), message: None });
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
}
