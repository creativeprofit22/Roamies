//! `--bench <dir>`: reads every `name.wav` + `name.txt` pair with Parakeet and prints WER (scored
//! like voice-rs), blank clips, finish latency, real-time factor, model size and peak RAM.

use crate::audio::read_wav;
use roamies_voice_core::engine::{SpeechEngine, SAMPLE_RATE};
use roamies_voice_core::score::{dir_bytes, find_pairs, normalize, word_alignment, Edits};
use serde_json::json;
use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub struct ClipResult {
    pub audio_s: f64,
    pub ref_words: usize,
    pub edits: Edits,
    pub finish_s: f64,
    pub hypothesis: String,
}

/// Feeds 100 ms chunks, then times `finish` (where a finish-only engine does all its work).
pub fn run_clip(engine: &mut dyn SpeechEngine, audio: &[f32], reference: &str) -> Result<ClipResult, String> {
    engine.start().map_err(|e| e.to_string())?;
    for c in audio.chunks((SAMPLE_RATE / 10) as usize) {
        engine.accept(c);
    }
    let t = Instant::now();
    let hypothesis = engine.finish();
    let finish_s = t.elapsed().as_secs_f64();
    let ref_words = normalize(reference);
    Ok(ClipResult {
        audio_s: audio.len() as f64 / SAMPLE_RATE as f64,
        ref_words: ref_words.len(),
        edits: word_alignment(&ref_words, &normalize(&hypothesis)),
        finish_s,
        hypothesis,
    })
}

pub fn run(engine: &mut dyn SpeechEngine, dir: &Path, model_dir: &Path) -> ExitCode {
    let pairs = match find_pairs(dir) {
        Ok(p) if !p.is_empty() => p,
        Ok(_) => {
            eprintln!("[bench] no wav+txt pairs in {}", dir.display());
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("[bench] {e}");
            return ExitCode::FAILURE;
        }
    };
    let t = Instant::now();
    if let Err(e) = engine.prepare() {
        eprintln!("[bench] {e}");
        return ExitCode::FAILURE;
    }
    let load_s = t.elapsed().as_secs_f64();
    println!("engine {} model {} load {load_s:.2}s", engine.name(), engine.model().unwrap_or_else(|| "-".into()));
    println!("{:<28} {:>6} {:>6} {:>6} {:>11} {:>7} {:>6}", "clip", "audio", "words", "WER", "S/I/D", "finish", "RTF");
    let mut results = Vec::new();
    for (wav, txt) in &pairs {
        let name = wav.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let audio = match read_wav(wav) {
            Ok(a) => a,
            Err(e) => {
                eprintln!("[bench] skipping {name}: {e}");
                continue;
            }
        };
        let reference = fs::read_to_string(txt).unwrap_or_default();
        let r = match run_clip(engine, &audio, &reference) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[bench] {e}");
                return ExitCode::FAILURE;
            }
        };
        let wer = if r.ref_words == 0 { 0.0 } else { r.edits.total() as f64 / r.ref_words as f64 };
        let sid = format!("{}/{}/{}", r.edits.sub, r.edits.ins, r.edits.del);
        let blank = if r.hypothesis.trim().is_empty() { "  BLANK" } else { "" };
        println!("{name:<28} {:>6.2} {:>6} {:>5.1}% {sid:>11} {:>7.3} {:>6.3}{blank}", r.audio_s, r.ref_words, wer * 100.0, r.finish_s, r.finish_s / r.audio_s.max(1e-9));
        if r.edits.total() > 0 {
            eprintln!("[bench] {name}: ref \"{}\" hyp \"{}\"", reference.trim(), r.hypothesis.trim());
        }
        results.push(r);
    }
    let s = summary(engine, &results, load_s, dir_bytes(model_dir));
    println!(
        "TOTAL {} clips {:.1}s audio | WER {:.2}% (S/I/D {}/{}/{}) | blank {}",
        s["clips"], s["audioS"].as_f64().unwrap_or(0.0), s["wer"].as_f64().unwrap_or(0.0) * 100.0, s["sub"], s["ins"], s["del"], s["blank"]
    );
    println!("{s}");
    ExitCode::SUCCESS
}

fn summary(engine: &dyn SpeechEngine, results: &[ClipResult], load_s: f64, model_bytes: u64) -> serde_json::Value {
    let n = results.len().max(1) as f64;
    let ref_words: usize = results.iter().map(|r| r.ref_words).sum();
    let e = results.iter().fold(Edits::default(), |a, r| Edits { sub: a.sub + r.edits.sub, ins: a.ins + r.edits.ins, del: a.del + r.edits.del });
    let edits = e.total();
    json!({
        "engine": engine.name(),
        "model": engine.model(),
        "clips": results.len(),
        "blank": results.iter().filter(|r| r.hypothesis.trim().is_empty()).count(),
        "audioS": results.iter().map(|r| r.audio_s).sum::<f64>(),
        "wer": if ref_words == 0 { 0.0 } else { edits as f64 / ref_words as f64 },
        "sub": e.sub,
        "ins": e.ins,
        "del": e.del,
        "finishMeanS": results.iter().map(|r| r.finish_s).sum::<f64>() / n,
        "rtfMean": results.iter().map(|r| r.finish_s / r.audio_s.max(1e-9)).sum::<f64>() / n,
        "loadS": load_s,
        "modelBytes": model_bytes,
        "peakRamBytes": peak_working_set(),
    })
}

#[cfg(windows)]
pub fn peak_working_set() -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: plain-data struct; all-zero is a valid value.
    let mut c: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: c is a valid, correctly sized out-parameter; the pseudo-handle needs no closing.
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    (ok != 0).then_some(c.PeakWorkingSetSize as u64)
}

#[cfg(not(windows))]
pub fn peak_working_set() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamies_voice_core::engine::EngineError;

    /// Says "hello world", or nothing when `blank`.
    struct Fake {
        fed: usize,
        blank: bool,
    }

    impl SpeechEngine for Fake {
        fn name(&self) -> &str {
            "fake"
        }
        fn start(&mut self) -> Result<(), EngineError> {
            self.fed = 0;
            Ok(())
        }
        fn accept(&mut self, s: &[f32]) {
            self.fed += s.len();
        }
        fn partial(&mut self) -> Option<String> {
            None
        }
        fn finish(&mut self) -> String {
            if self.blank { String::new() } else { "hello world".into() }
        }
        fn cancel(&mut self) {}
    }

    #[test]
    fn scores_clips_and_counts_blanks() {
        let audio = vec![0.0f32; SAMPLE_RATE as usize / 2];
        let mut e = Fake { fed: 0, blank: false };
        let r = run_clip(&mut e, &audio, "Hello, there world.").unwrap();
        assert_eq!((r.ref_words, r.edits.total(), e.fed), (3, 1, audio.len()));
        assert!((r.audio_s - 0.5).abs() < 1e-9);
        let mut b = Fake { fed: 0, blank: true };
        let blank = run_clip(&mut b, &audio, "one two").unwrap();
        let s = summary(&e, &[r, blank], 1.0, 0);
        assert_eq!(s["clips"], 2);
        assert_eq!(s["blank"], 1);
        assert_eq!((s["sub"].clone(), s["ins"].clone(), s["del"].clone()), (json!(0), json!(0), json!(3)));
        assert!((s["wer"].as_f64().unwrap() - 3.0 / 5.0).abs() < 1e-9);
    }
}
