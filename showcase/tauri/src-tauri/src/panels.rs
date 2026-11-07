// Ordinary app windows (the setup guide, Settings, the Roamies panel by the tray icon) next to the click-through overlays.
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::to_sidecar;

pub struct Panel {
    pub label: &'static str,
    pub url: &'static str,
    pub title: &'static str,
    pub size: (f64, f64),
    pub min_size: Option<(f64, f64)>,
    pub resizable: bool,
    /// macOS: the page draws its own title strip (and drags the window from it).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub overlay_title: bool,
}

pub const ONBOARDING: Panel = Panel {
    label: "onboarding",
    url: "onboarding/index.html",
    title: "Welcome to Roamies",
    size: (780.0, 540.0),
    min_size: None,
    resizable: false,
    overlay_title: true,
};

pub const SETTINGS: Panel = Panel {
    label: "settings",
    url: "settings/index.html",
    title: "Roamies Settings",
    size: (820.0, 600.0),
    min_size: Some((680.0, 480.0)),
    resizable: true,
    overlay_title: false,
};

/// The popover by the tray icon. Not in `ALL`: it doesn't put Roamies in the Dock, and `show_panel` builds it.
pub const PANEL: Panel = Panel {
    label: "panel",
    url: "panel/index.html",
    title: "Roamies",
    size: (560.0, 560.0),
    min_size: None,
    resizable: false,
    overlay_title: false,
};

const ALL: [&Panel; 2] = [&ONBOARDING, &SETTINGS];

/// Opens the panel, or brings it forward if it's already open. `on_destroyed` runs once it closes.
/// Returns false only when the window couldn't be created.
pub fn open(app: &AppHandle, p: &'static Panel, on_destroyed: impl Fn(&AppHandle) + Send + Sync + 'static) -> bool {
    open_as(app, p, p.url, p.title, on_destroyed)
}

/// `open` with another page and title for this panel (the guide's chat-only mode). An open window keeps its page.
pub fn open_as(app: &AppHandle, p: &'static Panel, url: &str, title: &str, on_destroyed: impl Fn(&AppHandle) + Send + Sync + 'static) -> bool {
    set_dock(app, true);
    if let Some(w) = app.get_webview_window(p.label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        activate(app, p.label);
        return true;
    }
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut b = WebviewWindowBuilder::new(app, p.label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(p.size.0, p.size.1)
        .resizable(p.resizable)
        .maximizable(p.resizable)
        .minimizable(p.resizable)
        .center()
        .focused(true)
        .background_color(tauri::window::Color(5, 16, 18, 255));
    if let Some((w, h)) = p.min_size {
        b = b.min_inner_size(w, h);
    }
    #[cfg(target_os = "macos")]
    if p.overlay_title {
        b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    match b.build() {
        Ok(w) => {
            let app2 = app.clone();
            let label = p.label;
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    set_dock(&app2, any_open(&app2, label));
                    on_destroyed(&app2);
                }
            });
            activate(app, p.label);
            true
        }
        Err(e) => {
            set_dock(app, any_open(app, p.label));
            eprintln!("{} failed to open: {e}", p.label);
            false
        }
    }
}

/// Calls `window[js_fn](msg)` in the panel, if it's open.
pub fn send(app: &AppHandle, p: &Panel, js_fn: &str, msg: &Value) {
    if let Some(w) = app.get_webview_window(p.label) {
        let _ = w.eval(format!("window.{js_fn}&&{js_fn}({msg})"));
    }
}

fn any_open(app: &AppHandle, except: &str) -> bool {
    ALL.iter().any(|p| p.label != except && app.get_webview_window(p.label).is_some())
}

/// While a panel is open Roamies is a normal app (Dock icon, ⌘Tab), so it's easy to get back to after
/// a trip to System Settings. Otherwise it lives only in the menu bar.
pub fn set_dock(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory };
        if let Err(e) = app.set_activation_policy(policy) {
            eprintln!("dock icon {}: {e}", if visible { "on" } else { "off" });
        }
    }
    let _ = (app, visible);
}

/// A menu-bar-only app isn't frontmost, and macOS 14+ ignores requests to activate it from the
/// background. So the window is put on top directly, then the app asks to become active.
pub fn activate(app: &AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    {
        let ptr = app.get_webview_window(label).and_then(|w| w.ns_window().ok()).map(|p| p as usize);
        let _ = app.run_on_main_thread(move || unsafe {
            use objc2::runtime::{AnyObject, Bool};
            use objc2::{class, msg_send};
            if let Some(p) = ptr {
                let win = p as *mut AnyObject;
                let _: () = msg_send![win, orderFrontRegardless];
                let _: () = msg_send![win, makeKeyWindow];
            }
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, activateIgnoringOtherApps: Bool::YES];
        });
    }
    let _ = (app, label);
}

// ---------- the Roamies panel ----------

/// When the panel last hid because it lost focus: a click on the icon that caused it mustn't reopen it.
static PANEL_BLURRED: Mutex<Option<Instant>> = Mutex::new(None);
/// Counts opens, so a close that's still playing its animation can tell it was opened again and stay up.
static PANEL_GEN: AtomicUsize = AtomicUsize::new(0);
/// The close animation is playing (the window is still on screen, but on its way out).
static PANEL_CLOSING: AtomicBool = AtomicBool::new(false);
/// How long the panel's close animation runs (panel.css: --shut).
const PANEL_SHUT_MS: u64 = 150;
/// The panel sits above the icon (a taskbar at the bottom), so it opens from its bottom edge.
static PANEL_FROM_BOTTOM: AtomicBool = AtomicBool::new(false);

fn panel_open_js() -> String {
    format!("window.__panelOpen&&__panelOpen({})", PANEL_FROM_BOTTOM.load(Ordering::SeqCst))
}

/// Plays the panel's close animation, then hides it (unless it was opened again meanwhile). why: what closed it,
/// for the log (blur, icon, esc, panel).
pub(crate) fn hide_panel(app: &AppHandle, why: &'static str) {
    let Some(w) = app.get_webview_window(PANEL.label) else { return };
    if !w.is_visible().unwrap_or(false) || PANEL_CLOSING.swap(true, Ordering::SeqCst) {
        return;
    }
    let gen = PANEL_GEN.load(Ordering::SeqCst);
    let _ = w.eval("window.__panelShut&&__panelShut()");
    let app = app.clone();
    thread::spawn(move || {
        // A little past the animation, so its last frame has drawn before the window goes.
        thread::sleep(Duration::from_millis(PANEL_SHUT_MS + 40));
        if PANEL_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        PANEL_CLOSING.store(false, Ordering::SeqCst);
        if let Some(w) = app.get_webview_window(PANEL.label) {
            let _ = w.hide();
        }
        to_sidecar(&app, &json!({ "type": "panel_closed", "why": why }));
    });
}

/// Opens the panel by the icon (or closes it if it's open). `toggle`: false from the menu's Open Panel, which
/// only opens. The icon's rect comes with a click; from the menu, it's asked for.
pub(crate) fn show_panel(app: &AppHandle, rect: Option<tauri::Rect>, toggle: bool) {
    let existing = app.get_webview_window(PANEL.label);
    if let Some(w) = &existing {
        if w.is_visible().unwrap_or(false) {
            // On its way out: a toggle lets it go, an open brings it back.
            let closing = PANEL_CLOSING.load(Ordering::SeqCst);
            if toggle || !closing {
                if toggle && !closing {
                    hide_panel(app, "icon");
                }
                return;
            }
            PANEL_GEN.fetch_add(1, Ordering::SeqCst);
            PANEL_CLOSING.store(false, Ordering::SeqCst);
            let _ = w.eval(panel_open_js());
            let _ = w.set_focus();
            return;
        }
    }
    // The click that took focus away (and so hid it) is the same one asking to toggle: leave it closed.
    if toggle && PANEL_BLURRED.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(400)) {
        return;
    }
    let w = match existing {
        Some(w) => w,
        None => {
            let b = WebviewWindowBuilder::new(app, PANEL.label, WebviewUrl::App(PANEL.url.into()))
                .title(PANEL.title)
                .inner_size(PANEL.size.0, PANEL.size.1)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                // Transparent, so it opens and closes as its own shape (panel.css draws the frame).
                // No native shadow: macOS works it out from the drawn pixels and would trail the animation.
                .transparent(true)
                .shadow(false)
                .visible(false);
            match b.build() {
                Ok(w) => {
                    let app2 = app.clone();
                    w.on_window_event(move |e| {
                        if let tauri::WindowEvent::Focused(false) = e {
                            *PANEL_BLURRED.lock().unwrap() = Some(Instant::now());
                            hide_panel(&app2, "blur");
                        }
                    });
                    w
                }
                Err(e) => {
                    eprintln!("panel failed to open: {e}");
                    crate::telemetry::record_error("host.error", None, "panel_open_failed", Default::default());
                    return;
                }
            }
        }
    };
    let rect = rect.or_else(|| app.tray_by_id("roamies").and_then(|t| t.rect().ok().flatten()));
    PANEL_FROM_BOTTOM.store(place_panel(app, &w, rect), Ordering::SeqCst);
    PANEL_GEN.fetch_add(1, Ordering::SeqCst);
    PANEL_CLOSING.store(false, Ordering::SeqCst);
    let _ = w.eval(panel_open_js());
    let _ = w.show();
    let _ = w.set_focus();
    activate(app, PANEL.label);
    to_sidecar(app, &json!({ "type": "panel_open" }));
}

/// Right under the icon in the menu bar (macOS, or a taskbar at the top), right above it in a taskbar at the
/// bottom (Windows), kept inside the screen's usable area. True when it's above the icon.
fn place_panel(app: &AppHandle, w: &WebviewWindow, rect: Option<tauri::Rect>) -> bool {
    let icon = rect.map(|r| {
        let p = r.position.to_physical::<f64>(1.0);
        let z = r.size.to_physical::<f64>(1.0);
        (p.x, p.y, z.width, z.height)
    });
    let monitor = match icon {
        Some((x, y, iw, ih)) => app.monitor_from_point(x + iw / 2.0, y + ih / 2.0).ok().flatten(),
        None => None,
    }
    .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return false };
    let wa = m.work_area();
    let area = (wa.position.x as f64, wa.position.y as f64, wa.size.width as f64, wa.size.height as f64);
    let (x, y, pw, h, above) = panel_spot(icon, area, m.scale_factor());
    let _ = w.set_size(tauri::PhysicalSize::new(pw.round() as u32, h.round() as u32));
    let _ = w.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
    above
}

/// Where the panel goes, in physical px: (x, y, width, height, above the icon). icon and area are (x, y, w, h).
fn panel_spot(icon: Option<(f64, f64, f64, f64)>, (ax, ay, aw, ah): (f64, f64, f64, f64), s: f64) -> (f64, f64, f64, f64, bool) {
    let gap = 6.0 * s;
    let margin = 8.0 * s;
    let h = (PANEL.size.1 * s).min(ah - 2.0 * margin);
    let pw = PANEL.size.0 * s;
    let (cx, y, above) = match icon {
        Some((x, y, iw, ih)) if y + ih / 2.0 < ay + ah / 2.0 => (x + iw / 2.0, (y + ih).max(ay) + gap, false),
        Some((x, y, iw, _)) => (x + iw / 2.0, y.min(ay + ah) - h - gap, true),
        None => (ax + aw - pw / 2.0 - margin, ay + gap, false),
    };
    let x = (cx - pw / 2.0).clamp(ax + margin, (ax + aw - pw - margin).max(ax + margin));
    let y = y.clamp(ay + margin.min(gap), (ay + ah - h - margin).max(ay));
    (x, y, pw, h, above)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panels_are_distinct_and_guide_unchanged() {
        assert_ne!(ONBOARDING.label, SETTINGS.label);
        assert_eq!((ONBOARDING.size, ONBOARDING.resizable), ((780.0, 540.0), false));
        let (w, h) = SETTINGS.min_size.unwrap();
        assert!(SETTINGS.resizable && w <= SETTINGS.size.0 && h <= SETTINGS.size.1);
        assert!(ALL.iter().all(|p| p.label != PANEL.label));
    }

    #[test]
    fn panel_sits_above_a_bottom_taskbar_icon_and_stays_on_screen() {
        // 1920x1040 work area (a 40 px taskbar), icon near the bottom-right corner, 125% scale.
        let (x, y, w, h, above) = panel_spot(Some((1850.0, 1045.0, 30.0, 30.0)), (0.0, 0.0, 1920.0, 1040.0), 1.25);
        assert!(above);
        assert!(x >= 0.0 && x + w <= 1920.0 && y >= 0.0 && y + h <= 1040.0);
        // A menu bar icon at the top: under it.
        let (_, y, _, _, above) = panel_spot(Some((1800.0, 0.0, 24.0, 24.0)), (0.0, 25.0, 1920.0, 1055.0), 1.0);
        assert!(!above && y >= 25.0);
    }
}
