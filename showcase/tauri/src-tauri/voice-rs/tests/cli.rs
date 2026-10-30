use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_roamies-voice"))
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn events(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON: {l} ({e})")))
        .collect()
}

#[test]
fn wav_dry_run_transcribes_the_fixture() {
    let models = crate_dir().join("models").join("zipformer");
    assert!(models.join("tokens.txt").is_file(), "model missing: run ./fetch-model.sh in voice-rs first");
    let out = bin()
        .arg("--wav")
        .arg(crate_dir().join("tests/fixtures/en-short.wav"))
        .arg("--model-dir")
        .arg(&models)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "exit {:?}: {stderr}", out.status);
    assert!(!stderr.contains("panic"), "{stderr}");
    let ev = events(&out.stdout);
    assert_eq!(ev[0]["type"], "ready");
    assert_eq!(ev[0]["engine"], "zipformer");
    assert_eq!(ev[1], serde_json::json!({"type":"state","state":"listening","mode":"handsfree"}));
    assert!(ev.iter().any(|e| e["type"] == "partial"));
    assert!(ev.iter().any(|e| e["type"] == "level" && e["v"].as_f64().is_some_and(|v| (0.0..=1.0).contains(&v))));
    let pos = |pred: &dyn Fn(&Value) -> bool| ev.iter().position(pred).unwrap();
    let processing = pos(&|e| e["state"] == "processing");
    let fin = pos(&|e| e["type"] == "final");
    assert!(processing < fin);
    let text = ev[fin]["text"].as_str().unwrap().to_lowercase();
    assert!(text.contains("after early nightfall"), "final: {text}");
    assert_eq!(ev.last().unwrap(), &serde_json::json!({"type":"state","state":"idle"}));
}

#[test]
fn missing_model_is_unavailable_without_panic() {
    let out = bin()
        .arg("--wav")
        .arg(crate_dir().join("tests/fixtures/en-short.wav"))
        .arg("--model-dir")
        .arg(crate_dir().join("no-such-model"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!stderr.contains("panic"), "{stderr}");
    assert_eq!(out.status.code(), Some(1));
    let ev = events(&out.stdout);
    assert_eq!(ev[0]["type"], "ready");
    assert!(ev.contains(&serde_json::json!({"type":"error","code":"unavailable"})));
    assert!(!ev.iter().any(|e| e["type"] == "final"));
}

#[test]
fn live_mode_exits_cleanly_when_stdin_closes() {
    let mut child = bin()
        .arg("--chord")
        .arg("ctrl,alt")
        .arg("--model-dir")
        .arg(crate_dir().join("no-such-model"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        writeln!(stdin, "not json").unwrap();
        writeln!(stdin, r#"{{"cmd":"chord","mods":["ctrl","shift"]}}"#).unwrap();
        writeln!(stdin, r#"{{"cmd":"mute","on":false}}"#).unwrap();
        writeln!(stdin, r#"{{"cmd":"cancel"}}"#).unwrap();
        // Without a model, listen reports unavailable instead of opening the mic.
        writeln!(stdin, r#"{{"cmd":"listen"}}"#).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "exit {:?}: {stderr}", out.status);
    assert!(!stderr.contains("panic"), "{stderr}");
    let ev = events(&out.stdout);
    assert_eq!(ev[0], serde_json::json!({"type":"ready","engine":"zipformer"}));
    assert_eq!(ev[1], serde_json::json!({"type":"error","code":"unavailable"}));
    assert_eq!(ev[2], serde_json::json!({"type":"state","state":"idle","cancelled":true}));
}
