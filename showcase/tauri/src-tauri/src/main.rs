// Menu-bar-only shell for the roamies. One transparent, always-on-top, click-through webview per
// monitor; a Node sidecar (gg-agent) is the brain and owns the tray menu, settings and logins.
// No Dock icon (LSUIElement + Accessory policy) and no taskbar entries on Windows/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dictation;
mod lifecycle;
mod panels;
mod sidecar;
mod telemetry;
#[cfg(target_os = "macos")]
mod snapshot;
mod screen_map;
mod voice;

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::{thread, time::Duration};

use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};

use panels::Panel;

use sidecar::spawn_sidecar;
use voice::{init_hotkeys, perms_binary, set_hotkey, start_voice, stop_voice, to_voice};

static GENERATION: AtomicUsize = AtomicUsize::new(0);
/// The setup guide is open: voice events go to it (for the "try it" test) instead of the agent.
static ONBOARDING: AtomicBool = AtomicBool::new(false);
/// Voice Mode is Dictation: a final transcript is pasted into the app in front instead of going to the agent.
static DICTATION: AtomicBool = AtomicBool::new(false);
const ONBOARDING_LABEL: &str = panels::ONBOARDING.label;

struct Sidecar(Mutex<Option<ChildStdin>>);
struct Roster(Mutex<Vec<String>>);
/// The voice helper and how many times it has died on its own since it was last wanted.
struct Voice(Mutex<Option<Child>>, lifecycle::Restarts);
/// Talk chord passed to the voice helper, e.g. ["control", "option"].
struct TalkChord(Mutex<Vec<String>>);
/// Windows: the engine the sidecar chose and its model folder (the sidecar owns downloads and the choice).
struct VoiceWant(Mutex<voice::Want>);
/// Overlay labels: `home` holds the real Sidekick, `active` is the one showing it now (a target on
/// another monitor moves it there; the next request brings it home).
#[derive(Default)]
struct Overlays(Mutex<OverlaySet>);
#[derive(Default)]
struct OverlaySet {
    home: Option<String>,
    active: Option<String>,
}

/// Windows: helpers are console programs, so without this each one opens a console window.
fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}


fn is_overlay(label: &str) -> bool {
    label.starts_with("overlay-")
}

/// Whether the message was written (false: no sidecar running, or the pipe is broken).
fn to_sidecar(app: &AppHandle, msg: &Value) -> bool {
    match app.state::<Sidecar>().0.lock().unwrap().as_mut() {
        Some(stdin) => writeln!(stdin, "{msg}").is_ok(),
        None => false,
    }
}

fn broadcast(app: &AppHandle, msg: &Value) {
    let js = format!("window.__roamieHost&&__roamieHost({msg})");
    for (label, w) in app.webview_windows() {
        if is_overlay(&label) {
            let _ = w.eval(&js);
        }
    }
}

fn to_overlay(w: &WebviewWindow, msg: &Value) {
    let _ = w.eval(format!("window.__roamieHost&&__roamieHost({msg})"));
}

/// Every message for the overlays goes through here. Inactive overlays ignore all but sound and
/// telemetry, so a broadcast reaches only the Sidekick that's showing.
fn to_overlays(app: &AppHandle, msg: &Value) {
    let kind = msg.get("kind").and_then(Value::as_str);
    if kind != Some("agent") {
        if !matches!(kind, Some("sound" | "telemetry" | "cancel_ask")) {
            go_home(app);
        }
        return broadcast(app, msg);
    }
    let e = &msg["e"];
    let px = e.get("unit").and_then(Value::as_str) == Some("px");
    let routed = match e.get("type").and_then(Value::as_str) {
        Some("start") => {
            go_home(app);
            false
        }
        Some("point") if px => point_on_monitor(app, msg).is_some(),
        Some("tool_target") if px => target_on_active(app, msg).is_some(),
        _ => false,
    };
    if !routed {
        broadcast(app, msg);
    }
}

/// Make `label` the overlay showing the Sidekick; the one showing it before hides its copy.
fn activate(app: &AppHandle, label: &str, tell: bool) {
    let state = app.state::<Overlays>();
    let old = {
        let mut set = state.0.lock().unwrap();
        if set.active.as_deref() == Some(label) {
            return;
        }
        set.active.replace(label.to_owned())
    };
    if let Some(w) = old.and_then(|l| app.get_webview_window(&l)) {
        to_overlay(&w, &json!({ "kind": "active", "on": false }));
    }
    if tell {
        if let Some(w) = app.get_webview_window(label) {
            to_overlay(&w, &json!({ "kind": "active", "on": true }));
        }
    }
}

fn go_home(app: &AppHandle) {
    let home = app.state::<Overlays>().0.lock().unwrap().home.clone();
    if let Some(h) = home {
        activate(app, &h, true);
    }
}

fn monitor_area(m: &tauri::Monitor) -> screen_map::Area {
    let (p, z) = (m.position(), m.size());
    screen_map::Area { x: p.x as f64, y: p.y as f64, w: z.width as f64, h: z.height as f64, scale: m.scale_factor() }
}

/// The window's own physical origin and scale, so the numbers match the page that draws them.
fn window_area(w: &WebviewWindow) -> Option<screen_map::Area> {
    let (p, z, s) = (w.inner_position().ok()?, w.inner_size().ok()?, w.scale_factor().ok()?);
    Some(screen_map::Area { x: p.x as f64, y: p.y as f64, w: z.width as f64, h: z.height as f64, scale: s })
}

/// A point in physical pixels: send it to the overlay on the monitor holding it (building one if
/// that monitor has none) in that overlay's CSS pixels, and move the Sidekick there.
fn point_on_monitor(app: &AppHandle, msg: &Value) -> Option<()> {
    app.state::<Overlays>().0.lock().unwrap().home.as_ref()?;
    let r = screen_map::rect(&msg["e"]["rect"])?;
    let mons = app.available_monitors().ok()?;
    let areas: Vec<screen_map::Area> = mons.iter().map(monitor_area).collect();
    let i = screen_map::pick(&areas, r)?;
    let gen = GENERATION.load(Ordering::Relaxed);
    let label = overlay_label(gen, &mons[i]);
    let mut m = msg.clone();
    m["e"]["local"] = json!(true);
    if let Some(w) = app.get_webview_window(&label) {
        m["e"]["rect"] = json!(screen_map::to_css(&window_area(&w).unwrap_or(areas[i]), r));
        activate(app, &label, true);
        to_overlay(&w, &m);
    } else {
        m["e"]["rect"] = json!(screen_map::to_css(&areas[i], r));
        let pending = json!([{ "kind": "active", "on": true }, m]);
        build_overlay(app, gen, &mons[i], &[], true, Some(&pending)).ok()?;
        activate(app, &label, false);
    }
    Some(())
}

/// The window being captured, in physical pixels → the showing overlay's CSS pixels.
fn target_on_active(app: &AppHandle, msg: &Value) -> Option<()> {
    let r = screen_map::rect(&msg["e"]["window"]["bounds"])?;
    let label = app.state::<Overlays>().0.lock().unwrap().active.clone()?;
    let w = app.get_webview_window(&label)?;
    let mut m = msg.clone();
    m["e"]["window"]["bounds"] = json!(screen_map::to_css(&window_area(&w)?, r));
    m["e"]["local"] = json!(true);
    to_overlay(&w, &m);
    Some(())
}

/// tao can crash when click-through is toggled on a hidden window.
fn may_toggle_click_through(visible: Option<bool>) -> bool {
    visible == Some(true)
}

fn set_click_through(w: &WebviewWindow, ignore: bool) {
    if may_toggle_click_through(w.is_visible().ok()) {
        let _ = w.set_ignore_cursor_events(ignore);
    }
}

fn to_onboarding(app: &AppHandle, msg: &Value) {
    panels::send(app, &panels::ONBOARDING, "__onboard", msg);
}

// ---------- commands called by the page ----------

/// Cursor entered or left something clickable: flip click-through.
#[tauri::command]
fn set_hot(window: WebviewWindow, hot: bool) {
    set_click_through(&window, !hot);
}

#[tauri::command]
fn sidecar_send(app: AppHandle, mut msg: Value) {
    telemetry::stamp_answer(&telemetry::TEL, &mut msg);
    to_sidecar(&app, &msg);
}

/// Resident memory of the host and the voice helper, for the sidecar's `app.memory` sample.
fn memory(app: &AppHandle) -> Value {
    let helper = app.state::<Voice>().0.lock().unwrap().as_ref().map(Child::id);
    json!({ "type": "memory", "host": lifecycle::rss_bytes(std::process::id()), "helper": helper.and_then(lifecycle::rss_bytes) })
}

/// The input bubble needs keystrokes: make the overlay key while typing, then hand focus back.
#[tauri::command]
fn set_typing(app: AppHandle, window: WebviewWindow, on: bool) {
    let _ = window.set_focusable(on);
    if on {
        let _ = window.set_focus();
        // Opened from a hotkey (e.g. after an area snap), Roamies isn't the active app and macOS 14+
        // ignores plain focus requests, so make the overlay key directly, then ask to activate.
        #[cfg(target_os = "macos")]
        if let Ok(p) = window.ns_window() {
            let p = p as usize;
            let _ = app.run_on_main_thread(move || unsafe {
                use objc2::runtime::{AnyObject, Bool};
                use objc2::{class, msg_send};
                let win = p as *mut AnyObject;
                let _: () = msg_send![win, makeKeyAndOrderFront: std::ptr::null::<AnyObject>()];
                let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                let _: () = msg_send![ns_app, activateIgnoringOtherApps: Bool::YES];
            });
        }
    } else {
        #[cfg(target_os = "macos")]
        let _ = app.run_on_main_thread(|| unsafe {
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, deactivate];
        });
    }
    let _ = &app;
}

/// Runs the voice helper in a one-shot permission mode and returns what it printed.
fn helper_perms(args: &[&str]) -> Value {
    let Some(bin) = perms_binary() else { return json!({ "type": "perms", "unsupported": true }) };
    let out = hide_console(&mut Command::new(bin)).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output();
    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|t| t.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok()))
        .unwrap_or_else(|| json!({ "type": "perms", "error": true }))
}

/// Accessibility (reading and controlling other apps) is checked by the hands helper.
fn accessibility(prompt: bool) -> &'static str {
    let Some(bin) = helper_binary("roamies-hands") else { return "unknown" };
    let mut cmd = Command::new(bin);
    cmd.arg("trusted");
    if prompt {
        cmd.arg("--prompt");
    }
    let ok = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()
        .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
        .and_then(|v| v.get("trusted").and_then(Value::as_bool))
        .unwrap_or(false);
    if ok { "granted" } else { "unknown" }
}

#[tauri::command]
async fn perm_status() -> Value {
    // Windows: only the microphone privacy switch, read by the voice helper.
    if cfg!(windows) {
        return tauri::async_runtime::spawn_blocking(|| helper_perms(&["--perms"])).await.unwrap_or(Value::Null);
    }
    if !cfg!(target_os = "macos") {
        return json!({ "type": "perms", "unsupported": true });
    }
    tauri::async_runtime::spawn_blocking(|| {
        let mut v = helper_perms(&["--perms"]);
        v["accessibility"] = json!(accessibility(false));
        v
    })
    .await
    .unwrap_or(Value::Null)
}

/// Shows the system prompt for one permission (mic waits for the answer), then returns the new state.
#[tauri::command]
async fn perm_request(kind: String) -> Value {
    if cfg!(windows) && kind == "mic" {
        // Windows has no mic prompt for desktop apps; the guide opens Settings and re-checks.
        return tauri::async_runtime::spawn_blocking(|| helper_perms(&["--perms"])).await.unwrap_or(Value::Null);
    }
    if !cfg!(target_os = "macos") || !["mic", "speech", "screen", "accessibility"].contains(&kind.as_str()) {
        return json!({ "type": "perms", "unsupported": true });
    }
    if kind == "accessibility" {
        // Shows macOS's "would like to control this computer" dialog; it opens Settings itself.
        return tauri::async_runtime::spawn_blocking(|| {
            let state = accessibility(true);
            let mut v = helper_perms(&["--perms"]);
            v["accessibility"] = json!(state);
            v
        })
        .await
        .unwrap_or(Value::Null);
    }
    tauri::async_runtime::spawn_blocking(move || helper_perms(&["--request", &kind])).await.unwrap_or(Value::Null)
}

/// Opens one Privacy & Security pane in System Settings.
#[tauri::command]
fn open_settings(pane: String) {
    const PANES: [&str; 6] = ["Privacy_Microphone", "Privacy_SpeechRecognition", "Privacy_ScreenCapture", "Privacy_FilesAndFolders", "Privacy_AllFiles", "Privacy_Accessibility"];
    // Accept both guide spellings: the macOS pane id and the ms-settings name.
    if cfg!(windows) && (pane == "Privacy_Microphone" || pane == "privacy-microphone") {
        // explorer hands ms-settings: links to the Settings app.
        let _ = hide_console(&mut Command::new("explorer")).arg("ms-settings:privacy-microphone").spawn();
        return;
    }
    if !cfg!(target_os = "macos") || !PANES.contains(&pane.as_str()) {
        return;
    }
    let _ = Command::new("open").arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}")).spawn();
}

/// A panel calls this once its page has loaded: by then the window is really on screen, so
/// putting it on top sticks (doing it at creation time loses to whatever app is frontmost).
#[tauri::command]
fn focus_guide(app: AppHandle, window: WebviewWindow) {
    panels::activate(&app, window.label());
}

/// The mascot's right-click opens Settings. (`open_settings` is the OS privacy-pane opener.)
#[tauri::command]
// async: building a window inside a sync command deadlocks WebView2 on Windows.
async fn show_settings(app: AppHandle) {
    open_settings_window(&app);
}

/// The guide hides its title bar, so its top strip calls this to move the window.
#[tauri::command]
fn drag_window(window: WebviewWindow) {
    let _ = window.start_dragging();
}

/// Screen Recording only takes effect after a relaunch. The guide reopens on the same step after.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

/// Finishes the guide: closes it and has the Sidekick drop in right under the tray icon.
#[tauri::command]
fn onboarding_finish(app: AppHandle, text: String) {
    if let Some(w) = app.get_webview_window(ONBOARDING_LABEL) {
        let _ = w.close();
    }
    let tray = app.tray_by_id("roamies").and_then(|t| t.rect().ok().flatten());
    let app2 = app.clone();
    // Let the guide window finish closing first, so the drop-in is the only thing moving.
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(350));
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || intro_at_tray(&app3, tray, &text));
    });
}

fn intro_at_tray(app: &AppHandle, tray: Option<tauri::Rect>, text: &str) {
    let overlays: Vec<WebviewWindow> = app.webview_windows().into_iter().filter(|(l, _)| is_overlay(l)).map(|(_, w)| w).collect();
    // Tray icon centre in physical px; without it, aim for the right end of the main screen's menu bar.
    let point = tray.map(|r| {
        let s = 1.0;
        let p = r.position.to_physical::<f64>(s);
        let z = r.size.to_physical::<f64>(s);
        (p.x + z.width / 2.0, p.y + z.height / 2.0)
    });
    for w in &overlays {
        let (Ok(pos), Ok(size), Ok(scale)) = (w.inner_position(), w.inner_size(), w.scale_factor()) else { continue };
        let (x0, y0, x1) = (pos.x as f64, pos.y as f64, pos.x as f64 + size.width as f64);
        let x = match point {
            Some((px, py)) if px >= x0 && px < x1 && py >= y0 - 50.0 && py < y0 + size.height as f64 => (px - x0) / scale,
            Some(_) => continue,
            None => size.width as f64 / scale - 120.0,
        };
        activate(app, w.label(), true);
        to_overlay(w, &json!({ "kind": "intro", "x": x, "text": text }));
        return;
    }
}

// ---------- menu bar icon ----------

/// The "Wave" icon: the Sidekick waving a floating mitt, as a 12×12 LED grid.
#[cfg(target_os = "macos")]
const TRAY_ART: [&str; 12] = [
    "............",
    "..........#.",
    ".........###",
    "..........#.",
    "..####......",
    ".######.....",
    "##.##.##....",
    "##.##.##....",
    "########....",
    ".######.....",
    "..####......",
    "............",
];

/// Renders the grid as LED dots (2 px on a 3 px pitch, 36 px = 18 pt at 2x). Black on transparent, used
/// as a template image so macOS tints it for light, dark and highlighted menu bars.
#[cfg(target_os = "macos")]
fn tray_image() -> tauri::image::Image<'static> {
    const PITCH: usize = 3;
    const DOT: usize = 2;
    let n = TRAY_ART.len() * PITCH;
    let mut rgba = vec![0u8; n * n * 4];
    for (y, row) in TRAY_ART.iter().enumerate() {
        for (x, c) in row.chars().enumerate() {
            if c != '#' {
                continue;
            }
            for dy in 0..DOT {
                for dx in 0..DOT {
                    let i = ((y * PITCH + dy) * n + x * PITCH + dx) * 4;
                    rgba[i + 3] = 255;
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, n as u32, n as u32)
}

// ---------- setup guide and Settings windows ----------

fn open_onboarding(app: &AppHandle) {
    let p: &'static Panel = &panels::ONBOARDING;
    let fresh = app.get_webview_window(p.label).is_none();
    let opened = panels::open(app, p, |app| {
        ONBOARDING.store(false, Ordering::Relaxed);
        let _ = to_sidecar(app, &json!({ "type": "ob_closed" }));
    });
    if !opened {
        telemetry::record_error("host.error", None, "guide_open_failed", Default::default());
    } else if fresh {
        ONBOARDING.store(true, Ordering::Relaxed);
    }
}

fn open_settings_window(app: &AppHandle) {
    if !panels::open(app, &panels::SETTINGS, |app| {
        let _ = to_sidecar(app, &json!({ "type": "st_closed" }));
    }) {
        telemetry::record_error("host.error", None, "settings_open_failed", Default::default());
    }
}

// ---------- overlays ----------

fn build_overlays(app: &AppHandle) -> tauri::Result<()> {
    for (label, w) in app.webview_windows() {
        if is_overlay(&label) {
            w.destroy()?;
        }
    }
    let gen = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let monitors = app.available_monitors()?;
    let ids = app.state::<Roster>().0.lock().unwrap().clone();
    let agent = ids.iter().any(|id| id == "sidekick");
    let n = monitors.len().max(1);
    let mut home = None;
    // Monitors with no Roamie get an overlay only when something is pointed at there.
    for (i, mon) in monitors.iter().enumerate() {
        let mine: Vec<String> = ids.iter().enumerate().filter(|(j, _)| j % n == i).map(|(_, id)| id.clone()).collect();
        if mine.is_empty() {
            continue;
        }
        let guest = agent && !mine.iter().any(|id| id == "sidekick");
        let w = build_overlay(app, gen, mon, &mine, guest, None)?;
        if agent && !guest {
            home = Some(w.label().to_owned());
        }
    }
    *app.state::<Overlays>().0.lock().unwrap() = OverlaySet { active: home.clone(), home };
    Ok(())
}

fn overlay_label(gen: usize, mon: &tauri::Monitor) -> String {
    let p = mon.position();
    format!("overlay-{gen}-{}_{}", p.x, p.y)
}

/// One click-through overlay covering `mon`. A guest also gets a hidden, inactive Sidekick so the
/// real one can move to this monitor; `pending` is handed to the page before it says it's ready.
fn build_overlay(app: &AppHandle, gen: usize, mon: &tauri::Monitor, ids: &[String], guest: bool, pending: Option<&Value>) -> tauri::Result<WebviewWindow> {
    let mut ids = ids.to_vec();
    if guest && !ids.iter().any(|id| id == "sidekick") {
        ids.push("sidekick".into());
    }
    let only: Vec<String> = ids.iter().map(|id| format!("{id:?}")).collect();
    let mut init = format!("window.ROAMIE_ONLY=[{}];window.ROAMIE_AUTOSOUND=true;window.ROAMIE_UNIT=400;", only.join(","));
    if guest {
        init.push_str("window.ROAMIE_GUEST=true;");
    }
    if let Some(p) = pending {
        init.push_str(&format!("window.ROAMIE_PENDING={p};"));
    }
    let scale = mon.scale_factor();
    let pos = mon.position().to_logical::<f64>(scale);
    let size = mon.size().to_logical::<f64>(scale);
    let w = WebviewWindowBuilder::new(app, overlay_label(gen, mon), WebviewUrl::App("desktop.html".into()))
        .title("Roamies")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .position(pos.x, pos.y)
        .inner_size(size.width, size.height)
        .initialization_script(init)
        .build()?;
    #[cfg(windows)]
    {
        // Logical units land wrong on mixed-DPI setups. Position first: the move can rescale the window.
        let _ = w.set_position(*mon.position());
        let _ = w.set_size(*mon.size());
        exclude_from_capture(&w);
    }
    set_click_through(&w, true);
    Ok(w)
}

/// Keep the overlays (the Sidekick and its bubbles) out of the helper's screenshots.
#[cfg(windows)]
fn exclude_from_capture(w: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
    if let Ok(h) = w.hwnd() {
        unsafe { SetWindowDisplayAffinity(h.0 as _, WDA_EXCLUDEFROMCAPTURE) };
    }
}

/// Edges of a monitor covered by the menu bar, Dock or taskbar, in CSS px, as a JS call.
fn safe_js(mon: &tauri::Monitor) -> String {
    let s = mon.scale_factor();
    let (p, z, wa) = (mon.position(), mon.size(), mon.work_area());
    let top = (wa.position.y - p.y).max(0) as f64 / s;
    let left = (wa.position.x - p.x).max(0) as f64 / s;
    let bottom = ((p.y + z.height as i32) - (wa.position.y + wa.size.height as i32)).max(0) as f64 / s;
    let right = ((p.x + z.width as i32) - (wa.position.x + wa.size.width as i32)).max(0) as f64 / s;
    // origin: this screen's top-left in global points, so the page can place things given in screen
    // coordinates (like the window being captured).
    let (ox, oy) = (p.x as f64 / s, p.y as f64 / s);
    format!("window.__roamieSafe&&__roamieSafe({{top:{top:.0},left:{left:.0},bottom:{bottom:.0},right:{right:.0},ox:{ox:.0},oy:{oy:.0}}})")
}

// ~60 Hz: hand each overlay the cursor in its own CSS pixels. Every ~2 s, refresh the safe area
// (the Dock can move, auto-hide or resize).
fn pump_cursor(app: AppHandle) {
    let mut n: u32 = 0;
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(16));
        n = n.wrapping_add(1);
        let Ok(cur) = app.cursor_position() else { continue };
        for (label, w) in app.webview_windows() {
            if !is_overlay(&label) {
                continue;
            }
            if n % 120 == 1 {
                if let Ok(Some(mon)) = w.current_monitor() {
                    let _ = w.eval(safe_js(&mon));
                }
            }
            let (Ok(pos), Ok(scale)) = (w.inner_position(), w.scale_factor()) else { continue };
            let x = (cur.x - pos.x as f64) / scale;
            let y = (cur.y - pos.y as f64) / scale;
            let _ = w.eval(format!("window.__roamiePtr&&__roamiePtr({x:.1},{y:.1})"));
        }
    });
}

// ---------- tray menu, described by the sidecar as JSON ----------

fn menu_items(app: &AppHandle, items: &[Value]) -> tauri::Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for it in items {
        if it.get("sep").and_then(Value::as_bool) == Some(true) {
            out.push(Box::new(PredefinedMenuItem::separator(app)?));
            continue;
        }
        let label = it.get("label").and_then(Value::as_str).unwrap_or("");
        let id = it.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("sub:{label}"));
        let enabled = it.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if let Some(children) = it.get("items").and_then(Value::as_array) {
            let kids = menu_items(app, children)?;
            let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|b| b.as_ref()).collect();
            out.push(Box::new(Submenu::with_id_and_items(app, id, label, enabled, &refs)?));
        } else if let Some(checked) = it.get("checked").and_then(Value::as_bool) {
            out.push(Box::new(CheckMenuItem::with_id(app, id, label, enabled, checked, None::<&str>)?));
        } else {
            let accel = it.get("accel").and_then(Value::as_str);
            out.push(Box::new(MenuItem::with_id(app, id, label, enabled, accel)?));
        }
    }
    Ok(out)
}

fn set_menu(app: &AppHandle, items: &[Value]) {
    let Some(tray) = app.tray_by_id("roamies") else { return };
    let built = menu_items(app, items).and_then(|kids| {
        let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|b| b.as_ref()).collect();
        Menu::with_items(app, &refs)
    });
    match built {
        Ok(menu) => { let _ = tray.set_menu(Some(menu)); }
        Err(e) => {
            telemetry::record_error("host.error", None, "menu_build_failed", Default::default());
            eprintln!("menu build failed: {e}");
        }
    }
}

fn fallback_menu(app: &AppHandle, status: &str) {
    set_menu(app, &[
        json!({ "id": "status", "label": status, "enabled": false }),
        json!({ "sep": true }),
        json!({ "id": "restart", "label": "Restart Sidekick" }),
        json!({ "id": "quit", "label": "Quit Roamies" }),
    ]);
}

// ---------- bundled helpers ----------

/// A bundled helper next to the app binary (Contents/MacOS on macOS).
fn helper_binary(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
    p.is_file().then_some(p)
}

fn log_stdio(name: &str) -> Stdio {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".gg").join(name))
        .and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok())
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null)
}

/// Open at Login. Only an installed copy registers (in Applications on macOS, not a build folder or the DMG),
/// so stray copies never end up starting at login. `set`: None just reports. Replies login_item_status.
fn login_item(app: &AppHandle, set: Option<bool>) {
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_s = exe.to_string_lossy().replace('\\', "/");
    let installed = !exe_s.contains("/target/") && !exe_s.starts_with("/Volumes/") && !exe_s.contains("/AppTranslocation/");
    #[cfg(target_os = "macos")]
    let (supported, on, approval) = {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        let in_apps = exe_s.starts_with("/Applications/") || exe_s.contains("/Applications/Roamies.app/");
        if !objc2::available!(macos = 13.0) || !installed || !in_apps {
            (false, false, false)
        } else {
            // SAFETY: ServiceManagement calls with no arguments beyond the shared main-app service.
            unsafe {
                let svc = SMAppService::mainAppService();
                match set {
                    Some(true) if svc.status() != SMAppServiceStatus::Enabled => { let _ = svc.registerAndReturnError(); }
                    Some(false) if svc.status() != SMAppServiceStatus::NotRegistered => { let _ = svc.unregisterAndReturnError(); }
                    _ => {}
                }
                let st = svc.status();
                (true, st == SMAppServiceStatus::Enabled || st == SMAppServiceStatus::RequiresApproval, st == SMAppServiceStatus::RequiresApproval)
            }
        }
    };
    #[cfg(windows)]
    let (supported, on, approval) = {
        // The per-user Run key: what Task Manager's Startup apps lists and can switch off.
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let reg = |args: &[&str]| hide_console(&mut Command::new("reg")).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        if !installed {
            (false, false, false)
        } else {
            match set {
                Some(true) => { let v = format!("\"{}\"", exe.display()); reg(&["add", KEY, "/v", "Roamies", "/t", "REG_SZ", "/d", &v, "/f"]); }
                Some(false) => { reg(&["delete", KEY, "/v", "Roamies", "/f"]); }
                None => {}
            }
            (true, reg(&["query", KEY, "/v", "Roamies"]), false)
        }
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let (supported, on, approval) = { let _ = (set, installed); (false, false, false) };
    to_sidecar(app, &json!({ "type": "login_item_status", "supported": supported, "on": on, "approval": approval }));
}

/// Checks the signed update feed (latest.json on the newest GitHub release). With `install`, downloads,
/// verifies the signature, swaps the app in place and restarts. Progress goes to the sidecar as update_status.
fn update(app: &AppHandle, install: bool) {
    use tauri_plugin_updater::UpdaterExt;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = |state: &str, extra: Value| {
            let mut m = json!({ "type": "update_status", "state": state });
            if let (Some(m), Some(e)) = (m.as_object_mut(), extra.as_object()) {
                m.extend(e.clone());
            }
            to_sidecar(&app, &m);
        };
        let check = telemetry::start("host.update_check", None, None, Default::default());
        let found = match app.updater() {
            Ok(u) => u.check().await,
            Err(e) => Err(e),
        };
        match &found {
            Ok(u) => telemetry::end(check, telemetry::Outcome::Ok, None, telemetry::attrs(json!({ "found": u.is_some() }))),
            Err(_) => telemetry::end(check, telemetry::Outcome::Error, Some("update_check_failed"), Default::default()),
        }
        match found {
            Ok(None) => status("none", json!({})),
            Ok(Some(u)) if !install => status("available", json!({ "version": u.version })),
            Ok(Some(u)) => {
                status("downloading", json!({ "version": u.version }));
                let dl = telemetry::start("host.update_download", None, None, Default::default());
                let done = u.download_and_install(|_, _| {}, || {}).await;
                match &done {
                    Ok(()) => telemetry::end(dl, telemetry::Outcome::Ok, None, Default::default()),
                    Err(_) => telemetry::end(dl, telemetry::Outcome::Error, Some("update_download_failed"), Default::default()),
                }
                match done {
                    Ok(()) => {
                        status("installed", json!({ "version": u.version }));
                        tokio_sleep(Duration::from_millis(1500)).await;
                        app.restart();
                    }
                    Err(e) => status("error", json!({ "error": e.to_string() })),
                }
            }
            Err(e) => status("error", json!({ "error": e.to_string() })),
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || thread::sleep(d)).await;
}

fn handle_sidecar(app: &AppHandle, msg: Value) {
    match msg.get("type").and_then(Value::as_str) {
        Some("update") => update(app, msg.get("install").and_then(Value::as_bool) == Some(true)),
        Some("login_item") => login_item(app, msg.get("on").and_then(Value::as_bool)),
        Some("memory_probe") => {
            let _ = to_sidecar(app, &memory(app));
        }
        Some("menu") => {
            if let Some(items) = msg.get("items").and_then(Value::as_array) {
                set_menu(app, items);
            }
        }
        Some("ui") => {
            if let Some(m) = msg.get("msg") {
                to_overlays(app, m);
            }
        }
        Some("onboard") => {
            if let Some(m) = msg.get("msg") {
                to_onboarding(app, m);
            }
        }
        Some("onboarding") => open_onboarding(app),
        Some("settings") => {
            if let Some(m) = msg.get("msg") {
                panels::send(app, &panels::SETTINGS, "__settings", m);
            }
        }
        Some("settings_window") => open_settings_window(app),
        Some("tray_tooltip") => {
            if let (Some(text), Some(tray)) = (msg.get("text").and_then(Value::as_str), app.tray_by_id("roamies")) {
                let _ = tray.set_tooltip(Some(text));
            }
        }
        Some("keybinds") => {
            for (slot, which) in [(0usize, "summon"), (1, "snap"), (2, "list")] {
                if which == "snap" && !cfg!(target_os = "macos") {
                    continue;
                }
                if let Some(accel) = msg.get(which).and_then(Value::as_str) {
                    if let Err(e) = set_hotkey(slot, accel) {
                        eprintln!("{which} shortcut {accel}: {e}");
                        telemetry::record_error("host.shortcut", None, "shortcut_taken", telemetry::attrs(json!({ "which": which })));
                        to_sidecar(app, &json!({ "type": "keybind_error", "which": which, "accel": accel, "error": e }));
                    }
                }
            }
            if let Some(mods) = msg.get("talk").and_then(Value::as_array) {
                let mods: Vec<String> = mods.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect();
                if mods.len() == 2 {
                    *app.state::<TalkChord>().0.lock().unwrap() = mods.clone();
                    to_voice(app, &json!({ "cmd": "chord", "mods": mods }));
                }
            }
        }
        // Listen right away, hands-free (after an area snap: snap, then just talk).
        Some("listen") => voice::listen(app),
        Some("dictation_paste") | Some("dictation_copy") => {
            let text = msg.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
            let rid = msg.get("request_id").and_then(Value::as_str).filter(|r| telemetry::is_request_id(r)).map(str::to_owned);
            if msg.get("type").and_then(Value::as_str) == Some("dictation_paste") {
                dictation::paste(app, text, rid);
            } else {
                dictation::copy_only(app, text, rid);
            }
        }
        Some("voice_config") => {
            DICTATION.store(msg.get("mode").and_then(Value::as_str) == Some("dictation"), Ordering::Relaxed);
            let want = voice::Want {
                engine: msg.get("engine").and_then(Value::as_str).map(str::to_owned),
                model: msg.get("model").and_then(Value::as_str).map(str::to_owned),
                ready: msg.get("ready").and_then(Value::as_bool).unwrap_or(false),
            };
            let wanted = app.state::<VoiceWant>();
            let changed = {
                let mut slot = wanted.0.lock().unwrap();
                let changed = *slot != want;
                *slot = want;
                changed
            };
            // The helper picks its engine and model at launch, so a switch or a finished download restarts it.
            if changed {
                stop_voice(app);
            }
            if msg.get("enabled").and_then(Value::as_bool) == Some(true) {
                app.state::<Voice>().1.reset();
                start_voice(app);
                let mute = msg.get("mute").and_then(Value::as_bool).unwrap_or(true);
                to_voice(app, &json!({ "cmd": "mute", "on": mute }));
            } else {
                stop_voice(app);
            }
            voice::shadow::sync(app, voice::shadow::want_from(&msg));
        }
        Some("telemetry_config") => {
            let on = msg.get("on").and_then(Value::as_bool).unwrap_or(true);
            telemetry::TEL.set_enabled(on);
            to_voice(app, &json!({ "cmd": "telemetry", "on": on }));
            to_overlays(app, &json!({ "kind": "telemetry", "on": on }));
        }
        Some("overlays") => {
            let ids: Vec<String> = msg.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
            let state = app.state::<Roster>();
            let changed = {
                let mut roster = state.0.lock().unwrap();
                let changed = *roster != ids;
                *roster = ids;
                changed
            };
            if changed {
                let _ = build_overlays(app);
            }
        }
        _ => {}
    }
}

fn main() {
    lifecycle::mark_process_start();
    tauri::Builder::default()
        // Must be the first plugin. A second launch (say, straight from the DMG) quits and summons this one instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || to_overlays(&app2, &json!({ "kind": "summon" })));
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sidecar(Mutex::new(None)))
        .manage(Roster(Mutex::new(vec!["sidekick".into()])))
        .manage(Overlays::default())
        .manage(Voice(Mutex::new(None), lifecycle::Restarts::new()))
        .manage(TalkChord(Mutex::new(vec!["control".into(), "option".into()])))
        .manage(VoiceWant(Mutex::new(voice::Want::default())))
        .invoke_handler(tauri::generate_handler![set_hot, sidecar_send, set_typing, perm_status, perm_request, open_settings, onboarding_finish, relaunch, focus_guide, show_settings, drag_window])
        .on_menu_event(|app, e| match e.id.as_ref() {
            "quit" => app.exit(0),
            "restart" => spawn_sidecar(app),
            id => {
                let _ = to_sidecar(app, &json!({ "type": "menu", "id": id }));
            }
        })
        .setup(|app| {
            // Until the sidecar is up (or while it's down) host events wait in the backlog.
            let tel_app = app.handle().clone();
            telemetry::TEL.set_sink(move |e| {
                let mut msg = json!({ "type": "telemetry", "events": [e] });
                if !to_sidecar(&tel_app, &msg) {
                    lifecycle::hold(msg["events"][0].take());
                }
            });
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                // Hidden (no Dock, no visible menu bar) but gives text fields Cmd+V/C/X/A/Z.
                app.set_menu(Menu::default(app.handle())?)?;
            }

            let starting = MenuItem::with_id(app, "status", "Starting Sidekick…", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Roamies", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&starting, &quit])?;
            let mut tray = TrayIconBuilder::with_id("roamies").tooltip("Roamies").menu(&menu);
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon(tray_image()).icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let cold = telemetry::start_at("host.cold_start", None, None, lifecycle::process_start(), Default::default());
            telemetry::end(cold, telemetry::Outcome::Ok, None, Default::default());
            init_hotkeys(app.handle());
            if let Err(e) = set_hotkey(0, "Control+Alt+KeyS") {
                eprintln!("could not register the show/hide shortcut: {e}");
            }
            #[cfg(target_os = "macos")]
            if let Err(e) = set_hotkey(1, "Control+Alt+KeyA") {
                eprintln!("could not register the area shortcut: {e}");
            }
            build_overlays(app.handle())?;
            pump_cursor(app.handle().clone());
            #[cfg(target_os = "macos")]
            snapshot::watch_screenshots(app.handle().clone());
            spawn_sidecar(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Roamies");
}

#[cfg(test)]
mod tests {
    use super::may_toggle_click_through;

    #[test]
    fn click_through_only_on_visible_windows() {
        assert!(may_toggle_click_through(Some(true)));
        assert!(!may_toggle_click_through(Some(false)));
        assert!(!may_toggle_click_through(None));
    }
}
