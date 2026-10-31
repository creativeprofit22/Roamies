// Dictation: paste a voice transcript into the app in front. The host reads which app has focus, the sidecar's
// safety rules (checkDictationTarget) decide, then it replies dictation_paste or dictation_copy.
// The paste follows Handy's clipboard.rs (MIT): save, write, paste chord, wait, always restore.
// Limit: only text or an image is saved and restored; copied files and rich-text formatting are not.
use std::sync::Mutex;
use std::{thread, time::Duration};

use serde_json::{json, Value};
use tauri::AppHandle;

/// Where dictated text goes. Kept behind a trait so a "type characters" fallback can be added later.
pub trait TextSink: Send {
    fn insert(&mut self, text: &str) -> Result<(), String>;
}

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

impl<C: Clip + Send, K: Chord + Send> TextSink for ClipboardPaste<C, K> {
    fn insert(&mut self, text: &str) -> Result<(), String> {
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

pub struct SystemClip(arboard::Clipboard);

impl SystemClip {
    pub fn new() -> Result<Self, String> {
        arboard::Clipboard::new().map(SystemClip).map_err(|e| format!("clipboard: {e}"))
    }
}

impl Clip for SystemClip {
    fn save(&mut self) -> Saved {
        if let Ok(t) = self.0.get_text() {
            return Saved::Text(t);
        }
        match self.0.get_image() {
            Ok(i) => Saved::Image(Image { width: i.width, height: i.height, bytes: i.bytes.into_owned() }),
            Err(_) => Saved::Nothing,
        }
    }
    fn set_text(&mut self, text: &str) -> Result<(), String> {
        self.0.set_text(text).map_err(|e| format!("clipboard: {e}"))
    }
    fn restore(&mut self, saved: &Saved) -> Result<(), String> {
        match saved {
            Saved::Text(t) => self.0.set_text(t.as_str()),
            Saved::Image(i) => self.0.set_image(arboard::ImageData { width: i.width, height: i.height, bytes: i.bytes.as_slice().into() }),
            Saved::Nothing => self.0.clear(),
        }
        .map_err(|e| format!("clipboard: {e}"))
    }
}

pub struct SystemChord;

impl Chord for SystemChord {
    fn paste(&mut self) -> Result<(), String> {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        let mut e = Enigo::new(&Settings::default()).map_err(|e| format!("keyboard: {e}"))?;
        #[cfg(target_os = "macos")]
        let (modifier, v) = (Key::Meta, Key::Other(9));
        #[cfg(target_os = "windows")]
        let (modifier, v) = (Key::Control, Key::Other(0x56));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let (modifier, v) = (Key::Control, Key::Unicode('v'));
        e.key(modifier, Direction::Press).map_err(|e| format!("keyboard: {e}"))?;
        // Some apps poll modifier state, so hold it briefly around the V.
        thread::sleep(Duration::from_millis(20));
        let r = e.key(v, Direction::Click);
        thread::sleep(Duration::from_millis(20));
        let up = e.key(modifier, Direction::Release);
        r.and(up).map_err(|e| format!("keyboard: {e}"))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AppId {
    pub id: String,
    pub name: String,
}

#[cfg(target_os = "macos")]
pub fn focused_app() -> Option<AppId> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    unsafe fn ns_string(s: *mut AnyObject) -> Option<String> {
        if s.is_null() {
            return None;
        }
        let p: *const std::os::raw::c_char = msg_send![s, UTF8String];
        (!p.is_null()).then(|| std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned())
    }
    unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let front: *mut AnyObject = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return None;
        }
        let id = ns_string(msg_send![front, bundleIdentifier])?;
        let name = ns_string(msg_send![front, localizedName]).unwrap_or_else(|| id.clone());
        Some(AppId { id, name })
    }
}

#[cfg(windows)]
pub fn focused_app() -> Option<AppId> {
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetForegroundWindow, GetWindowThreadProcessId};

    fn exe_of(hwnd: HWND) -> Option<String> {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return None;
            }
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(h);
            if ok == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit(['\\', '/']).next().map(str::to_owned)
        }
    }

    // UWP apps (Settings, Windows Security) run inside ApplicationFrameHost; the real process owns a child window.
    unsafe extern "system" fn find_hosted(child: HWND, out: LPARAM) -> i32 {
        let out = &mut *(out as *mut Option<String>);
        match exe_of(child) {
            Some(exe) if !exe.eq_ignore_ascii_case("ApplicationFrameHost.exe") => {
                *out = Some(exe);
                0
            }
            _ => 1,
        }
    }

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return None;
    }
    let mut exe = exe_of(hwnd)?;
    if exe.eq_ignore_ascii_case("ApplicationFrameHost.exe") {
        let mut hosted: Option<String> = None;
        unsafe { EnumChildWindows(hwnd, Some(find_hosted), &mut hosted as *mut _ as LPARAM) };
        exe = hosted?;
    }
    let name = exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(&exe).to_owned();
    Some(AppId { id: exe, name })
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn focused_app() -> Option<AppId> {
    None
}

/// A final transcript in dictation mode. Read the target now, while it still has focus, then ask the sidecar.
pub fn on_final(app: &AppHandle, text: &str, request_id: Option<&str>) {
    let target = focused_app().map(|a| json!({ "id": a.id, "name": a.name })).unwrap_or(Value::Null);
    crate::to_sidecar(app, &json!({ "type": "dictation", "text": text, "app": target, "request_id": request_id }));
}

static PASTE: Mutex<()> = Mutex::new(());

fn report(app: &AppHandle, result: Result<(), String>) {
    let ok = result.is_ok();
    crate::to_sidecar(app, &json!({ "type": "dictation_result", "ok": ok, "error": result.err() }));
    crate::to_overlays(app, &json!({ "kind": "voice", "type": "dictated", "ok": ok }));
}

/// Paste into the app in front, off the main thread, one paste at a time. On failure the text is left on the clipboard.
pub fn paste(app: &AppHandle, text: String, request_id: Option<String>) {
    let app = app.clone();
    thread::spawn(move || {
        let _one = PASTE.lock().unwrap_or_else(|e| e.into_inner());
        let step = crate::telemetry::start("host.dictation_paste", request_id.as_deref(), None, Default::default());
        let result = SystemClip::new().and_then(|clip| {
            let mut sink = ClipboardPaste { clip, chord: SystemChord, settle: Duration::from_millis(50), wait: Duration::from_millis(300) };
            sink.insert(&text)
        });
        if result.is_err() {
            if let Ok(mut c) = SystemClip::new() {
                let _ = c.set_text(&text);
            }
        }
        let (outcome, code) = if result.is_ok() { (crate::telemetry::Outcome::Ok, None) } else { (crate::telemetry::Outcome::Error, Some("paste_failed")) };
        crate::telemetry::end(step, outcome, code, Default::default());
        report(&app, result);
    });
}

/// Blocked target: just put the text on the clipboard.
pub fn copy_only(app: &AppHandle, text: String) {
    let app = app.clone();
    thread::spawn(move || {
        let _one = PASTE.lock().unwrap_or_else(|e| e.into_inner());
        let result = SystemClip::new().and_then(|mut c| c.set_text(&text));
        report(&app, result);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct FakeClip(Arc<Mutex<(Saved, Vec<String>)>>);
    impl FakeClip {
        fn with(s: Saved) -> Self {
            FakeClip(Arc::new(Mutex::new((s, vec![]))))
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

    fn run(start: Saved, fail: bool) -> (Result<(), String>, FakeClip, Option<Saved>) {
        let clip = FakeClip::with(start);
        let seen = Arc::new(Mutex::new(None));
        let chord = FakeChord { clip: clip.clone(), fail, seen: seen.clone() };
        let mut sink = ClipboardPaste { clip: clip.clone(), chord, settle: Duration::ZERO, wait: Duration::ZERO };
        let r = sink.insert("hello world");
        let s = seen.lock().unwrap().clone();
        (r, clip, s)
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
}
