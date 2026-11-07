// Paste through the clipboard without losing what the user had copied. Follows Handy's clipboard.rs (MIT):
// save, write, paste chord, wait, always restore.
// Limit: only text or an image is saved and restored; copied files and rich-text formatting are not.
use std::{thread, time::Duration};

#[derive(Clone, Debug, PartialEq)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Saved {
    Text(String),
    Image(Image),
    Nothing,
}

pub trait Clip {
    fn save(&mut self) -> Saved;
    fn set_text(&mut self, text: &str) -> Result<(), String>;
    fn restore(&mut self, saved: &Saved) -> Result<(), String>;
}

pub trait Chord {
    fn paste(&mut self) -> Result<(), String>;
}

pub struct ClipboardPaste<C: Clip, K: Chord> {
    pub clip: C,
    pub chord: K,
    pub settle: Duration,
    pub wait: Duration,
}

impl<C: Clip, K: Chord> ClipboardPaste<C, K> {
    /// Pastes `text` and puts the saved clipboard back, even when the paste chord failed.
    pub fn insert(&mut self, text: &str) -> Result<(), String> {
        let saved = self.clip.save();
        self.clip.set_text(text)?;
        thread::sleep(self.settle);
        let pasted = self.chord.paste();
        // The target reads the clipboard after the chord; restoring too early pastes the old contents.
        thread::sleep(self.wait);
        let restored = self.clip.restore(&saved);
        pasted?;
        restored
    }
}

#[cfg(feature = "system")]
pub use system::SystemClip;

#[cfg(feature = "system")]
mod system {
    use super::{Clip, Image, Saved};

    /// The system clipboard. `private` keeps the pasted text out of Windows clipboard history, the cloud
    /// clipboard and clipboard monitors (it's form text, often personal); no effect on other systems.
    pub struct SystemClip {
        clip: arboard::Clipboard,
        #[cfg_attr(not(windows), allow(dead_code))]
        private: bool,
    }

    impl SystemClip {
        pub fn new() -> Result<Self, String> {
            Self::open(false)
        }

        pub fn new_private() -> Result<Self, String> {
            Self::open(true)
        }

        fn open(private: bool) -> Result<Self, String> {
            arboard::Clipboard::new().map(|clip| SystemClip { clip, private }).map_err(|e| format!("clipboard: {e}"))
        }
    }

    impl Clip for SystemClip {
        fn save(&mut self) -> Saved {
            if let Ok(t) = self.clip.get_text() {
                return Saved::Text(t);
            }
            match self.clip.get_image() {
                Ok(i) => Saved::Image(Image { width: i.width, height: i.height, bytes: i.bytes.into_owned() }),
                Err(_) => Saved::Nothing,
            }
        }
        fn set_text(&mut self, text: &str) -> Result<(), String> {
            #[cfg(windows)]
            if self.private {
                use arboard::SetExtWindows;
                // arboard: monitoring covers history and the cloud clipboard too.
                return self.clip.set().exclude_from_monitoring().text(text).map_err(|e| format!("clipboard: {e}"));
            }
            self.clip.set_text(text).map_err(|e| format!("clipboard: {e}"))
        }
        fn restore(&mut self, saved: &Saved) -> Result<(), String> {
            match saved {
                Saved::Text(t) => self.clip.set_text(t.as_str()),
                Saved::Image(i) => self.clip.set_image(arboard::ImageData { width: i.width, height: i.height, bytes: i.bytes.as_slice().into() }),
                Saved::Nothing => self.clip.clear(),
            }
            .map_err(|e| format!("clipboard: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct FakeClip(Arc<Mutex<(Saved, Vec<String>, bool)>>);
    impl FakeClip {
        fn with(s: Saved) -> Self {
            FakeClip(Arc::new(Mutex::new((s, vec![], false))))
        }
        fn failing_set(s: Saved) -> Self {
            FakeClip(Arc::new(Mutex::new((s, vec![], true))))
        }
        fn now(&self) -> Saved {
            self.0.lock().unwrap().0.clone()
        }
        fn last(&self) -> Option<String> {
            self.0.lock().unwrap().1.last().cloned()
        }
    }
    impl Clip for FakeClip {
        fn save(&mut self) -> Saved {
            self.now()
        }
        fn set_text(&mut self, text: &str) -> Result<(), String> {
            let mut g = self.0.lock().unwrap();
            if g.2 {
                return Err("clipboard: busy".into());
            }
            g.0 = Saved::Text(text.into());
            g.1.push(format!("set {text}"));
            Ok(())
        }
        fn restore(&mut self, saved: &Saved) -> Result<(), String> {
            let mut g = self.0.lock().unwrap();
            g.0 = saved.clone();
            g.1.push(if *saved == Saved::Nothing { "clear".into() } else { "restore".into() });
            Ok(())
        }
    }

    struct FakeChord {
        clip: FakeClip,
        fail: bool,
        seen: Arc<Mutex<Option<Saved>>>,
    }
    impl Chord for FakeChord {
        fn paste(&mut self) -> Result<(), String> {
            *self.seen.lock().unwrap() = Some(self.clip.now());
            if self.fail {
                Err("keyboard: denied".into())
            } else {
                Ok(())
            }
        }
    }

    fn run_with(clip: FakeClip, fail: bool) -> (Result<(), String>, FakeClip, Option<Saved>) {
        let seen = Arc::new(Mutex::new(None));
        let chord = FakeChord { clip: clip.clone(), fail, seen: seen.clone() };
        let mut sink = ClipboardPaste { clip: clip.clone(), chord, settle: Duration::ZERO, wait: Duration::ZERO };
        let r = sink.insert("hello world");
        let s = seen.lock().unwrap().clone();
        (r, clip, s)
    }

    fn run(start: Saved, fail: bool) -> (Result<(), String>, FakeClip, Option<Saved>) {
        run_with(FakeClip::with(start), fail)
    }

    #[test]
    fn restores_after_success() {
        let (r, clip, seen) = run(Saved::Text("mine".into()), false);
        assert!(r.is_ok());
        assert_eq!(seen, Some(Saved::Text("hello world".into())), "the chord sees the dictated text");
        assert_eq!(clip.now(), Saved::Text("mine".into()));
    }

    #[test]
    fn restores_before_returning_a_chord_error() {
        let (r, clip, _) = run(Saved::Text("mine".into()), true);
        assert_eq!(r, Err("keyboard: denied".into()));
        assert_eq!(clip.now(), Saved::Text("mine".into()));
        assert_eq!(clip.last().as_deref(), Some("restore"));
    }

    #[test]
    fn clears_when_nothing_was_saved() {
        let (r, clip, _) = run(Saved::Nothing, false);
        assert!(r.is_ok());
        assert_eq!(clip.now(), Saved::Nothing);
        assert_eq!(clip.last().as_deref(), Some("clear"));
    }

    #[test]
    fn restores_an_image() {
        let img = Saved::Image(Image { width: 1, height: 1, bytes: vec![1, 2, 3, 255] });
        let (r, clip, _) = run(img.clone(), false);
        assert!(r.is_ok());
        assert_eq!(clip.now(), img);
    }

    #[test]
    fn a_failed_set_leaves_the_clipboard_and_sends_no_paste() {
        let (r, clip, seen) = run_with(FakeClip::failing_set(Saved::Text("mine".into())), false);
        assert_eq!(r, Err("clipboard: busy".into()));
        assert_eq!(seen, None, "no paste chord");
        assert_eq!(clip.now(), Saved::Text("mine".into()));
        assert_eq!(clip.last(), None, "nothing written");
    }
}
