//! The talk chord: hold, tap and shortcut decisions, ported from voice/main.swift `tick()`.
//! Pure: time and key state come in, actions go out, so it runs the same in tests and on any OS.

use crate::protocol::Mode;

const TAP_LIMIT: f64 = 0.25;
/// A release must last this long to count, so one glitchy frame of key state can't end a session.
const RELEASE_DEBOUNCE: f64 = 0.09;
const PAUSE_ENDS: f64 = 1.5;
const NOTHING_HEARD_CANCEL: f64 = 8.0;
const MAX_SESSION: f64 = 60.0;
/// Keep listening a moment after the end so a word said while stopping isn't clipped.
const TAIL: f64 = 0.3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods(u8);

impl Mods {
    pub const NONE: Mods = Mods(0);
    pub const CONTROL: Mods = Mods(1);
    pub const ALT: Mods = Mods(2);
    pub const WIN: Mods = Mods(4);
    pub const SHIFT: Mods = Mods(8);

    pub fn union(self, o: Mods) -> Mods {
        Mods(self.0 | o.0)
    }
    fn and(self, o: Mods) -> Mods {
        Mods(self.0 & o.0)
    }
    fn minus(self, o: Mods) -> Mods {
        Mods(self.0 & !o.0)
    }
    fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Exactly two distinct modifiers; Mac names map to Windows keys (option→alt, command→win).
    pub fn parse(names: &[String]) -> Option<Mods> {
        if names.len() != 2 {
            return None;
        }
        let mut m = Mods::NONE;
        for n in names {
            m = m.union(match n.trim().to_lowercase().as_str() {
                "control" | "ctrl" => Mods::CONTROL,
                "alt" | "option" => Mods::ALT,
                "win" | "command" | "cmd" => Mods::WIN,
                "shift" => Mods::SHIFT,
                _ => return None,
            });
        }
        (m.0.count_ones() == 2).then_some(m)
    }
}

/// Where key state comes from: Windows polling, or nothing (`--wav`, tests, other OSes).
pub trait KeySource {
    fn mods(&mut self) -> Mods;
    /// Any non-modifier key down. Only asked while armed with the chord down.
    fn other_key_down(&mut self) -> bool;
}

pub struct NoKeys;

impl KeySource for NoKeys {
    fn mods(&mut self) -> Mods {
        Mods::NONE
    }
    fn other_key_down(&mut self) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    Idle,
    Armed,
    Holding,
    HandsFree,
    Finishing { until: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// The chord went down: get the engine and mic ready, show nothing yet.
    Arm,
    /// It's a talk: show listening.
    Listen(Mode),
    /// Stop taking speech; `shown` when listening was on screen.
    Finish { shown: bool },
    /// The tail is over: deliver the text.
    Finalize,
    Cancel,
}

pub struct SessionMachine {
    chord: Mods,
    phase: Phase,
    chord_at: f64,
    listen_at: f64,
    heard_at: f64,
    voice_at: f64,
    released_at: Option<f64>,
    blocked: bool,
    prev_chord: bool,
    has_text: bool,
    endpointed: bool,
    finish_only: bool,
}

impl Default for SessionMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionMachine {
    pub fn new() -> Self {
        SessionMachine {
            chord: Mods::CONTROL.union(Mods::ALT),
            phase: Phase::Idle,
            chord_at: 0.0,
            listen_at: 0.0,
            heard_at: 0.0,
            voice_at: 0.0,
            released_at: None,
            blocked: false,
            prev_chord: false,
            has_text: false,
            endpointed: false,
            finish_only: false,
        }
    }

    /// For engines with no live text: hands-free ends 1.5 s after the voice stops, and is
    /// cancelled when no voice came at all.
    pub fn set_finish_only(&mut self, on: bool) {
        self.finish_only = on;
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Voice was loud after listening began (for `nothing_heard`'s `spoke`).
    pub fn spoke(&self) -> bool {
        self.voice_at > self.listen_at + 0.05
    }

    pub fn tick(&mut self, now: f64, keys: &mut dyn KeySource) -> Vec<Action> {
        let mut out = Vec::new();
        let f = keys.mods();
        let held = f.and(self.chord);
        // Once talking, a stray extra modifier doesn't count as letting go.
        let down = held == self.chord;
        let extra = !f.minus(self.chord).is_empty();
        let chord = down && !extra;
        if held.is_empty() {
            self.blocked = false;
        }
        let released = if down {
            self.released_at = None;
            false
        } else {
            let at = *self.released_at.get_or_insert(now);
            now - at >= RELEASE_DEBOUNCE
        };
        let fresh = chord && !self.prev_chord && !self.blocked;
        self.prev_chord = chord;

        match self.phase {
            Phase::Idle => {
                if fresh {
                    self.arm(now, &mut out);
                }
            }
            Phase::Armed => {
                // Only the first moment decides shortcut vs. talk: the chord plus a key, Shift or Win is a shortcut.
                if down && (extra || keys.other_key_down()) {
                    log("not a talk: the chord was part of a shortcut");
                    self.cancel(&mut out);
                    self.blocked = true;
                } else if released {
                    self.phase = Phase::HandsFree;
                    self.show(Mode::Handsfree, now, &mut out);
                } else if down && now - self.chord_at >= TAP_LIMIT {
                    self.phase = Phase::Holding;
                    self.show(Mode::Hold, now, &mut out);
                }
            }
            Phase::Holding => {
                if released {
                    self.end("released", now);
                    self.finish(now, &mut out);
                } else if now - self.listen_at > MAX_SESSION {
                    self.end("max length", now);
                    self.finish(now, &mut out);
                }
            }
            Phase::HandsFree => {
                // Pressing again switches to push-to-talk; letting go then sends.
                if fresh {
                    self.phase = Phase::Holding;
                    self.released_at = None;
                } else {
                    // After an engine endpoint, background noise no longer holds the session open.
                    let last = if self.endpointed { self.heard_at } else { self.heard_at.max(self.voice_at) };
                    let has_text = if self.finish_only { self.spoke() } else { self.has_text };
                    if has_text && now - last > PAUSE_ENDS {
                        self.end("pause", now);
                        self.finish(now, &mut out);
                    } else if !has_text && now - self.listen_at > NOTHING_HEARD_CANCEL {
                        self.end("nothing heard", now);
                        self.cancel(&mut out);
                    } else if now - self.listen_at > MAX_SESSION {
                        self.end("max length", now);
                        self.finish(now, &mut out);
                    }
                }
            }
            Phase::Finishing { until } => {
                if now >= until {
                    self.phase = Phase::Idle;
                    out.push(Action::Finalize);
                }
            }
        }
        out
    }

    /// The engine's text changed.
    pub fn on_text(&mut self, now: f64, nonempty: bool) {
        self.has_text = nonempty;
        if nonempty {
            self.heard_at = now;
            self.endpointed = false;
        }
    }

    pub fn on_voice(&mut self, now: f64) {
        self.voice_at = now;
    }

    pub fn on_endpoint(&mut self) {
        self.endpointed = true;
    }

    /// The `listen` command: hands-free without a key press. The snap shortcut's keys may still
    /// be held, so they're blocked rather than read as a tap.
    pub fn listen_now(&mut self, now: f64) -> Vec<Action> {
        let mut out = Vec::new();
        if self.phase != Phase::Idle {
            return out;
        }
        self.arm(now, &mut out);
        self.phase = Phase::HandsFree;
        self.blocked = true;
        self.show(Mode::Handsfree, now, &mut out);
        out
    }

    /// The host's `cancel` (it saw a shortcut fire); a session already finishing still delivers.
    pub fn external_cancel(&mut self) -> Vec<Action> {
        let mut out = Vec::new();
        if self.is_active() {
            self.cancel(&mut out);
        }
        self.blocked = true;
        out
    }

    pub fn set_chord(&mut self, chord: Mods) -> Vec<Action> {
        let mut out = Vec::new();
        if self.is_active() {
            self.cancel(&mut out);
        }
        self.chord = chord;
        self.blocked = true;
        out
    }

    /// Ends now (the `--wav` run's end of file).
    pub fn finish_now(&mut self, now: f64) -> Vec<Action> {
        let mut out = Vec::new();
        self.finish(now, &mut out);
        out
    }

    fn is_active(&self) -> bool {
        matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree)
    }

    fn arm(&mut self, now: f64, out: &mut Vec<Action>) {
        self.phase = Phase::Armed;
        self.chord_at = now;
        self.has_text = false;
        self.endpointed = false;
        out.push(Action::Arm);
    }

    fn show(&mut self, mode: Mode, now: f64, out: &mut Vec<Action>) {
        self.listen_at = now;
        self.heard_at = now;
        self.voice_at = now;
        out.push(Action::Listen(mode));
    }

    fn finish(&mut self, now: f64, out: &mut Vec<Action>) {
        if !self.is_active() {
            return;
        }
        let shown = self.phase != Phase::Armed;
        self.phase = Phase::Finishing { until: now + TAIL };
        out.push(Action::Finish { shown });
    }

    fn cancel(&mut self, out: &mut Vec<Action>) {
        self.phase = Phase::Idle;
        out.push(Action::Cancel);
    }

    fn end(&self, why: &str, now: f64) {
        log(&format!("session end: {why} after {:.1}s", now - self.listen_at));
    }
}

fn log(s: &str) {
    eprintln!("[voice] {s}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use Action::*;

    const CA: Mods = Mods(Mods::CONTROL.0 | Mods::ALT.0);
    const SHOWN: Action = Finish { shown: true };

    struct Keys {
        mods: Mods,
        other: bool,
    }

    impl KeySource for Keys {
        fn mods(&mut self) -> Mods {
            self.mods
        }
        fn other_key_down(&mut self) -> bool {
            self.other
        }
    }

    /// Drives the machine at 10 ms steps, logging each action with its time in ms.
    struct Run {
        m: SessionMachine,
        ms: u64,
        log: Vec<(u64, Action)>,
    }

    impl Run {
        fn new() -> Self {
            Run { m: SessionMachine::new(), ms: 0, log: Vec::new() }
        }
        fn now(&self) -> f64 {
            self.ms as f64 / 1000.0
        }
        fn keys(&mut self, mods: Mods, other: bool, dur: u64) -> &mut Self {
            let mut k = Keys { mods, other };
            let end = self.ms + dur;
            while self.ms < end {
                let now = self.now();
                for a in self.m.tick(now, &mut k) {
                    self.log.push((self.ms, a));
                }
                self.ms += 10;
            }
            self
        }
        fn up(&mut self, dur: u64) -> &mut Self {
            self.keys(Mods::NONE, false, dur)
        }
        fn hold(&mut self, dur: u64) -> &mut Self {
            self.keys(CA, false, dur)
        }
        fn text(&mut self) -> &mut Self {
            let now = self.now();
            self.m.on_text(now, true);
            self
        }
        fn actions(&self) -> Vec<Action> {
            self.log.iter().map(|(_, a)| *a).collect()
        }
        /// When `a` was emitted, checked to within one 10 ms step (float rounding).
        fn assert_at(&self, a: Action, ms: u64) {
            let t = self.log.iter().find(|(_, x)| *x == a).map(|(t, _)| *t).expect("action not emitted");
            assert!(t.abs_diff(ms) <= 10, "{a:?} at {t} ms, wanted {ms}");
        }
    }

    #[test]
    fn hold_listens_then_sends_on_release() {
        let mut r = Run::new();
        r.hold(1000).up(500);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Hold), SHOWN, Finalize]);
        r.assert_at(Arm, 0);
        r.assert_at(Listen(Mode::Hold), 250);
        r.assert_at(SHOWN, 1090);
        r.assert_at(Finalize, 1390);
        assert_eq!(r.m.phase(), Phase::Idle);
    }

    #[test]
    fn a_fresh_press_is_needed_to_arm() {
        let mut r = Run::new();
        r.up(50).hold(100);
        r.assert_at(Arm, 50);
    }

    #[test]
    fn tap_goes_hands_free() {
        let mut r = Run::new();
        r.hold(100).up(200);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree)]);
        assert_eq!(r.m.phase(), Phase::HandsFree);
    }

    #[test]
    fn tap_then_hold_switches_to_push_to_talk() {
        let mut r = Run::new();
        r.hold(100).up(300).hold(2000);
        assert_eq!(r.m.phase(), Phase::Holding);
        r.up(200);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree), SHOWN]);
    }

    #[test]
    fn chord_plus_a_key_is_a_shortcut() {
        let mut r = Run::new();
        r.hold(30).keys(CA, true, 500);
        assert_eq!(r.actions(), [Arm, Cancel]);
        // Blocked while any chord key stays down, even after the other key is let go.
        r.hold(300).keys(Mods::ALT, false, 100).hold(300);
        assert_eq!(r.actions(), [Arm, Cancel]);
        r.up(50).hold(300);
        assert_eq!(r.actions(), [Arm, Cancel, Arm, Listen(Mode::Hold)]);
    }

    #[test]
    fn extra_shift_or_win_is_a_shortcut() {
        for extra in [Mods::SHIFT, Mods::WIN] {
            let mut r = Run::new();
            r.hold(30).keys(CA.union(extra), false, 500).up(200);
            assert_eq!(r.actions(), [Arm, Cancel], "{extra:?}");
        }
        let mut r = Run::new();
        r.keys(CA.union(Mods::SHIFT), false, 500).up(100);
        assert!(r.actions().is_empty(), "all three together never arms");
    }

    #[test]
    fn other_keys_are_ignored_once_talking() {
        let mut r = Run::new();
        r.hold(400).keys(CA, true, 200).keys(CA.union(Mods::SHIFT), false, 200);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Hold)]);
    }

    #[test]
    fn a_glitchy_release_does_not_end_a_hold() {
        let mut r = Run::new();
        r.hold(500).up(80).hold(500).up(30).hold(500);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Hold)]);
        assert_eq!(r.m.phase(), Phase::Holding);
    }

    #[test]
    fn hands_free_ends_on_a_pause_after_words() {
        let mut r = Run::new();
        r.hold(100).up(500).text().up(1400);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree)], "1.5 s isn't over yet");
        r.up(200);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree), SHOWN]);
    }

    #[test]
    fn noise_holds_a_pause_open_until_the_engine_endpoints() {
        let mut r = Run::new();
        r.hold(100).up(500).text();
        for _ in 0..300 {
            let now = r.now();
            r.m.on_voice(now);
            r.up(10);
        }
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree)], "noise counts as talking");
        r.m.on_endpoint();
        r.up(10);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree), SHOWN]);
    }

    #[test]
    fn a_new_word_after_an_endpoint_counts_voice_again() {
        let mut r = Run::new();
        r.hold(100).up(500).text();
        r.m.on_endpoint();
        r.up(1000).text();
        let now = r.now();
        r.m.on_voice(now + 1.0);
        r.up(1600);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree)]);
    }

    #[test]
    fn eight_seconds_of_nothing_cancels() {
        let mut r = Run::new();
        r.hold(100).up(7900);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree)]);
        r.up(300);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree), Cancel]);
    }

    #[test]
    fn sixty_seconds_max_when_holding() {
        let mut r = Run::new();
        r.hold(60_000);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Hold)]);
        r.hold(300);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Hold), SHOWN]);
        // Still held after the end: no new session until the chord is pressed again.
        r.hold(2000);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Hold), SHOWN, Finalize]);
    }

    #[test]
    fn sixty_seconds_max_when_hands_free() {
        let mut r = Run::new();
        r.hold(100).up(100);
        for _ in 0..610 {
            r.text().up(100);
        }
        assert_eq!(r.actions()[..3], [Arm, Listen(Mode::Handsfree), SHOWN]);
    }

    #[test]
    fn external_cancel_blocks_a_still_held_chord() {
        let mut r = Run::new();
        r.hold(100);
        assert_eq!(r.m.external_cancel(), [Cancel]);
        r.hold(500).keys(Mods::CONTROL, false, 50).hold(500);
        assert_eq!(r.actions(), [Arm]);
        assert_eq!(r.m.phase(), Phase::Idle);
        assert!(r.m.external_cancel().is_empty(), "idle: nothing to cancel");
    }

    #[test]
    fn external_cancel_lets_a_finishing_session_deliver() {
        let mut r = Run::new();
        r.hold(500).up(150);
        assert!(r.m.external_cancel().is_empty());
        r.up(400);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Hold), SHOWN, Finalize]);
    }

    #[test]
    fn listen_now_is_hands_free_and_blocks_held_keys() {
        let mut r = Run::new();
        assert_eq!(r.m.listen_now(0.0), [Arm, Listen(Mode::Handsfree)]);
        assert!(r.m.listen_now(0.0).is_empty());
        r.hold(300).up(300);
        assert_eq!(r.m.phase(), Phase::HandsFree);
        assert!(r.actions().is_empty());
    }

    #[test]
    fn set_chord_cancels_an_active_session_and_uses_the_new_chord() {
        let mut r = Run::new();
        r.hold(400);
        let win_shift = Mods::WIN.union(Mods::SHIFT);
        assert_eq!(r.m.set_chord(win_shift), [Cancel]);
        r.up(50).hold(300).up(50).keys(win_shift, false, 300);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Hold), Arm, Listen(Mode::Hold)]);
        assert_eq!(r.m.set_chord(CA), [Cancel]);
        assert!(r.m.set_chord(CA).is_empty());
    }

    #[test]
    fn finish_now_from_hands_free() {
        let mut m = SessionMachine::new();
        m.listen_now(0.0);
        assert_eq!(m.finish_now(5.0), [SHOWN]);
        assert!(m.finish_now(5.0).is_empty());
        assert!(m.tick(5.2, &mut NoKeys).is_empty());
        assert_eq!(m.tick(5.31, &mut NoKeys), [Finalize]);
    }

    fn finish_only() -> Run {
        let mut r = Run::new();
        r.m.set_finish_only(true);
        r
    }

    fn voice(r: &mut Run, ms: u64) {
        for _ in 0..ms / 10 {
            let now = r.now();
            r.m.on_voice(now);
            r.up(10);
        }
    }

    #[test]
    fn finish_only_ends_on_a_pause_after_voice() {
        let mut r = finish_only();
        r.hold(100).up(500);
        voice(&mut r, 2000);
        r.up(1400);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree)], "1.5 s isn't over yet");
        r.up(200);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree), SHOWN]);
    }

    #[test]
    fn finish_only_cancels_when_no_voice_came() {
        let mut r = finish_only();
        r.hold(100).up(7900);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree)]);
        r.up(300);
        assert_eq!(r.actions(), [Arm, Listen(Mode::Handsfree), Cancel]);
    }

    #[test]
    fn finish_only_long_speech_is_not_cut_short() {
        let mut r = finish_only();
        r.hold(100).up(100);
        voice(&mut r, 20_000);
        assert_eq!(r.m.phase(), Phase::HandsFree, "no text never ends a talk that's still going");
    }

    #[test]
    fn parses_chords() {
        let p = |names: &[&str]| Mods::parse(&names.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(p(&["control", "option"]), Some(CA));
        assert_eq!(p(&["Ctrl", "ALT"]), Some(CA));
        assert_eq!(p(&["command", "shift"]), Some(Mods::WIN.union(Mods::SHIFT)));
        assert_eq!(p(&["cmd", "win"]), None, "both mean win");
        assert_eq!(p(&["ctrl"]), None);
        assert_eq!(p(&["ctrl", "alt", "shift"]), None);
        assert_eq!(p(&["ctrl", "ctrl"]), None);
        assert_eq!(p(&["ctrl", "hyper"]), None);
        assert_eq!(p(&[]), None);
    }
}
