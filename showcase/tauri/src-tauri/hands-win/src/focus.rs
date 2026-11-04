// Brings the target window to the front and proves it got there, so typing and clicking never land in the
// wrong app. The AttachThreadInput retry follows trycua/cua libs/cua-driver/rust/crates/platform-windows/src/
// input/inject.rs (MIT, see licenses/cua-LICENSE.txt); the rules come from the SetForegroundWindow docs.
use crate::plan::act_error;
use serde_json::Value;

/// Tries per focus attempt, and how long each waits for Windows to switch.
pub const TRIES: u32 = 3;
pub const POLL_MS: u64 = 500;

/// Windows refused to switch windows (foreground lock, a full-screen app): nothing was sent.
pub fn refused(app: &str) -> Value {
    act_error(
        "focus",
        &format!("Couldn't bring {app} to the front, so nothing was typed or clicked. Ask the user to click its window once, then try again."),
        &[],
    )
}

/// Another window took the front mid-plan; stops before input reaches it.
pub fn wrong_app(step: usize, other: &str, app: &str, done: &[String]) -> Value {
    act_error(
        "focus",
        &format!("Step {step}: {other} is in front instead of {app}, so I stopped before typing into the wrong app."),
        done,
    )
}

#[cfg(windows)]
mod sys {
    use super::{POLL_MS, TRIES};
    use std::time::{Duration, Instant};
    use w32::Win32::Foundation::HWND;
    use w32::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use w32::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow, GA_ROOT,
        SW_RESTORE,
    };

    /// Top-level window that has the keyboard now (dialogs and child focus resolve to their root).
    pub fn foreground_root() -> Option<HWND> {
        let h = unsafe { GetForegroundWindow() };
        if h.is_invalid() {
            return None;
        }
        let root = unsafe { GetAncestor(h, GA_ROOT) };
        Some(if root.is_invalid() { h } else { root })
    }

    pub fn is_front(target: HWND) -> bool {
        foreground_root() == Some(target)
    }

    /// Joins our input queue to the foreground thread's so Windows lets us hand over the front; undone on drop.
    struct Attach {
        ours: u32,
        theirs: u32,
    }

    impl Attach {
        fn to_foreground() -> Option<Attach> {
            let fg = unsafe { GetForegroundWindow() };
            if fg.is_invalid() {
                return None;
            }
            let theirs = unsafe { GetWindowThreadProcessId(fg, None) };
            let ours = unsafe { GetCurrentThreadId() };
            if theirs == 0 || theirs == ours || !unsafe { AttachThreadInput(ours, theirs, true) }.as_bool() {
                return None;
            }
            Some(Attach { ours, theirs })
        }
    }

    impl Drop for Attach {
        fn drop(&mut self) {
            unsafe {
                let _ = AttachThreadInput(self.ours, self.theirs, false);
            }
        }
    }

    fn settled(target: HWND, until: Instant) -> bool {
        loop {
            if is_front(target) {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Restores, raises and verifies `target`; gives up at `deadline` or after `TRIES` tries.
    pub fn bring_to_front(target: HWND, deadline: Instant) -> bool {
        if unsafe { IsIconic(target) }.as_bool() {
            unsafe {
                let _ = ShowWindow(target, SW_RESTORE);
            }
        }
        for attempt in 0..TRIES {
            if is_front(target) {
                return true;
            }
            if attempt == 0 {
                unsafe {
                    let _ = SetForegroundWindow(target);
                }
            } else {
                let _joined = Attach::to_foreground();
                unsafe {
                    let _ = BringWindowToTop(target);
                    let _ = SetForegroundWindow(target);
                }
            }
            let until = (Instant::now() + Duration::from_millis(POLL_MS)).min(deadline);
            if settled(target, until) {
                return true;
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        is_front(target)
    }
}

#[cfg(windows)]
pub use sys::{bring_to_front, foreground_root, is_front};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_sends_nothing_and_names_the_app() {
        let v = refused("Notepad");
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "focus");
        assert_eq!(v["done"], serde_json::json!([]));
        assert!(v["error"].as_str().unwrap_or("").starts_with("Couldn't bring Notepad to the front"));
    }

    #[test]
    fn wrong_app_keeps_what_was_done() {
        let done = vec!["clicked OK".to_string()];
        let v = wrong_app(2, "Chrome", "Notepad", &done);
        assert_eq!(v["code"], "focus");
        assert_eq!(v["done"], serde_json::json!(["clicked OK"]));
        assert_eq!(v["error"], "Step 2: Chrome is in front instead of Notepad, so I stopped before typing into the wrong app.");
    }
}
