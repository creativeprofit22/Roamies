// Ordinary app windows (the setup guide, Settings) next to the click-through overlays.
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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

const ALL: [&Panel; 2] = [&ONBOARDING, &SETTINGS];

/// Opens the panel, or brings it forward if it's already open. `on_destroyed` runs once it closes.
/// Returns false only when the window couldn't be created.
pub fn open(app: &AppHandle, p: &'static Panel, on_destroyed: impl Fn(&AppHandle) + Send + Sync + 'static) -> bool {
    set_dock(app, true);
    if let Some(w) = app.get_webview_window(p.label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        activate(app, p.label);
        return true;
    }
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut b = WebviewWindowBuilder::new(app, p.label, WebviewUrl::App(p.url.into()))
        .title(p.title)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panels_are_distinct_and_guide_unchanged() {
        assert_ne!(ONBOARDING.label, SETTINGS.label);
        assert_eq!((ONBOARDING.size, ONBOARDING.resizable), ((780.0, 540.0), false));
        let (w, h) = SETTINGS.min_size.unwrap();
        assert!(SETTINGS.resizable && w <= SETTINGS.size.0 && h <= SETTINGS.size.1);
    }
}
