// Runs the built roamies-hands binary like the sidecar does: arguments in, one JSON object on the last line.
use serde_json::Value;
use std::process::Command;
use std::time::{Duration, Instant};

fn hands(args: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_roamies-hands")).args(args).output().expect("helper runs");
    assert!(out.status.success(), "exit status {:?}", out.status);
    let stdout = String::from_utf8(out.stdout).expect("utf-8 output");
    let last = stdout.lines().last().expect("one line of output");
    serde_json::from_str(last).unwrap_or_else(|e| panic!("not JSON ({e}): {last}"))
}

#[test]
fn usage_errors_are_json_with_a_code() {
    for args in [&[][..], &["nope"], &["capture", "out.jpg"], &["ui", "screen"], &["find-text", "front"], &["act", "{}"]] {
        let v = hands(args);
        assert_eq!(v["ok"], false, "{args:?}");
        assert_eq!(v["code"], "usage", "{args:?}");
        assert!(v["error"].as_str().is_some_and(|e| !e.is_empty()));
    }
}

#[cfg(windows)]
mod on_windows {
    use super::*;

    #[test]
    fn windows_lists_units_and_monitors() {
        let v = hands(&["windows"]);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["unit"], "px");
        assert!(v["windows"].is_array());
        let mons = v["monitors"].as_array().expect("monitors");
        assert!(mons.iter().all(|m| m["bounds"].as_array().is_some_and(|b| b.len() == 4) && m["scale"].as_f64().is_some_and(|s| s > 0.0)));
        for w in v["windows"].as_array().unwrap() {
            let name = w["app"].as_str().unwrap_or("").to_lowercase();
            assert!(!name.starts_with("roamies"), "Roamies lists itself: {w}");
        }
    }

    #[test]
    fn locate_screen() {
        let v = hands(&["locate", "screen"]);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["what"], "screen");
        assert_eq!(v["unit"], "px");
    }

    #[test]
    fn missing_app_is_not_found() {
        let v = hands(&["find-text", "app:no-such-app-roamies-test", "hello"]);
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "not_found");
    }

    #[test]
    fn a_tiny_budget_answers_fast() {
        let start = Instant::now();
        let v = hands(&["find-text", "screen", "x", "--budget-ms", "1"]);
        assert!(start.elapsed() < Duration::from_secs(2), "took {:?}", start.elapsed());
        let partial = v["partial"] == true;
        let done = v["ok"] == true;
        let empty_screen = v["code"] == "not_found" || v["code"] == "timeout";
        assert!(partial || done || empty_screen, "{v}");
    }

    #[test]
    fn hands_off_apps_are_refused() {
        // Any real window, pretending to be a password manager.
        let v = hands(&["windows"]);
        let Some(w) = v["windows"].as_array().and_then(|ws| ws.first().cloned()) else { return };
        let id = format!("window:{}", w["id"]);
        for args in [vec!["ui", id.as_str()], vec!["capture", "out.jpg", id.as_str()], vec!["find-text", id.as_str(), "x"]] {
            let mut a = args.clone();
            a.extend(["--fake-exe", "KeePassXC.exe"]);
            let r = hands(&a);
            assert_eq!(r["code"], "hands_off", "{args:?}: {r}");
        }
    }

    // Local check: opens Notepad on a file with a known sentence and finds it. Run with --ignored.
    #[test]
    #[ignore]
    fn finds_known_text_in_notepad() {
        let file = std::env::temp_dir().join("roamies-hands-test.txt");
        std::fs::write(&file, "The quick brown roamie jumps over the lazy dog.\n").unwrap();
        let mut np = Command::new("notepad.exe").arg(&file).spawn().expect("notepad starts");
        std::thread::sleep(Duration::from_secs(3));
        let v = hands(&["find-text", "app:Notepad", "brown roamie jumps"]);
        let _ = np.kill();
        let _ = np.wait();
        assert_eq!(v["ok"], true, "{v}");
        let m = &v["matches"][0];
        assert!(m["text"].as_str().unwrap_or("").contains("brown roamie jumps"), "{v}");
        assert!(m["bounds"][2].as_i64().unwrap_or(0) > 0, "{v}");
    }
}
