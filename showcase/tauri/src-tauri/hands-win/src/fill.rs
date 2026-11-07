// The order fill tries to put text in a field, apart from the Windows calls so it builds and tests anywhere.
// Native fields: set the value, else type it, else paste it. Web page fields: type first (or the page never
// hears about it), then set the value, then paste. Each way is read back before the next is tried. Paste is
// the last resort: never for passwords (no read-back, and a password must never touch the clipboard) and
// never to clear a field. When nothing worked, what the field showed before is put back where possible.
use crate::forms::reads_back;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Native,
    Web,
    Password,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum How {
    Set,
    Typed,
    Pasted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Filled {
    /// It reads back (passwords: typed, nothing to read back).
    Shown(String, How),
    /// Nothing worked; `put_back` says whether the field shows its old text again, `pasted` whether a
    /// paste was actually sent (not when clearing, clipboard busy, focus lost or not a last resort).
    Failed { shows: String, put_back: bool, pasted: bool },
    /// The cursor wasn't in the field, so nothing was typed.
    NotHere,
}

/// The ways to write a field. `type_keys` and `paste` return Ok(false) when the field doesn't have focus,
/// so nothing was sent; errors (keys held, input blocked) stop the step.
pub trait Ways {
    type Err;
    fn set_value(&mut self, text: &str) -> bool;
    fn type_keys(&mut self, text: &str) -> Result<bool, Self::Err>;
    fn paste(&mut self, text: &str) -> Result<bool, Self::Err>;
    fn shows(&mut self) -> String;
    fn put_back(&mut self, old: &str) -> bool;
}

fn give_up<W: Ways>(w: &mut W, old: &str, pasted: bool) -> Filled {
    let now = w.shows();
    let put_back = now == old || (w.put_back(old) && w.shows() == old);
    Filled::Failed { shows: now, put_back, pasted }
}

pub fn fill<W: Ways>(w: &mut W, text: &str, kind: Kind) -> Result<Filled, W::Err> {
    if kind == Kind::Password {
        return Ok(if w.type_keys(text)? { Filled::Shown(String::new(), How::Typed) } else { Filled::NotHere });
    }
    let old = w.shows();
    let ok = |w: &mut W| {
        let now = w.shows();
        reads_back(&now, text).then_some(now)
    };
    let mut typed = false;
    if kind == Kind::Native && w.set_value(text) {
        if let Some(now) = ok(w) {
            return Ok(Filled::Shown(now, How::Set));
        }
    }
    if w.type_keys(text)? {
        typed = true;
        if let Some(now) = ok(w) {
            return Ok(Filled::Shown(now, How::Typed));
        }
    }
    if kind == Kind::Web && w.set_value(text) {
        if let Some(now) = ok(w) {
            return Ok(Filled::Shown(now, How::Set));
        }
    }
    if !typed && w.shows() == old {
        return Ok(Filled::NotHere);
    }
    let mut pasted = false;
    if !text.is_empty() {
        // A failed paste still puts the old text back before the error goes up.
        match w.paste(text) {
            Ok(true) => {
                pasted = true;
                if let Some(now) = ok(w) {
                    return Ok(Filled::Shown(now, How::Pasted));
                }
            }
            Ok(false) => {}
            Err(e) => {
                give_up(w, &old, true);
                return Err(e);
            }
        }
    }
    Ok(give_up(w, &old, pasted))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A field that takes text only through the ways in `works`; `log` records every call in order.
    struct Fake {
        shown: String,
        works: Vec<&'static str>,
        here: bool,
        paste_err: bool,
        paste_busy: bool,
        log: Vec<String>,
    }

    fn fake(shown: &str, works: &[&'static str]) -> Fake {
        Fake { shown: shown.into(), works: works.to_vec(), here: true, paste_err: false, paste_busy: false, log: vec![] }
    }

    impl Fake {
        fn calls(&self) -> Vec<&str> {
            self.log.iter().map(String::as_str).collect()
        }
        fn write(&mut self, way: &'static str, text: &str) {
            self.log.push(way.into());
            if self.works.contains(&way) {
                self.shown = text.into();
            }
        }
    }

    impl Ways for Fake {
        type Err = String;
        fn set_value(&mut self, text: &str) -> bool {
            self.write("set", text);
            self.works.contains(&"set")
        }
        fn type_keys(&mut self, text: &str) -> Result<bool, String> {
            if !self.here {
                return Ok(false);
            }
            self.write("type", text);
            Ok(true)
        }
        fn paste(&mut self, text: &str) -> Result<bool, String> {
            if self.paste_err {
                self.log.push("paste".into());
                return Err("keyboard: denied".into());
            }
            if self.paste_busy {
                self.log.push("paste".into());
                return Ok(false);
            }
            self.write("paste", text);
            Ok(true)
        }
        fn shows(&mut self) -> String {
            self.shown.clone()
        }
        fn put_back(&mut self, old: &str) -> bool {
            self.log.push("put_back".into());
            self.shown = old.into();
            true
        }
    }

    #[test]
    fn native_fields_set_then_type_then_paste() {
        let mut f = fake("old", &["paste"]);
        assert_eq!(fill(&mut f, "hello", Kind::Native), Ok(Filled::Shown("hello".into(), How::Pasted)));
        assert_eq!(f.calls(), ["set", "type", "paste"]);
    }

    #[test]
    fn web_fields_type_then_set_then_paste() {
        let mut f = fake("old", &["paste"]);
        assert_eq!(fill(&mut f, "hello", Kind::Web), Ok(Filled::Shown("hello".into(), How::Pasted)));
        assert_eq!(f.calls(), ["type", "set", "paste"]);
    }

    #[test]
    fn no_paste_after_a_good_read_back() {
        let mut f = fake("", &["set"]);
        assert_eq!(fill(&mut f, "hi", Kind::Native), Ok(Filled::Shown("hi".into(), How::Set)));
        assert_eq!(f.calls(), ["set"]);
        let mut f = fake("", &["type"]);
        assert_eq!(fill(&mut f, "hi", Kind::Native), Ok(Filled::Shown("hi".into(), How::Typed)));
        assert_eq!(f.calls(), ["set", "type"]);
        let mut f = fake("", &["type"]);
        assert_eq!(fill(&mut f, "hi", Kind::Web), Ok(Filled::Shown("hi".into(), How::Typed)));
        assert_eq!(f.calls(), ["type"]);
    }

    #[test]
    fn passwords_are_only_typed() {
        let mut f = fake("", &[]);
        assert_eq!(fill(&mut f, "secret", Kind::Password), Ok(Filled::Shown(String::new(), How::Typed)));
        assert_eq!(f.calls(), ["type"]);
        f.here = false;
        assert_eq!(fill(&mut f, "secret", Kind::Password), Ok(Filled::NotHere));
    }

    #[test]
    fn clearing_never_pastes() {
        let mut f = fake("old", &[]);
        assert_eq!(fill(&mut f, "", Kind::Native), Ok(Filled::Failed { shows: "old".into(), put_back: true, pasted: false }));
        assert!(!f.calls().contains(&"paste"));
    }

    #[test]
    fn a_failed_paste_puts_the_old_text_back() {
        // The field takes every write as junk: it shows something else than what was asked.
        struct Junk(Fake);
        impl Ways for Junk {
            type Err = String;
            fn set_value(&mut self, _: &str) -> bool {
                self.0.write("set", "junk");
                false
            }
            fn type_keys(&mut self, _: &str) -> Result<bool, String> {
                self.0.write("type", "junk");
                Ok(true)
            }
            fn paste(&mut self, _: &str) -> Result<bool, String> {
                self.0.write("paste", "junk");
                Ok(true)
            }
            fn shows(&mut self) -> String {
                self.0.shows()
            }
            fn put_back(&mut self, old: &str) -> bool {
                self.0.put_back(old)
            }
        }
        let mut f = Junk(fake("old", &["type", "paste"]));
        assert_eq!(fill(&mut f, "hello", Kind::Native), Ok(Filled::Failed { shows: "junk".into(), put_back: true, pasted: true }));
        assert_eq!(f.0.calls(), ["set", "type", "paste", "put_back"]);
        assert_eq!(f.0.shown, "old");
    }

    #[test]
    fn a_paste_error_still_puts_back() {
        struct Typo(Fake);
        impl Ways for Typo {
            type Err = String;
            fn set_value(&mut self, t: &str) -> bool {
                self.0.set_value(t)
            }
            fn type_keys(&mut self, _: &str) -> Result<bool, String> {
                self.0.write("type", "hel");
                Ok(true)
            }
            fn paste(&mut self, t: &str) -> Result<bool, String> {
                self.0.paste(t)
            }
            fn shows(&mut self) -> String {
                self.0.shows()
            }
            fn put_back(&mut self, old: &str) -> bool {
                self.0.put_back(old)
            }
        }
        let mut f = Typo(fake("old", &["type"]));
        f.0.paste_err = true;
        assert_eq!(fill(&mut f, "hello", Kind::Native), Err("keyboard: denied".into()));
        assert_eq!(f.0.calls(), ["set", "type", "paste", "put_back"]);
        assert_eq!(f.0.shown, "old");
    }

    #[test]
    fn nothing_sent_when_the_cursor_is_elsewhere() {
        let mut f = fake("old", &[]);
        f.here = false;
        assert_eq!(fill(&mut f, "hello", Kind::Native), Ok(Filled::NotHere));
        assert_eq!(f.calls(), ["set"]);
    }

    #[test]
    fn a_skipped_paste_is_not_reported_as_pasted() {
        let mut f = fake("old", &[]);
        f.paste_busy = true;
        assert_eq!(fill(&mut f, "hello", Kind::Native), Ok(Filled::Failed { shows: "old".into(), put_back: true, pasted: false }));
        assert_eq!(f.calls(), ["set", "type", "paste"]);
    }

}
