//! Moonshine streaming engine, on Moonshine's own runtime loaded at run time (sherpa-onnx has no streaming Moonshine).

mod ffi;

use crate::engine::{EngineError, SpeechEngine, SAMPLE_RATE};
use ffi::{Api, Line};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Tiny,
    Small,
    Medium,
}

impl Size {
    pub fn parse(s: &str) -> Option<Size> {
        match s {
            "tiny" => Some(Size::Tiny),
            "small" => Some(Size::Small),
            "medium" => Some(Size::Medium),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Size::Tiny => "tiny",
            Size::Small => "small",
            Size::Medium => "medium",
        }
    }

    fn arch(self) -> u32 {
        match self {
            Size::Tiny => ffi::ARCH_TINY_STREAMING,
            Size::Small => ffi::ARCH_SMALL_STREAMING,
            Size::Medium => ffi::ARCH_MEDIUM_STREAMING,
        }
    }
}

const MODEL_FILES: [&str; 6] = ["encoder.ort", "adapter.ort", "cross_kv.ort", "decoder_kv.ort", "streaming_config.json", "tokenizer.bin"];

pub fn check_model_files(dir: &Path) -> Result<(), EngineError> {
    let missing = |f: &str| EngineError::Unavailable(format!("no {f} in {}", dir.display()));
    let has = |f: &str| dir.join(f).is_file();
    if !has("frontend.ort") && !(has("frontend.model.ort") && has("frontend.weights.ort")) {
        return Err(missing("frontend.ort (or frontend.model.ort + frontend.weights.ort)"));
    }
    match MODEL_FILES.iter().find(|f| !has(f)) {
        Some(f) => Err(missing(f)),
        None => Ok(()),
    }
}

fn joined(lines: &[Line]) -> String {
    lines.iter().map(|l| l.text.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ")
}

fn completed(lines: &[Line]) -> usize {
    lines.iter().filter(|l| l.complete && !l.text.trim().is_empty()).count()
}

struct Loaded {
    api: Api,
    transcriber: i32,
}

pub struct Moonshine {
    lib_path: PathBuf,
    model_dir: PathBuf,
    size: Size,
    loaded: Option<Loaded>,
    stream: Option<i32>,
    lines: Vec<Line>,
    completed: usize,
    last: String,
    endpointed: bool,
}

impl Moonshine {
    pub fn new(lib_path: PathBuf, model_dir: PathBuf, size: Size) -> Self {
        Moonshine { lib_path, model_dir, size, loaded: None, stream: None, lines: Vec::new(), completed: 0, last: String::new(), endpointed: false }
    }

    fn load(&mut self) -> Result<&Loaded, EngineError> {
        if self.loaded.is_none() {
            check_model_files(&self.model_dir)?;
            let api = Api::load(&self.lib_path).map_err(EngineError::Unavailable)?;
            let transcriber = api
                .load_transcriber(&self.model_dir, self.size.arch())
                .map_err(|e| EngineError::Unavailable(format!("Moonshine couldn't load {}: {e}", self.model_dir.display())))?;
            self.loaded = Some(Loaded { api, transcriber });
        }
        self.loaded.as_ref().ok_or_else(|| EngineError::Unavailable("no transcriber".into()))
    }

    fn reset(&mut self) {
        self.lines.clear();
        self.completed = 0;
        self.last.clear();
        self.endpointed = false;
    }

    fn update(&mut self, lines: Vec<Line>) {
        let done = completed(&lines);
        if done > self.completed {
            self.completed = done;
            self.endpointed = true;
        }
        self.lines = lines;
    }

    fn free_stream(&mut self) {
        if let (Some(s), Some(l)) = (self.stream.take(), self.loaded.as_ref()) {
            let _ = l.api.stop_stream(l.transcriber, s);
            l.api.free_stream(l.transcriber, s);
        }
    }
}

impl SpeechEngine for Moonshine {
    fn name(&self) -> &str {
        "moonshine"
    }

    fn model(&self) -> Option<String> {
        Some(format!("{}-streaming-en", self.size.as_str()))
    }

    fn start(&mut self) -> Result<(), EngineError> {
        self.free_stream();
        self.reset();
        let l = self.load()?;
        let s = l.api.create_stream(l.transcriber).map_err(EngineError::Unavailable)?;
        if let Err(e) = l.api.start_stream(l.transcriber, s) {
            l.api.free_stream(l.transcriber, s);
            return Err(EngineError::Unavailable(e));
        }
        self.stream = Some(s);
        Ok(())
    }

    fn accept(&mut self, samples: &[f32]) {
        let (Some(s), Some(l)) = (self.stream, self.loaded.as_ref()) else { return };
        if l.api.add_audio(l.transcriber, s, samples, SAMPLE_RATE as i32).is_err() {
            return;
        }
        // Moonshine throttles this itself: it only re-runs after 200 ms of new audio.
        if let Ok(lines) = l.api.transcribe(l.transcriber, s) {
            self.update(lines);
        }
    }

    fn partial(&mut self) -> Option<String> {
        self.stream?;
        let text = joined(&self.lines);
        if text == self.last {
            return None;
        }
        self.last = text.clone();
        Some(text)
    }

    fn finish(&mut self) -> String {
        if let (Some(s), Some(l)) = (self.stream, self.loaded.as_ref()) {
            // Stop, then one more transcribe drains the unanalysed tail.
            if l.api.stop_stream(l.transcriber, s).is_ok() {
                if let Ok(lines) = l.api.transcribe(l.transcriber, s) {
                    self.lines = lines;
                }
            }
        }
        let text = if self.stream.is_some() { joined(&self.lines) } else { String::new() };
        self.cancel();
        text
    }

    fn cancel(&mut self) {
        self.free_stream();
        self.reset();
    }

    fn prepare(&mut self) -> Result<(), EngineError> {
        self.load().map(|_| ())
    }

    fn endpoint(&mut self) -> bool {
        std::mem::take(&mut self.endpointed)
    }
}

impl Drop for Moonshine {
    fn drop(&mut self) {
        self.free_stream();
        if let Some(l) = self.loaded.take() {
            l.api.free_transcriber(l.transcriber);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("roamies-voice-moon-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn line(text: &str, complete: bool) -> Line {
        Line { text: text.into(), complete }
    }

    #[test]
    fn model_files_are_checked() {
        let dir = temp_dir("files");
        assert!(matches!(check_model_files(&dir), Err(EngineError::Unavailable(_))));
        for f in ["frontend.model.ort", "frontend.weights.ort", "encoder.ort", "adapter.ort", "cross_kv.ort", "decoder_kv.ort", "streaming_config.json"] {
            fs::write(dir.join(f), b"x").unwrap();
        }
        match check_model_files(&dir) {
            Err(EngineError::Unavailable(why)) => assert!(why.contains("tokenizer.bin"), "{why}"),
            other => panic!("{other:?}"),
        }
        fs::write(dir.join("tokenizer.bin"), b"x").unwrap();
        assert_eq!(check_model_files(&dir), Ok(()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_library_or_model_is_unavailable() {
        let dir = temp_dir("nolib");
        let mut eng = Moonshine::new(dir.join("moonshine.dll"), dir.clone(), Size::Tiny);
        assert!(matches!(eng.prepare(), Err(EngineError::Unavailable(_))));
        assert!(matches!(eng.start(), Err(EngineError::Unavailable(_))));
        eng.accept(&[0.0; 160]);
        assert_eq!(eng.partial(), None);
        assert_eq!(eng.finish(), "");
        assert!(!eng.endpoint());
        assert_eq!(eng.model().as_deref(), Some("tiny-streaming-en"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn joins_nonempty_lines_and_counts_endpoints_once() {
        let mut eng = Moonshine::new(PathBuf::new(), PathBuf::new(), Size::Small);
        assert_eq!(joined(&[line(" hello ", true), line("", false), line("world", false)]), "hello world");
        eng.update(vec![line("hello", false)]);
        assert!(!eng.endpoint());
        eng.update(vec![line("hello there", true), line("", false)]);
        assert!(eng.endpoint());
        assert!(!eng.endpoint());
        eng.update(vec![line("hello there", true), line("again", false)]);
        assert!(!eng.endpoint());
        eng.update(vec![line("hello there", true), line("again", true)]);
        assert!(eng.endpoint());
    }

    #[test]
    fn sizes_parse() {
        assert_eq!(Size::parse("tiny"), Some(Size::Tiny));
        assert_eq!(Size::parse("medium").map(Size::as_str), Some("medium"));
        assert_eq!(Size::parse("huge"), None);
    }
}
