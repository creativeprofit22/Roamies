use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_roamies-voice-parakeet"))
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture() -> PathBuf {
    crate_dir().join("tests/fixtures/en-short-1s.wav")
}

fn model_dir() -> PathBuf {
    let dir = crate_dir().join("models").join("parakeet");
    assert!(dir.join("encoder-model.int8.onnx").is_file(), "model missing: run ./fetch-model.sh in voice-win first");
    dir
}

fn events(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON: {l} ({e})")))
        .collect()
}

fn wav_run(model: &PathBuf) -> Output {
    bin().arg("--wav").arg(fixture()).arg("--model-dir").arg(model).stdin(Stdio::null()).output().unwrap()
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("roamies-parakeet-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// Regression: an unpadded short take came back blank (12 of 25 own-voice clips).
#[test]
fn short_clip_is_not_blank() {
    let out = wav_run(&model_dir());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "exit {:?}: {stderr}", out.status);
    let ev = events(&out.stdout);
    let fin = ev.iter().find(|e| e["type"] == "final").unwrap_or_else(|| panic!("no final: {ev:?}"));
    let text = fin["text"].as_str().unwrap().to_lowercase();
    assert!(text.contains("nightfall"), "final: {text}");
}

#[test]
fn wav_run_event_order() {
    let out = wav_run(&model_dir());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "exit {:?}: {stderr}", out.status);
    assert!(!stderr.contains("panic"), "{stderr}");
    let ev = events(&out.stdout);
    assert_eq!(ev[0], json!({"type":"ready","engine":"parakeet","model":"tdt-0.6b-v3-int8","dryRun":true}));
    assert_eq!(ev[1], json!({"type":"state","state":"listening","mode":"handsfree"}));
    let n = ev.len();
    assert!(n >= 6, "{ev:?}");
    assert!(ev[2..n - 3].iter().all(|e| e["type"] == "level" && e["v"].as_f64().is_some_and(|v| (0.0..=1.0).contains(&v))), "{ev:?}");
    assert!(n - 3 > 2, "at least one level");
    assert_eq!(ev[n - 3], json!({"type":"state","state":"processing"}));
    assert_eq!(ev[n - 2]["type"], "final");
    assert_eq!(ev[n - 1], json!({"type":"state","state":"idle"}));
    assert!(!ev.iter().any(|e| e["type"] == "partial"), "Parakeet has no live text");
}

fn assert_unavailable(out: &Output) {
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!stderr.contains("panic"), "{stderr}");
    assert_eq!(out.status.code(), Some(1), "{stderr}");
    let ev = events(&out.stdout);
    assert_eq!(ev[0]["type"], "ready");
    assert!(ev.contains(&json!({"type":"error","code":"unavailable"})), "{ev:?}");
    assert!(!ev.iter().any(|e| e["type"] == "final"));
}

#[test]
fn missing_model_is_unavailable_without_panic() {
    assert_unavailable(&wav_run(&crate_dir().join("no-such-model")));
}

#[test]
fn corrupt_model_is_unavailable_without_panic() {
    let (real, dir) = (model_dir(), temp_dir("corrupt"));
    for f in ["vocab.txt", "decoder_joint-model.int8.onnx"] {
        std::fs::copy(real.join(f), dir.join(f)).unwrap();
    }
    // A download cut short: the first MiB of the real encoder.
    let encoder = std::fs::read(real.join("encoder-model.int8.onnx")).unwrap();
    std::fs::write(dir.join("encoder-model.int8.onnx"), &encoder[..1 << 20]).unwrap();
    let out = wav_run(&dir);
    std::fs::remove_dir_all(&dir).unwrap();
    assert_unavailable(&out);
}

#[test]
fn live_mode_takes_commands_and_exits_when_stdin_closes() {
    let mut child = bin()
        .args(["--chord", "ctrl,alt", "--model-dir"])
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
        writeln!(stdin, r#"{{"cmd":"mute","on":true}}"#).unwrap();
        writeln!(stdin, r#"{{"cmd":"cancel"}}"#).unwrap();
        // Without a model, listen reports unavailable instead of opening the mic.
        writeln!(stdin, r#"{{"cmd":"listen"}}"#).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "exit {:?}: {stderr}", out.status);
    assert!(!stderr.contains("panic"), "{stderr}");
    assert_eq!(
        events(&out.stdout),
        [
            json!({"type":"ready","engine":"parakeet","model":"tdt-0.6b-v3-int8"}),
            json!({"type":"error","code":"unavailable"}),
            json!({"type":"state","state":"idle","cancelled":true}),
        ]
    );
}

#[test]
fn perms_prints_one_line() {
    let out = bin().arg("--perms").stdin(Stdio::null()).output().unwrap();
    assert!(out.status.success());
    let ev = events(&out.stdout);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "perms");
    assert!(ev[0]["mic"] == "granted" || ev[0]["mic"] == "denied", "{}", ev[0]);
    assert!(ev[0]["input"].is_boolean());
}
