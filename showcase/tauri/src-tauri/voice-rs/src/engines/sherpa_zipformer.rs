//! Streaming Zipformer transducer on the sherpa-onnx online recognizer (int8, greedy search,
//! endpointing on), following sherpa-onnx's rust-api-examples/streaming_zipformer_microphone.rs.

use crate::engine::{EngineError, SpeechEngine, SAMPLE_RATE};
use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};
use std::fs;
use std::path::{Path, PathBuf};

/// Silence appended on finish so the last word clears the model's right context.
const TAIL_PADDING_SECS: f32 = 0.3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelFiles {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

/// Finds `encoder*`, `decoder*`, `joiner*` (preferring `.int8.onnx`) and `tokens.txt` in `dir`.
pub fn find_model_files(dir: &Path) -> Result<ModelFiles, EngineError> {
    let missing = |what: &str| EngineError::Unavailable(format!("no {what} in {}", dir.display()));
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(|e| EngineError::Unavailable(format!("can't read model dir {}: {e}", dir.display())))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    let pick = |prefix: &str| -> Option<PathBuf> {
        let onnx = |n: &&String| n.starts_with(prefix) && n.ends_with(".onnx");
        names
            .iter()
            .filter(onnx)
            .find(|n| n.ends_with(".int8.onnx"))
            .or_else(|| names.iter().find(onnx))
            .map(|n| dir.join(n))
    };
    let tokens = dir.join("tokens.txt");
    Ok(ModelFiles {
        encoder: pick("encoder").ok_or_else(|| missing("encoder*.onnx"))?,
        decoder: pick("decoder").ok_or_else(|| missing("decoder*.onnx"))?,
        joiner: pick("joiner").ok_or_else(|| missing("joiner*.onnx"))?,
        tokens: if tokens.is_file() { tokens } else { return Err(missing("tokens.txt")) },
    })
}

pub struct SherpaZipformer {
    model_dir: PathBuf,
    recognizer: Option<OnlineRecognizer>,
    stream: Option<OnlineStream>,
    /// Text of segments sherpa already closed at an endpoint this session.
    done: Vec<String>,
    last: String,
    endpointed: bool,
}

impl SherpaZipformer {
    pub fn new(model_dir: PathBuf) -> Self {
        SherpaZipformer { model_dir, recognizer: None, stream: None, done: Vec::new(), last: String::new(), endpointed: false }
    }

    fn recognizer(&mut self) -> Result<&OnlineRecognizer, EngineError> {
        if self.recognizer.is_none() {
            let files = find_model_files(&self.model_dir)?;
            let mut config = OnlineRecognizerConfig::default();
            config.model_config.transducer.encoder = Some(path_str(&files.encoder));
            config.model_config.transducer.decoder = Some(path_str(&files.decoder));
            config.model_config.transducer.joiner = Some(path_str(&files.joiner));
            config.model_config.tokens = Some(path_str(&files.tokens));
            config.model_config.num_threads = 2;
            config.decoding_method = Some("greedy_search".into());
            config.enable_endpoint = true;
            config.rule1_min_trailing_silence = 2.4;
            config.rule2_min_trailing_silence = 1.2;
            config.rule3_min_utterance_length = 20.0;
            let rec = OnlineRecognizer::create(&config)
                .ok_or_else(|| EngineError::Unavailable(format!("sherpa-onnx couldn't load the model in {}", self.model_dir.display())))?;
            self.recognizer = Some(rec);
        }
        self.recognizer.as_ref().ok_or_else(|| EngineError::Unavailable("no recognizer".into()))
    }

    fn decode(&mut self) {
        let (Some(rec), Some(stream)) = (self.recognizer.as_ref(), self.stream.as_ref()) else { return };
        while rec.is_ready(stream) {
            rec.decode(stream);
        }
        if rec.is_endpoint(stream) {
            let seg = segment_text(rec, stream);
            if !seg.is_empty() {
                self.done.push(seg);
                self.endpointed = true;
            }
            rec.reset(stream);
        }
    }

    fn text(&self) -> String {
        let mut parts = self.done.clone();
        if let (Some(rec), Some(stream)) = (self.recognizer.as_ref(), self.stream.as_ref()) {
            let seg = segment_text(rec, stream);
            if !seg.is_empty() {
                parts.push(seg);
            }
        }
        parts.join(" ")
    }
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn segment_text(rec: &OnlineRecognizer, stream: &OnlineStream) -> String {
    rec.get_result(stream).map(|r| r.text.trim().to_string()).unwrap_or_default()
}

impl SpeechEngine for SherpaZipformer {
    fn name(&self) -> &str {
        "zipformer"
    }

    fn start(&mut self) -> Result<(), EngineError> {
        let stream = self.recognizer()?.create_stream();
        self.stream = Some(stream);
        self.done.clear();
        self.last.clear();
        self.endpointed = false;
        Ok(())
    }

    fn accept(&mut self, samples: &[f32]) {
        let Some(stream) = self.stream.as_ref() else { return };
        stream.accept_waveform(SAMPLE_RATE as i32, samples);
        self.decode();
    }

    fn partial(&mut self) -> Option<String> {
        self.stream.as_ref()?;
        let text = self.text();
        if text == self.last {
            return None;
        }
        self.last = text.clone();
        Some(text)
    }

    fn finish(&mut self) -> String {
        if let Some(stream) = self.stream.as_ref() {
            let tail = vec![0.0f32; (SAMPLE_RATE as f32 * TAIL_PADDING_SECS) as usize];
            stream.accept_waveform(SAMPLE_RATE as i32, &tail);
            stream.input_finished();
            if let Some(rec) = self.recognizer.as_ref() {
                while rec.is_ready(stream) {
                    rec.decode(stream);
                }
            }
        }
        let text = self.text();
        self.cancel();
        text
    }

    fn cancel(&mut self) {
        self.stream = None;
        self.done.clear();
        self.last.clear();
        self.endpointed = false;
    }

    fn prepare(&mut self) -> Result<(), EngineError> {
        self.recognizer().map(|_| ())
    }

    fn endpoint(&mut self) -> bool {
        std::mem::take(&mut self.endpointed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("roamies-voice-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_int8_files_first() {
        let dir = temp_dir("find");
        for f in [
            "encoder-epoch-99-avg-1.onnx",
            "encoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "joiner-epoch-99-avg-1.int8.onnx",
            "tokens.txt",
        ] {
            fs::write(dir.join(f), b"x").unwrap();
        }
        let files = find_model_files(&dir).unwrap();
        assert!(files.encoder.ends_with("encoder-epoch-99-avg-1.int8.onnx"));
        assert!(files.decoder.ends_with("decoder-epoch-99-avg-1.onnx"));
        assert!(files.joiner.ends_with("joiner-epoch-99-avg-1.int8.onnx"));
        assert!(files.tokens.ends_with("tokens.txt"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_files_are_unavailable() {
        let dir = temp_dir("missing");
        fs::write(dir.join("encoder.onnx"), b"x").unwrap();
        assert!(matches!(find_model_files(&dir), Err(EngineError::Unavailable(_))));
        assert!(matches!(find_model_files(&dir.join("nope")), Err(EngineError::Unavailable(_))));
        let mut eng = SherpaZipformer::new(dir.join("nope"));
        assert!(matches!(eng.start(), Err(EngineError::Unavailable(_))));
        assert_eq!(eng.partial(), None);
        assert_eq!(eng.finish(), "");
        assert!(eng.prepare().is_err());
        assert!(!eng.endpoint());
        let _ = fs::remove_dir_all(&dir);
    }
}
