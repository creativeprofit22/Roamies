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

fn all_lines(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON: {l} ({e})")))
        .collect()
}

// Protocol events without the interleaved telemetry lines (checked separately by `telemetry`).
fn events(stdout: &[u8]) -> Vec<Value> {
    all_lines(stdout).into_iter().filter(|e| e["type"] != "telemetry").collect()
}

fn telemetry(stdout: &[u8]) -> Vec<Value> {
    all_lines(stdout).into_iter().filter(|e| e["type"] == "telemetry").map(|e| e["event"].clone()).collect()
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
    let m = &ev[n - 2]["metrics"];
    for k in ["audio_s", "compute_s", "rtf", "warmup_ms", "speech_end_to_final_ms"] {
        assert!(m[k].as_f64().is_some_and(|v| v >= 0.0), "{k}: {m}");
    }
    assert!(m["audio_s"].as_f64().unwrap() > 0.5, "{m}");
    assert_eq!(m["partial_count"], 0, "{m}");
    assert_eq!(m["empty"], false, "{m}");
    // Finish-only engine: no first partial, no revision rate.
    assert!(m["time_to_first_partial_ms"].is_null(), "{m}");
    assert!(m.get("revision_rate").is_none(), "{m}");
    if cfg!(windows) {
        assert!(m["peak_rss_mb"].as_f64().is_some_and(|v| v > 0.0), "{m}");
    }
    assert_eq!(ev[n - 1], json!({"type":"state","state":"idle"}));
    let tel = telemetry(&out.stdout);
    let session: Vec<_> = tel.iter().filter(|e| e["step"] == "voice.session").collect();
    assert_eq!(session.len(), 2, "{tel:?}");
    assert_eq!(session[1]["outcome"], "ok");
    assert!(session.iter().all(|e| e["request_id"] == session[0]["request_id"] && e["component"] == "voice"));
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

// Shadow role: no mic or chord, answers each `transcribe` job with one `shadow` event and never a
// `final`, `partial` or `state`, whatever else it is sent.
#[test]
fn shadow_mode_answers_only_with_shadow_events() {
    let wav = hound::WavReader::open(fixture()).unwrap();
    let samples: Vec<f32> = wav.into_samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
    let pcm = roamies_voice_core::pcm::encode(&samples);
    let mut child = bin()
        .arg("--shadow")
        .arg("--model-dir")
        .arg(model_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = [
        json!({"cmd":"listen","request_id":"r0"}).to_string(),
        json!({"cmd":"transcribe","request_id":"r1","pcm":pcm}).to_string(),
    ];
    child.stdin.take().unwrap().write_all((input.join("\n") + "\n").as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let ev = all_lines(&out.stdout);
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert_eq!(ev[0]["type"], "shadow");
    assert_eq!(ev[0]["request_id"], "r1");
    assert!(ev[0]["text"].as_str().unwrap().to_lowercase().contains("nightfall"), "{}", ev[0]);
    let m = &ev[0]["metrics"];
    assert!(m["time_to_first_partial_ms"].is_null() && m.get("revision_rate").is_none(), "{m}");
}
