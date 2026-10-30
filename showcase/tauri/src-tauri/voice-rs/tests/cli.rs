use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_roamies-voice-moonshine"))
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
        .args(["--engine", "zipformer"])
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
    assert!(ev[0]["model"].as_str().is_some_and(|m| m.starts_with("encoder-") && m.contains("int8")), "{}", ev[0]);
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
        .args(["--engine", "zipformer"])
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
        .args(["--engine", "zipformer"])
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

fn moonshine_lib() -> PathBuf {
    let name = if cfg!(windows) { "moonshine.dll" } else if cfg!(target_os = "macos") { "libmoonshine.dylib" } else { "libmoonshine.so" };
    crate_dir().join("models").join("moonshine-runtime").join(name)
}

fn moonshine_tiny(extra: &[&std::ffi::OsStr]) -> std::process::Output {
    let models = crate_dir().join("models").join("moonshine-tiny");
    assert!(moonshine_lib().is_file() && models.join("tokenizer.bin").is_file(), "run ./fetch-moonshine.sh tiny in voice-rs first");
    bin()
        .args(["--moonshine-size", "tiny"])  // no --engine: Moonshine is the default
        .arg("--moonshine-lib")
        .arg(moonshine_lib())
        .arg("--model-dir")
        .arg(&models)
        .args(extra)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn moonshine_dry_run_transcribes_the_fixture() {
    let wav = crate_dir().join("tests/fixtures/en-short.wav");
    let out = moonshine_tiny(&["--wav".as_ref(), wav.as_os_str()]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "exit {:?}: {stderr}", out.status);
    assert!(!stderr.contains("panic"), "{stderr}");
    let ev = events(&out.stdout);
    assert_eq!(ev[0], serde_json::json!({"type":"ready","engine":"moonshine","model":"tiny-streaming-en","dryRun":true}));
    assert!(ev.iter().any(|e| e["type"] == "partial"));
    let fin = ev.iter().find(|e| e["type"] == "final").expect("no final");
    let text = fin["text"].as_str().unwrap().to_lowercase();
    assert!(text.contains("nightfall"), "final: {text}");
    assert_eq!(ev.last().unwrap(), &serde_json::json!({"type":"state","state":"idle"}));
}

#[test]
fn missing_moonshine_lib_is_unavailable_without_panic() {
    let out = bin()
        .args(["--engine", "moonshine", "--moonshine-size", "tiny"])
        .arg("--moonshine-lib")
        .arg(crate_dir().join("no-such-lib.dll"))
        .arg("--model-dir")
        .arg(crate_dir().join("models").join("moonshine-tiny"))
        .arg("--wav")
        .arg(crate_dir().join("tests/fixtures/en-short.wav"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!stderr.contains("panic"), "{stderr}");
    assert_eq!(out.status.code(), Some(1));
    let ev = events(&out.stdout);
    assert_eq!(ev[0]["engine"], "moonshine");
    assert!(ev.contains(&serde_json::json!({"type":"error","code":"unavailable"})));
    assert!(!ev.iter().any(|e| e["type"] == "final"));
}

#[test]
fn unknown_engine_is_unavailable() {
    let out = bin().args(["--engine", "bogus"]).stdin(Stdio::null()).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let ev = events(&out.stdout);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "error");
    assert_eq!(ev[0]["code"], "unavailable");
}

#[test]
fn bench_scores_a_wav_txt_pair() {
    let dir = std::env::temp_dir().join(format!("roamies-voice-cli-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(crate_dir().join("tests/fixtures/en-short.wav"), dir.join("clip.wav")).unwrap();
    std::fs::write(dir.join("clip.txt"), "After early nightfall, the yellow lamps would light up here and there.").unwrap();
    let out = moonshine_tiny(&["--bench".as_ref(), dir.as_os_str()]);
    std::fs::remove_dir_all(&dir).unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "exit {:?}: {}", out.status, String::from_utf8_lossy(&out.stderr));
    let summary: Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(summary["engine"], "moonshine");
    assert_eq!(summary["clips"], 1);
    // The reference is a prefix of the fixture, so the tail counts as insertions; WER is still bounded.
    assert!(summary["wer"].as_f64().is_some_and(|w| (0.0..1.0).contains(&w)), "{summary}");
    assert!(summary["ttfpMedianS"].as_f64().is_some_and(|t| t > 0.0), "{summary}");
    assert!(summary["rtfMean"].as_f64().is_some_and(|r| r > 0.0), "{summary}");
    assert!(summary["modelBytes"].as_u64().is_some_and(|b| b > 10_000_000), "{summary}");
    if cfg!(windows) {
        assert!(summary["peakRamBytes"].as_u64().is_some_and(|b| b > 0), "{summary}");
    }
}

#[test]
fn moonshine_defaults_find_fetched_models_without_paths() {
    let out = bin()
        .args(["--moonshine-size", "tiny"])
        .arg("--wav")
        .arg(crate_dir().join("tests/fixtures/en-short.wav"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "exit {:?}: {stderr} (run ./fetch-moonshine.sh tiny first)", out.status);
    let ev = events(&out.stdout);
    assert_eq!(ev[0]["type"], "ready");
    assert_eq!(ev[0]["model"], "tiny-streaming-en", "{}", ev[0]);
    let fin = ev.iter().find(|e| e["type"] == "final").expect("no final event");
    assert!(fin["text"].as_str().unwrap().to_lowercase().contains("nightfall"), "final: {fin}");
}

#[test]
fn perms_prints_one_mic_line() {
    for args in [&["--perms"][..], &["--request", "mic"][..]] {
        let out = bin().args(args).stdin(Stdio::null()).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        let ev = events(&out.stdout);
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!(ev[0]["type"], "perms");
        assert!(["granted", "denied"].contains(&ev[0]["mic"].as_str().unwrap()), "{}", ev[0]);
    }
}
