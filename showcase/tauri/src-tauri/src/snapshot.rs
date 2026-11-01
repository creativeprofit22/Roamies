// macOS window screenshots (Cmd+Shift+4 then Space, or Cmd+Shift+5's window mode) pick the window under the cursor,
// and they treat the see-through overlay's web view as solid, so every window shot became a full-screen shot.
// The picker reads the window list when the screenshot starts, so the overlays go fully transparent (which it skips)
// as soon as an interactive screenshot is on screen, and come back when it ends.
use std::ffi::c_void;
use std::{thread, time::Duration};

use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use tauri::{AppHandle, Manager};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *const c_void;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

const ON_SCREEN_ONLY: u32 = 1 << 0;
const EXCLUDE_DESKTOP: u32 = 1 << 4;

pub(crate) fn watch_screenshots(app: AppHandle) {
    thread::spawn(move || {
        let mut faded = false;
        loop {
            thread::sleep(Duration::from_millis(100));
            let fade = screenshot_on_screen();
            // Re-applied while fading, so overlays rebuilt mid-screenshot (a display change) fade too.
            if fade || fade != faded {
                set_overlay_alpha(&app, if fade { 0.0 } else { 1.0 });
            }
            faded = fade;
        }
    });
}

/// Interactive screenshots (Cmd+Shift+4, Cmd+Shift+5, Roamies' own area snap) put `screencapture` windows on
/// screen: a full-screen input shield, plus the highlight in window mode. Non-interactive captures show none.
fn screenshot_on_screen() -> bool {
    autoreleasepool(|_| unsafe {
        let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
        if list.is_null() {
            return false;
        }
        let windows = list as *mut AnyObject; // CFArray of CFDictionary, toll-free bridged to NSArray/NSDictionary
        let owner_key = ns_string(c"kCGWindowOwnerName");
        let screencapture = ns_string(c"screencapture");
        let count: usize = msg_send![windows, count];
        let mut found = false;
        for i in 0..count {
            let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            let owner: *mut AnyObject = msg_send![w, objectForKey: owner_key];
            if !owner.is_null() {
                let same: Bool = msg_send![owner, isEqualToString: screencapture];
                if same.as_bool() {
                    found = true;
                    break;
                }
            }
        }
        CFRelease(list);
        found
    })
}

unsafe fn ns_string(s: &std::ffi::CStr) -> *mut AnyObject {
    msg_send![class!(NSString), stringWithUTF8String: s.as_ptr()]
}

fn set_overlay_alpha(app: &AppHandle, alpha: f64) {
    let ptrs: Vec<usize> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| super::is_overlay(label))
        .filter_map(|(_, w)| w.ns_window().ok().map(|p| p as usize))
        .collect();
    let _ = app.run_on_main_thread(move || unsafe {
        for p in ptrs {
            let _: () = msg_send![p as *mut AnyObject, setAlphaValue: alpha];
        }
    });
}
