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
    for args in [&[][..], &["nope"], &["capture", "out.jpg"], &["ui", "screen"], &["find-text", "front"], &["act"], &["act", "{}"], &["act", "not json"], &["act", r#"{"steps":[{"do":"fly"}]}"#]] {
        let v = hands(args);
        assert_eq!(v["ok"], false, "{args:?}");
        assert_eq!(v["code"], "usage", "{args:?}");
        assert!(v["error"].as_str().is_some_and(|e| !e.is_empty()));
    }
}

#[test]
fn act_errors_say_what_was_done() {
    for (plan, code) in [
        (r#"{"steps":[{"do":"key","key":"win+l"}]}"#, "blocked_key"),
        (r#"{"steps":[{"do":"key","key":"alt+shift+tab"}]}"#, "blocked_key"),
        (r#"{"steps":[{"do":"key","key":"ctrl+alt+delete"}]}"#, "blocked_key"),
        (r#"{"steps":[{"do":"click_at"}]}"#, "usage"),
    ] {
        let v = hands(&["act", plan]);
        assert_eq!((&v["ok"], v["code"].as_str()), (&Value::Bool(false), Some(code)), "{plan}: {v}");
        assert_eq!(v["done"], serde_json::json!([]), "{plan}: {v}");
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
    fn ocr_file_reads_the_fixture() {
        let png = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ocr.png");
        let v = hands(&["ocr-file", png, "--origin", "-1920,240"]);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["source"], "ocr");
        assert!(v["ocrMs"].as_u64().is_some());
        let words: Vec<&str> = v["lines"].as_array().unwrap().iter().flat_map(|l| l["words"].as_array().unwrap()).filter_map(|w| w["text"].as_str()).collect();
        for want in ["Roamies", "4821", "Settings", "Close"] {
            assert!(words.contains(&want), "{want} missing from {words:?}");
        }
        let first = &v["lines"][0]["bounds"];
        assert!(first[0].as_i64().unwrap() < -1800 && first[1].as_i64().unwrap() > 240, "origin not applied: {first}");
    }

    #[test]
    fn image_crops_resizes_and_draws_marks() {
        let png = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ocr.png");
        let dir = std::env::temp_dir().join(format!("roamies-hands-image-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (out, marks) = (dir.join("out.jpg"), dir.join("marks.json"));
        std::fs::write(&marks, r#"[{"n": 1, "rect": [20, 30, 120, 40]}, {"n": 12, "rect": [200, 100, 80, 60]}]"#).unwrap();
        let v = hands(&["image", png, out.to_str().unwrap(), "--crop", "100,50,640,200", "--size", "960,300", "--marks", marks.to_str().unwrap()]);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["sent"], serde_json::json!([960, 300]));
        let jpg = std::fs::read(&out).expect("JPEG written");
        assert_eq!(&jpg[..2], &[0xFF, 0xD8], "JPEG magic");
        // A bad marks file and an off-image crop are clear errors.
        std::fs::write(&marks, "[{\"n\": 0}]").unwrap();
        assert_eq!(hands(&["image", png, out.to_str().unwrap(), "--marks", marks.to_str().unwrap()])["code"], "usage");
        assert_eq!(hands(&["image", png, out.to_str().unwrap(), "--crop", "5000,0,10,10"])["code"], "usage");
        assert_eq!(hands(&["image", "nope.png", out.to_str().unwrap()])["code"], "not_found");
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn act_refuses_hands_off_and_terminals_before_any_input() {
        let v = hands(&["windows"]);
        let Some(w) = v["windows"].as_array().and_then(|ws| ws.first().cloned()) else { return };
        let plan = format!(r#"{{"window": {}, "steps": [{{"do": "type", "text": "x"}}]}}"#, w["id"]);
        for exe in ["KeePassXC.exe", "cmd.exe", "powershell.exe", "WindowsTerminal.exe"] {
            let r = hands(&["act", plan.as_str(), "--fake-exe", exe]);
            assert_eq!(r["code"], "hands_off", "{exe}: {r}");
            assert_eq!(r["done"], serde_json::json!([]), "{exe}: {r}");
        }
        let r = hands(&["act", r#"{"app": "no-such-app-roamies-test", "steps": [{"do": "wait", "seconds": 0}]}"#]);
        assert_eq!((r["code"].as_str(), &r["done"]), (Some("not_found"), &serde_json::json!([])), "{r}");
    }

    fn window_titled(title: &str) -> Option<Value> {
        let v = hands(&["windows"]);
        v["windows"].as_array()?.iter().find(|w| w["title"].as_str().is_some_and(|t| t.contains(title))).cloned()
    }

    fn wait_for_window(title: &str) -> Value {
        let end = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(w) = window_titled(title) {
                return w;
            }
            assert!(Instant::now() < end, "no window titled {title}");
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    // Local check: fills Notepad's editor and reads it back. Moves the mouse and types. Run with --ignored.
    #[test]
    #[ignore]
    fn act_fills_notepad() {
        let file = std::env::temp_dir().join("roamies-act-test.txt");
        std::fs::write(&file, "before
").unwrap();
        let mut np = Command::new("notepad.exe").arg(&file).spawn().expect("notepad starts");
        let w = wait_for_window("roamies-act-test");
        std::thread::sleep(Duration::from_secs(1));
        let plan = format!(r#"{{"window": {}, "steps": [{{"do": "fill", "text": "Typed by roamies act 42"}}]}}"#, w["id"]);
        let v = hands(&["act", plan.as_str()]);
        let id = format!("window:{}", w["id"]);
        let seen = hands(&["find-text", id.as_str(), "Typed by roamies act 42"]);
        let _ = np.kill();
        let _ = np.wait();
        let _ = std::fs::remove_file(&file);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["done"].as_array().map(Vec::len), Some(1), "{v}");
        assert!(v["controls"].is_array() && v["texts"].is_array(), "{v}");
        assert_eq!(seen["ok"], true, "{seen}");
    }

    // Local check: a WinForms window with a text box and a button that retitles the form. Run with --ignored.
    // Its own exe (built with the C# compiler in Windows): a PowerShell-hosted form is refused as PowerShell.
    #[test]
    #[ignore]
    fn act_fills_and_clicks_a_test_window() {
        let src = r#"using System.Windows.Forms;
class F { [System.STAThread] static void Main() {
  var f = new Form { Text = "Roamies act test", Width = 420, Height = 200 };
  var l = new Label { Text = "Name", Left = 10, Top = 14, Width = 60 };
  var t = new TextBox { Left = 80, Top = 10, Width = 250, AccessibleName = "Name" };
  var b = new Button { Text = "Press me", Left = 80, Top = 50, Width = 120 };
  b.Click += (s, e) => f.Text = "Pressed " + t.Text;
  f.Controls.AddRange(new Control[] { l, t, b }); Application.Run(f); } }"#;
        let dir = std::env::temp_dir().join(format!("roamies-act-form-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (cs, exe) = (dir.join("form.cs"), dir.join("roamies-act-form.exe"));
        std::fs::write(&cs, src).unwrap();
        let csc = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe";
        let built = Command::new(csc).args(["/nologo", "/target:winexe"]).arg(format!("/out:{}", exe.display())).arg(&cs).status().expect("csc runs");
        assert!(built.success(), "csc failed");
        let mut ps = Command::new(&exe).spawn().expect("test window starts");
        let w = wait_for_window("Roamies act test");
        std::thread::sleep(Duration::from_millis(500));
        let plan = format!(r#"{{"window": {}, "steps": [{{"do": "fill", "field": "Name", "text": "Ada"}}, {{"do": "click_text", "text": "Press me"}}]}}"#, w["id"]);
        let v = hands(&["act", plan.as_str()]);
        std::thread::sleep(Duration::from_millis(500));
        let after = window_titled("Pressed Ada");
        let _ = ps.kill();
        let _ = ps.wait();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["done"].as_array().map(Vec::len), Some(2), "{v}");
        assert!(after.is_some(), "button didn't run: {v}");
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
