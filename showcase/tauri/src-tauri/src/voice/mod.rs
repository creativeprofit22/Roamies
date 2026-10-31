// Voice helper (macOS: Apple speech; Windows: the engine picked in the tray, see engines.rs) and the global shortcuts.

pub(crate) mod engines;

use super::*;
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::process::Child;
use std::sync::atomic::AtomicU32;
use std::time::Instant;

/// Id of the registered show/hide hotkey, read by the hotkey event handler.
static SUMMON_ID: AtomicU32 = AtomicU32::new(0);
/// Id of the registered "ask about an area" hotkey.
static SNAP_ID: AtomicU32 = AtomicU32::new(0);
static LIST_ID: AtomicU32 = AtomicU32::new(0);

thread_local! {
    // The hotkey manager must live on the main thread; it also owns the current show/hide hotkey.
    static HOTKEYS: RefCell<Option<(global_hotkey::GlobalHotKeyManager, [Option<global_hotkey::hotkey::HotKey>; 3])>> = const { RefCell::new(None) };
}

/// Whether the running helper streams partial text (tagged onto the `state` events the UIs get).
static STREAMING: AtomicBool = AtomicBool::new(true);

/// Which engine the sidecar wants and where its model is. `engine` is None on macOS (Apple speech).
#[derive(Clone, Default, PartialEq)]
pub(crate) struct Want {
    pub engine: Option<String>,
    pub model: Option<String>,
    pub ready: bool,
}

/// The helper for an engine id (unknown or none: the registry default). macOS has one helper, no engines.
fn voice_binary(engine: Option<&str>) -> Option<(PathBuf, Option<&'static engines::Engine>)> {
    if !cfg!(windows) {
        return helper_binary("roamies-voice").map(|b| (b, None));
    }
    let e = engine.and_then(engines::get).or_else(|| engines::get(engines::default_id()))?;
    helper_binary(&e.helper).map(|b| (b, Some(e)))
}

/// Any installed helper answers `--perms` (Windows: the first registry engine that's there).
pub(crate) fn perms_binary() -> Option<PathBuf> {
    if !cfg!(windows) {
        return helper_binary("roamies-voice");
    }
    engines::all().iter().find_map(|e| helper_binary(&e.helper))
}

/// Start/stop lines in the helper's log, so an engine switch can be checked after the fact.
fn voice_log(line: &str) {
    let path = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|h| PathBuf::from(h).join(".gg").join("sidekick-voice.log"));
    if let Some(mut f) = path.and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok()) {
        let _ = writeln!(f, "[host] {line}");
    }
}

fn is_current(app: &AppHandle, pid: u32) -> bool {
    app.state::<Voice>().0.lock().unwrap().as_ref().map(Child::id) == Some(pid)
}

pub(crate) fn start_voice(app: &AppHandle) {
    let state = app.state::<Voice>();
    if state.0.lock().unwrap().is_some() {
        return;
    }
    let want = app.state::<VoiceWant>().0.lock().unwrap().clone();
    let Some((bin, engine)) = voice_binary(want.engine.as_deref()) else {
        eprintln!("voice helper not found next to the app binary");
        return;
    };
    let chord = app.state::<TalkChord>().0.lock().unwrap().join(",");
    // Without a verified model the helper still runs and reports `unavailable` on a press.
    let model = want.model.as_deref().filter(|_| want.ready);
    let args = match (engine, bin.parent()) {
        (Some(e), Some(dir)) => engines::args(e, dir, model),
        _ => Vec::new(),
    };
    STREAMING.store(engine.is_none_or(|e| e.streaming), Ordering::Relaxed);
    let mut cmd = Command::new(&bin);
    cmd.arg("--chord").arg(chord).args(args);
    let mut child = match hide_console(&mut cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log_stdio("sidekick-voice.log")).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("voice helper failed to start: {e}");
            return;
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let pid = child.id();
    *state.0.lock().unwrap() = Some(child);
    voice_log(&format!("start {} pid {pid} model {}", engine.map_or("apple", |e| e.id.as_str()), model.unwrap_or("-")));
    let app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            // A helper being retired (engine switch, stop) must not send stale partials or finals.
            if !is_current(&app, pid) {
                continue;
            }
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || handle_voice(&app2, msg));
        }
        // Exited. If it is still the wanted helper, it died on its own: retry a few times.
        let state = app.state::<Voice>();
        let ours = {
            let mut slot = state.0.lock().unwrap();
            let ours = slot.as_ref().map(Child::id) == Some(pid);
            if ours {
                if let Some(mut c) = slot.take() {
                    let _ = c.wait();
                }
            }
            ours
        };
        if ours && state.1.fetch_add(1, Ordering::Relaxed) < 3 {
            thread::sleep(Duration::from_secs(1));
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || start_voice(&app2));
        }
    });
}

pub(crate) fn stop_voice(app: &AppHandle) {
    let state = app.state::<Voice>();
    let child = state.0.lock().unwrap().take();
    if let Some(mut c) = child {
        // Closing stdin makes the helper leave its loop and release the mic; kill it only if it hangs.
        drop(c.stdin.take());
        let pid = c.id();
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let clean = loop {
                match c.try_wait() {
                    Ok(Some(_)) => break true,
                    Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                    _ => break false,
                }
            };
            if !clean {
                let _ = c.kill();
                let _ = c.wait();
            }
            voice_log(&format!("stop pid {pid} {}", if clean { "exited" } else { "killed" }));
        });
    }
    to_overlays(app, &json!({ "kind": "voice", "type": "state", "state": "idle" }));
}

pub(crate) fn to_voice(app: &AppHandle, msg: &Value) {
    if let Some(child) = app.state::<Voice>().0.lock().unwrap().as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = writeln!(stdin, "{msg}");
        }
    }
}

/// Tell the voice helper to drop a talk-chord press that turned out to be the show/hide shortcut.
fn cancel_voice(app: &AppHandle) {
    to_voice(app, &json!({ "cmd": "cancel" }));
}

/// Show/hide shortcut (default ⌃⌥S): brings the sidekick forward, or sends it away if it's out.
/// Must run on the main thread.
pub(crate) fn init_hotkeys(app: &AppHandle) {
    use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
    match GlobalHotKeyManager::new() {
        Ok(m) => HOTKEYS.with(|h| *h.borrow_mut() = Some((m, [None, None, None]))),
        Err(e) => return eprintln!("hotkeys unavailable: {e}"),
    }
    let app = app.clone();
    GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| {
        if e.state() != HotKeyState::Pressed {
            return;
        }
        let summon = e.id() == SUMMON_ID.load(Ordering::Relaxed);
        let snap = e.id() == SNAP_ID.load(Ordering::Relaxed);
        let list = e.id() == LIST_ID.load(Ordering::Relaxed);
        if !summon && !snap && !list {
            return;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Both shortcuts share modifiers with the talk chord; that press wasn't a request to talk.
            cancel_voice(&app2);
            if summon {
                to_overlays(&app2, &json!({ "kind": "summon" }));
            } else if list {
                to_sidecar(&app2, &json!({ "type": "show_list" }));
            } else {
                to_sidecar(&app2, &json!({ "type": "snap" }));
            }
        });
    }));
}

/// Swaps one global shortcut (0 = show/hide, 1 = ask about an area, 2 = show the list). On failure (bad format, or
/// another app owns it) the old one stays.
pub(crate) fn set_hotkey(slot: usize, accel: &str) -> Result<(), String> {
    use global_hotkey::hotkey::HotKey;
    let new: HotKey = accel.parse().map_err(|e| format!("{e}"))?;
    let id_slot = [&SUMMON_ID, &SNAP_ID, &LIST_ID][slot];
    HOTKEYS.with(|h| {
        let mut h = h.borrow_mut();
        let Some((manager, keys)) = h.as_mut() else { return Err("hotkeys unavailable".to_string()) };
        let current = keys[slot];
        if current.map(|c| c.id()) == Some(new.id()) {
            return Ok(());
        }
        if keys.iter().enumerate().any(|(i, k)| i != slot && k.map(|c| c.id()) == Some(new.id())) {
            return Err("already used by the other Roamies shortcut".to_string());
        }
        if let Some(old) = current {
            let _ = manager.unregister(old);
        }
        match manager.register(new) {
            Ok(()) => {
                keys[slot] = Some(new);
                id_slot.store(new.id(), Ordering::Relaxed);
                Ok(())
            }
            Err(e) => {
                if let Some(old) = current {
                    let _ = manager.register(old);
                }
                Err(format!("{e}"))
            }
        }
    })
}

// Both the overlays and the setup guide need `streaming` to word non-streaming engines honestly.
fn ui_message(msg: &Value, streaming: bool) -> Value {
    let mut ui = msg.clone();
    ui["kind"] = json!("voice");
    if msg.get("type").and_then(Value::as_str) == Some("state") {
        ui["streaming"] = json!(streaming);
    }
    ui
}

fn handle_voice(app: &AppHandle, msg: Value) {
    if msg.get("type").and_then(Value::as_str) == Some("ready") {
        app.state::<Voice>().1.store(0, Ordering::Relaxed);
        return;
    }
    let ui = ui_message(&msg, STREAMING.load(Ordering::Relaxed));
    // While the setup guide is open, talking is just the "try it" test: it never reaches the agent.
    if ONBOARDING.load(Ordering::Relaxed) {
        to_onboarding(app, &ui);
        return;
    }
    match msg.get("type").and_then(Value::as_str) {
        Some("state") => {
            to_overlays(app, &ui);
            to_sidecar(app, &json!({ "type": "voice_state", "state": msg.get("state") }));
        }
        Some("partial") | Some("level") => to_overlays(app, &ui),
        Some("final") => {
            to_overlays(app, &ui);
            if DICTATION.load(Ordering::Relaxed) {
                dictation::on_final(app, msg.get("text").and_then(Value::as_str).unwrap_or(""));
            } else {
                to_sidecar(app, &json!({ "type": "voice", "text": msg.get("text") }));
            }
        }
        Some("error") => {
            let mut m = msg.clone();
            m["type"] = json!("voice_error");
            to_sidecar(app, &m);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_messages_carry_streaming_flag() {
        let ui = ui_message(&json!({ "type": "state", "state": "listening" }), false);
        assert_eq!(ui["streaming"], json!(false));
        assert_eq!(ui["kind"], json!("voice"));
        let ui = ui_message(&json!({ "type": "partial", "text": "hi" }), false);
        assert!(ui.get("streaming").is_none());
    }
}
