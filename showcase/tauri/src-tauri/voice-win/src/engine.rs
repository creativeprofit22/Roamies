//! Parakeet TDT 0.6B v3 (int8 ONNX via parakeet-rs) behind the shared `SpeechEngine` seam.
//! Not a streaming model: audio is buffered and read once, in `finish`.

use parakeet_rs::{ExecutionConfig, ParakeetTDT, Transcriber};
use roamies_voice_core::engine::{EngineError, SpeechEngine, SAMPLE_RATE};
use roamies_voice_core::level::level;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const MODEL: &str = "tdt-0.6b-v3-int8";
pub const FILES: [&str; 3] = ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "vocab.txt"];
/// Parakeet makes up words ("Thank you.") from silence, so a take is only read once the mic heard a
/// voice: about -49 dBFS, above room noise and below quiet speech.
const SPEECH_LEVEL: f64 = 0.15;
const MIN_SAMPLES: usize = SAMPLE_RATE as usize / 5;
/// Silence put before a take. Without it the int8 encoder often reads a short command as all blank
/// (12 of 25 own-voice clips); trailing silence cut long takes short instead. See docs/voice-engines.md.
const LEAD: usize = SAMPLE_RATE as usize * 3 / 2;

pub fn pad_for_parakeet(audio: &[f32]) -> Vec<f32> {
    let mut out = vec![0.0; LEAD];
    out.extend_from_slice(audio);
    out
}

/// Model files not in `dir`.
pub fn missing_files(dir: &Path) -> Vec<&'static str> {
    FILES.iter().copied().filter(|f| !dir.join(f).is_file()).collect()
}

/// Whether a take is worth reading: long enough and loud enough to hold a word.
fn worth_reading(samples: usize, peak: f64) -> bool {
    samples >= MIN_SAMPLES && peak >= SPEECH_LEVEL
}

pub struct Parakeet {
    dir: PathBuf,
    asr: Option<ParakeetTDT>,
    /// A load error is kept, so a corrupt model isn't reloaded (650 MB) on every chord press.
    failed: Option<String>,
    buf: Vec<f32>,
    peak: f64,
}

impl Parakeet {
    pub fn new(dir: PathBuf) -> Self {
        Parakeet { dir, asr: None, failed: None, buf: Vec::new(), peak: 0.0 }
    }

    fn load(&mut self) -> Result<&mut ParakeetTDT, EngineError> {
        if self.asr.is_none() {
            if let Some(e) = &self.failed {
                return Err(EngineError::Unavailable(e.clone()));
            }
            // Not cached: the model may finish downloading while the helper runs.
            let missing = missing_files(&self.dir);
            if !missing.is_empty() {
                return Err(EngineError::Unavailable(format!("{} missing in {}", missing.join(", "), self.dir.display())));
            }
            match load_model(&self.dir) {
                Ok(asr) => self.asr = Some(asr),
                Err(e) => {
                    self.failed = Some(e.clone());
                    return Err(EngineError::Unavailable(e));
                }
            }
        }
        self.asr.as_mut().ok_or_else(|| EngineError::Unavailable("model not loaded".into()))
    }
}

fn load_model(dir: &Path) -> Result<ParakeetTDT, String> {
    // Half the cores: a minute of speech reads in a few seconds without starving the PC.
    let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 8);
    let t0 = Instant::now();
    let dir = dir.to_path_buf();
    let mut asr = catch_unwind(move || -> Result<ParakeetTDT, String> {
        let env = parakeet_rs::ort::init().with_name("roamies-voice").build().map_err(|e| e.to_string())?;
        let config = ExecutionConfig::new().with_environment(env).with_intra_threads(threads);
        ParakeetTDT::from_pretrained(&dir, Some(config)).map_err(|e| e.to_string())
    })
    .map_err(|_| "the model crashed while loading".to_string())??;
    // One short warm-up run, so the first real request doesn't pay for ONNX Runtime's setup.
    let _ = catch_unwind(AssertUnwindSafe(|| asr.transcribe_samples(vec![0.0; SAMPLE_RATE as usize / 2], SAMPLE_RATE, 1, None)));
    log(&format!("model ready in {:.1}s ({threads} threads)", t0.elapsed().as_secs_f64()));
    Ok(asr)
}

impl SpeechEngine for Parakeet {
    fn name(&self) -> &str {
        "parakeet"
    }
    fn model(&self) -> Option<String> {
        Some(MODEL.into())
    }
    fn prepare(&mut self) -> Result<(), EngineError> {
        self.load().map(|_| ())
    }
    fn start(&mut self) -> Result<(), EngineError> {
        self.load()?;
        self.buf.clear();
        self.peak = 0.0;
        Ok(())
    }
    fn accept(&mut self, samples: &[f32]) {
        self.peak = self.peak.max(level(samples));
        self.buf.extend_from_slice(samples);
    }
    fn partial(&mut self) -> Option<String> {
        None
    }
    fn finish(&mut self) -> String {
        let audio = std::mem::take(&mut self.buf);
        if !worth_reading(audio.len(), self.peak) {
            return String::new();
        }
        let Some(asr) = self.asr.as_mut() else { return String::new() };
        let padded = pad_for_parakeet(&audio);
        match catch_unwind(AssertUnwindSafe(|| asr.transcribe_samples(padded, SAMPLE_RATE, 1, None))) {
            Ok(Ok(r)) => r.text.split_whitespace().collect::<Vec<_>>().join(" "),
            Ok(Err(e)) => {
                log(&format!("transcribe: {e}"));
                String::new()
            }
            Err(_) => {
                log("transcribe crashed");
                String::new()
            }
        }
    }
    fn cancel(&mut self) {
        self.buf.clear();
        self.peak = 0.0;
    }
    fn streaming(&self) -> bool {
        false
    }
}

fn log(s: &str) {
    eprintln!("[voice] {s}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_one_and_a_half_seconds_of_silence_first() {
        let p = pad_for_parakeet(&[0.5, -0.5]);
        assert_eq!(p.len(), 24_002);
        assert!(p[..24_000].iter().all(|&s| s == 0.0));
        assert_eq!(&p[24_000..], &[0.5, -0.5]);
        assert_eq!(pad_for_parakeet(&[]).len(), LEAD);
    }

    #[test]
    fn only_loud_long_enough_takes_are_read() {
        assert!(worth_reading(MIN_SAMPLES, 0.5));
        assert!(!worth_reading(MIN_SAMPLES - 1, 0.5), "too short");
        assert!(!worth_reading(SAMPLE_RATE as usize * 5, 0.1), "silence or room noise");
    }

    #[test]
    fn missing_model_is_unavailable_and_not_cached() {
        let dir = std::env::temp_dir().join(format!("roamies-parakeet-none-{}", std::process::id()));
        let mut p = Parakeet::new(dir);
        assert_eq!(missing_files(&p.dir), FILES.to_vec());
        assert!(matches!(p.start(), Err(EngineError::Unavailable(m)) if m.contains("vocab.txt")));
        assert!(p.failed.is_none());
    }

    #[test]
    fn quiet_take_finishes_empty_without_a_model() {
        let mut p = Parakeet::new(PathBuf::from("nowhere"));
        p.accept(&[0.0; 16_000]);
        assert_eq!(p.finish(), "");
        assert!(p.buf.is_empty());
        assert!(!p.streaming());
        assert_eq!(p.partial(), None);
    }

    #[test]
    fn load_errors_are_cached() {
        let mut p = Parakeet::new(PathBuf::from("nowhere"));
        p.failed = Some("bad model".into());
        assert_eq!(p.prepare(), Err(EngineError::Unavailable("bad model".into())));
    }
}
