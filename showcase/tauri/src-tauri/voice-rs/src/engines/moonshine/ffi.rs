//! Thin runtime-loaded binding to Moonshine's C API (models/moonshine-runtime/moonshine-c-api.h, header 30000).

use libloading::Library;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;

pub const HEADER_VERSION: i32 = 30000;
pub const ARCH_TINY_STREAMING: u32 = 2;
pub const ARCH_SMALL_STREAMING: u32 = 4;
pub const ARCH_MEDIUM_STREAMING: u32 = 5;

#[repr(C)]
pub struct MoonshineOption {
    pub name: *const c_char,
    pub value: *const c_char,
}

/// Mirrors `struct transcript_line_t` field for field.
#[repr(C)]
pub struct TranscriptLine {
    pub text: *const c_char,
    pub audio_data: *const f32,
    pub audio_data_count: usize,
    pub start_time: f32,
    pub duration: f32,
    pub id: u64,
    pub is_complete: i8,
    pub is_updated: i8,
    pub is_new: i8,
    pub has_text_changed: i8,
    pub have_speakers_changed: i8,
    pub speaker_spans: *const c_void,
    pub speaker_span_count: u64,
    pub last_transcription_latency_ms: u32,
    pub words: *const c_void,
    pub word_count: u64,
}

#[repr(C)]
pub struct Transcript {
    pub lines: *mut TranscriptLine,
    pub line_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    pub complete: bool,
}

type GetVersion = unsafe extern "C" fn() -> i32;
type ErrorToString = unsafe extern "C" fn(i32) -> *const c_char;
type LoadFromFiles = unsafe extern "C" fn(*const c_char, u32, *const MoonshineOption, u64, i32) -> i32;
type FreeTranscriber = unsafe extern "C" fn(i32);
type CreateStream = unsafe extern "C" fn(i32, u32) -> i32;
type StreamOp = unsafe extern "C" fn(i32, i32) -> i32;
type AddAudio = unsafe extern "C" fn(i32, i32, *const f32, u64, i32, u32) -> i32;
type TranscribeStream = unsafe extern "C" fn(i32, i32, u32, *mut *mut Transcript) -> i32;

pub struct Api {
    get_version: GetVersion,
    error_to_string: ErrorToString,
    load_transcriber_from_files: LoadFromFiles,
    free_transcriber: FreeTranscriber,
    create_stream: CreateStream,
    free_stream: StreamOp,
    start_stream: StreamOp,
    stop_stream: StreamOp,
    add_audio: AddAudio,
    transcribe_stream: TranscribeStream,
    // Declared last so the fn pointers above never outlive it.
    _lib: Library,
}

fn open(path: &Path) -> Result<Library, String> {
    #[cfg(windows)]
    {
        use libloading::os::windows::{Library as WinLib, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR};
        let abs = std::path::absolute(path).map_err(|e| e.to_string())?;
        // DLL_LOAD_DIR makes Moonshine's own onnxruntime.dll win over any copy in System32.
        unsafe { WinLib::load_with_flags(&abs, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) }
            .map(Library::from)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    unsafe {
        Library::new(path).map_err(|e| e.to_string())
    }
}

impl Api {
    pub fn load(path: &Path) -> Result<Api, String> {
        if !path.is_file() {
            return Err(format!("no Moonshine library at {}", path.display()));
        }
        let lib = open(path).map_err(|e| format!("can't load {}: {e}", path.display()))?;
        unsafe {
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get($name).map_err(|e| format!("{} missing in {}: {e}", $name, path.display()))?
                };
            }
            let api = Api {
                get_version: sym!("moonshine_get_version"),
                error_to_string: sym!("moonshine_error_to_string"),
                load_transcriber_from_files: sym!("moonshine_load_transcriber_from_files"),
                free_transcriber: sym!("moonshine_free_transcriber"),
                create_stream: sym!("moonshine_create_stream"),
                free_stream: sym!("moonshine_free_stream"),
                start_stream: sym!("moonshine_start_stream"),
                stop_stream: sym!("moonshine_stop_stream"),
                add_audio: sym!("moonshine_transcribe_add_audio_to_stream"),
                transcribe_stream: sym!("moonshine_transcribe_stream"),
                _lib: lib,
            };
            let v = (api.get_version)();
            if v < HEADER_VERSION {
                return Err(format!("Moonshine library version {v} is older than header {HEADER_VERSION}"));
            }
            Ok(api)
        }
    }

    fn err(&self, code: i32) -> String {
        let p = unsafe { (self.error_to_string)(code) };
        if p.is_null() {
            return format!("moonshine error {code}");
        }
        format!("{} ({code})", unsafe { CStr::from_ptr(p) }.to_string_lossy())
    }

    fn check(&self, code: i32) -> Result<(), String> {
        if code == 0 { Ok(()) } else { Err(self.err(code)) }
    }

    pub fn load_transcriber(&self, dir: &Path, arch: u32) -> Result<i32, String> {
        let path = CString::new(dir.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let h = unsafe { (self.load_transcriber_from_files)(path.as_ptr(), arch, std::ptr::null(), 0, HEADER_VERSION) };
        if h < 0 { Err(self.err(h)) } else { Ok(h) }
    }

    pub fn free_transcriber(&self, t: i32) {
        unsafe { (self.free_transcriber)(t) }
    }

    pub fn create_stream(&self, t: i32) -> Result<i32, String> {
        let s = unsafe { (self.create_stream)(t, 0) };
        if s < 0 { Err(self.err(s)) } else { Ok(s) }
    }

    pub fn free_stream(&self, t: i32, s: i32) {
        unsafe { (self.free_stream)(t, s) };
    }

    pub fn start_stream(&self, t: i32, s: i32) -> Result<(), String> {
        self.check(unsafe { (self.start_stream)(t, s) })
    }

    pub fn stop_stream(&self, t: i32, s: i32) -> Result<(), String> {
        self.check(unsafe { (self.stop_stream)(t, s) })
    }

    pub fn add_audio(&self, t: i32, s: i32, samples: &[f32], rate: i32) -> Result<(), String> {
        self.check(unsafe { (self.add_audio)(t, s, samples.as_ptr(), samples.len() as u64, rate, 0) })
    }

    /// Copies the lines out at once: the library owns the transcript only until the next call.
    pub fn transcribe(&self, t: i32, s: i32) -> Result<Vec<Line>, String> {
        let mut out: *mut Transcript = std::ptr::null_mut();
        self.check(unsafe { (self.transcribe_stream)(t, s, 0, &mut out) })?;
        let mut lines = Vec::new();
        if out.is_null() {
            return Ok(lines);
        }
        unsafe {
            let tr = &*out;
            if tr.lines.is_null() {
                return Ok(lines);
            }
            for l in std::slice::from_raw_parts(tr.lines, tr.line_count as usize) {
                let text = if l.text.is_null() { String::new() } else { CStr::from_ptr(l.text).to_string_lossy().into_owned() };
                lines.push(Line { text, complete: l.is_complete != 0 });
            }
        }
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn transcript_line_matches_the_c_layout() {
        assert_eq!(offset_of!(TranscriptLine, audio_data_count), 16);
        assert_eq!(offset_of!(TranscriptLine, id), 32);
        assert_eq!(offset_of!(TranscriptLine, is_complete), 40);
        assert_eq!(offset_of!(TranscriptLine, speaker_spans), 48);
        assert_eq!(offset_of!(TranscriptLine, last_transcription_latency_ms), 64);
        assert_eq!(offset_of!(TranscriptLine, words), 72);
        assert_eq!(size_of::<TranscriptLine>(), 88);
        assert_eq!(size_of::<Transcript>(), 16);
    }

    #[test]
    fn missing_library_is_an_error_not_a_panic() {
        let err = Api::load(Path::new("no/such/moonshine.dll")).err().unwrap();
        assert!(err.contains("no Moonshine library"), "{err}");
    }
}
