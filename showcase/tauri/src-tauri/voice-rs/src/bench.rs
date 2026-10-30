//! `--bench <dir>`: runs every `name.wav` + `name.txt` pair through one engine and prints WER,
//! time to first partial, finish latency, real-time factor, model size and peak RAM.

use crate::audio::Resampler16k;
use crate::engine::{SpeechEngine, SAMPLE_RATE};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

pub struct BenchInfo {
    pub model_dir: PathBuf,
    /// Runtime files shipped besides the model (DLLs; the exe itself for statically linked engines).
    pub runtime: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClipResult {
    pub name: String,
    pub audio_s: f64,
    pub ref_words: usize,
    pub edits: usize,
    /// Audio fed plus compute spent until the first nonempty partial.
    pub ttfp_s: Option<f64>,
    pub finish_s: f64,
    pub compute_s: f64,
    pub hypothesis: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub engine: String,
    pub model: Option<String>,
    pub clips: usize,
    pub audio_s: f64,
    pub wer: f64,
    pub ttfp_median_s: Option<f64>,
    pub ttfp_p90_s: Option<f64>,
    pub finish_mean_s: f64,
    pub rtf_mean: f64,
    pub load_s: f64,
    pub model_bytes: u64,
    pub runtime_bytes: u64,
    pub peak_ram_bytes: Option<u64>,
}

/// Lowercase words; punctuation dropped except apostrophes inside words ("don't", not "'quoted'").
pub fn normalize(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.to_lowercase().chars().collect();
    let mut out = String::with_capacity(chars.len());
    for (i, &c) in chars.iter().enumerate() {
        let inner_apostrophe = (c == '\'' || c == '’')
            && i > 0
            && i + 1 < chars.len()
            && chars[i - 1].is_alphanumeric()
            && chars[i + 1].is_alphanumeric();
        if c.is_alphanumeric() {
            out.push(c);
        } else if inner_apostrophe {
            out.push('\'');
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace().map(str::to_string).collect()
}

/// Word-level Levenshtein distance (substitutions + insertions + deletions).
pub fn word_edits(reference: &[String], hypothesis: &[String]) -> usize {
    let mut prev: Vec<usize> = (0..=hypothesis.len()).collect();
    for (i, r) in reference.iter().enumerate() {
        let mut cur = vec![i + 1; hypothesis.len() + 1];
        for (j, h) in hypothesis.iter().enumerate() {
            let sub = prev[j] + usize::from(r != h);
            cur[j + 1] = sub.min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[hypothesis.len()]
}

/// Nearest-rank percentile (p in 0..=100) of unsorted values.
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let rank = ((p / 100.0) * v.len() as f64).ceil().max(1.0) as usize;
    Some(v[rank.min(v.len()) - 1])
}

/// `*.wav` files with a same-stem `*.txt`, sorted by name.
pub fn find_pairs(dir: &Path) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut pairs: Vec<(PathBuf, PathBuf)> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")))
        .filter_map(|wav| {
            let txt = wav.with_extension("txt");
            txt.is_file().then_some((wav, txt))
        })
        .collect();
    pairs.sort();
    Ok(pairs)
}

pub fn dir_bytes(path: &Path) -> u64 {
    match fs::metadata(path) {
        Ok(m) if m.is_file() => m.len(),
        Ok(m) if m.is_dir() => fs::read_dir(path)
            .map(|it| it.filter_map(Result::ok).map(|e| dir_bytes(&e.path())).sum())
            .unwrap_or(0),
        _ => 0,
    }
}

/// Feeds 100 ms chunks as fast as the engine takes them.
pub fn run_clip(engine: &mut dyn SpeechEngine, name: &str, audio: &[f32], reference: &str) -> Result<ClipResult, String> {
    engine.start().map_err(|e| e.to_string())?;
    let chunk = (SAMPLE_RATE / 10) as usize;
    let mut compute = Duration::ZERO;
    let mut fed = 0usize;
    let mut ttfp = None;
    for c in audio.chunks(chunk) {
        let t = Instant::now();
        engine.accept(c);
        let partial = engine.partial();
        engine.endpoint();
        compute += t.elapsed();
        fed += c.len();
        if ttfp.is_none() && partial.is_some_and(|p| !p.trim().is_empty()) {
            ttfp = Some(fed as f64 / SAMPLE_RATE as f64 + compute.as_secs_f64());
        }
    }
    let t = Instant::now();
    let hypothesis = engine.finish();
    let finish = t.elapsed();
    compute += finish;
    let ref_words = normalize(reference);
    Ok(ClipResult {
        name: name.to_string(),
        audio_s: audio.len() as f64 / SAMPLE_RATE as f64,
        ref_words: ref_words.len(),
        edits: word_edits(&ref_words, &normalize(&hypothesis)),
        ttfp_s: ttfp,
        finish_s: finish.as_secs_f64(),
        compute_s: compute.as_secs_f64(),
        hypothesis,
    })
}

pub fn summarize(engine: &dyn SpeechEngine, results: &[ClipResult], load_s: f64, info: &BenchInfo) -> Summary {
    let n = results.len().max(1) as f64;
    let ttfps: Vec<f64> = results.iter().filter_map(|r| r.ttfp_s).collect();
    let ref_words: usize = results.iter().map(|r| r.ref_words).sum();
    let edits: usize = results.iter().map(|r| r.edits).sum();
    Summary {
        engine: engine.name().to_string(),
        model: engine.model(),
        clips: results.len(),
        audio_s: results.iter().map(|r| r.audio_s).sum(),
        wer: if ref_words == 0 { 0.0 } else { edits as f64 / ref_words as f64 },
        ttfp_median_s: percentile(&ttfps, 50.0),
        ttfp_p90_s: percentile(&ttfps, 90.0),
        finish_mean_s: results.iter().map(|r| r.finish_s).sum::<f64>() / n,
        rtf_mean: results.iter().map(|r| if r.audio_s > 0.0 { r.compute_s / r.audio_s } else { 0.0 }).sum::<f64>() / n,
        load_s,
        model_bytes: dir_bytes(&info.model_dir),
        runtime_bytes: info.runtime.iter().map(|p| dir_bytes(p)).sum(),
        peak_ram_bytes: peak_working_set(),
    }
}

fn opt_secs(v: Option<f64>) -> String {
    v.map_or("-".into(), |s| format!("{s:.2}"))
}

pub fn run(engine: &mut dyn SpeechEngine, dir: &Path, info: &BenchInfo) -> ExitCode {
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
    println!("{:<28} {:>6} {:>6} {:>6} {:>6} {:>7} {:>6}", "clip", "audio", "words", "WER", "TTFP", "finish", "RTF");
    let mut results = Vec::new();
    for (wav, txt) in &pairs {
        let name = wav.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let audio = match load_16k(wav) {
            Ok(a) => a,
            Err(e) => {
                eprintln!("[bench] skipping {name}: {e}");
                continue;
            }
        };
        let reference = fs::read_to_string(txt).unwrap_or_default();
        let r = match run_clip(engine, &name, &audio, &reference) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[bench] {e}");
                return ExitCode::FAILURE;
            }
        };
        let wer = if r.ref_words == 0 { 0.0 } else { r.edits as f64 / r.ref_words as f64 };
        println!(
            "{:<28} {:>6.2} {:>6} {:>5.1}% {:>6} {:>7.3} {:>6.3}",
            name,
            r.audio_s,
            r.ref_words,
            wer * 100.0,
            opt_secs(r.ttfp_s),
            r.finish_s,
            r.compute_s / r.audio_s.max(1e-9)
        );
        if r.edits > 0 {
            eprintln!("[bench] {name}: ref \"{}\" hyp \"{}\"", reference.trim(), r.hypothesis.trim());
        }
        results.push(r);
    }
    let s = summarize(engine, &results, load_s, info);
    let mib = |b: u64| b as f64 / (1024.0 * 1024.0);
    println!(
        "TOTAL {} clips {:.1}s audio | WER {:.2}% | TTFP median {} p90 {} s | finish {:.3}s | RTF {:.3} | model {:.1} MiB runtime {:.1} MiB | peak RAM {}",
        s.clips,
        s.audio_s,
        s.wer * 100.0,
        opt_secs(s.ttfp_median_s),
        opt_secs(s.ttfp_p90_s),
        s.finish_mean_s,
        s.rtf_mean,
        mib(s.model_bytes),
        mib(s.runtime_bytes),
        s.peak_ram_bytes.map_or("n/a".into(), |b| format!("{:.0} MiB", mib(b)))
    );
    println!("{}", serde_json::to_string(&s).unwrap_or_default());
    ExitCode::SUCCESS
}

fn load_16k(wav: &Path) -> Result<Vec<f32>, String> {
    let (samples, rate) = crate::read_wav(wav)?;
    let mut r = Resampler16k::new(rate)?;
    let mut audio = r.process(&samples);
    audio.extend(r.flush());
    Ok(audio)
}

#[cfg(windows)]
fn peak_working_set() -> Option<u64> {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut c = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
    // SAFETY: c is a valid, correctly sized out-parameter; the pseudo-handle needs no closing.
    unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) }.ok()?;
    Some(c.PeakWorkingSetSize as u64)
}

#[cfg(not(windows))]
fn peak_working_set() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EngineError;

    fn words(s: &str) -> Vec<String> {
        normalize(s)
    }

    #[test]
    fn normalize_lowercases_and_strips_punctuation() {
        assert_eq!(words("Hello, World! It's  'quoted' -- ok."), ["hello", "world", "it's", "quoted", "ok"]);
        assert_eq!(words("DON’T stop"), ["don't", "stop"]);
        assert!(words("  ...  ").is_empty());
    }

    #[test]
    fn word_edits_counts_levenshtein() {
        assert_eq!(word_edits(&words("a b c"), &words("a b c")), 0);
        assert_eq!(word_edits(&words("a b c"), &words("a x c")), 1);
        assert_eq!(word_edits(&words("a b c"), &words("a c")), 1);
        assert_eq!(word_edits(&words("a b"), &words("a b c d")), 2);
        assert_eq!(word_edits(&words("a b c"), &[]), 3);
        assert_eq!(word_edits(&[], &words("a")), 1);
    }

    #[test]
    fn percentile_uses_nearest_rank() {
        let v = [5.0, 1.0, 3.0, 2.0, 4.0];
        assert_eq!(percentile(&v, 50.0), Some(3.0));
        assert_eq!(percentile(&v, 90.0), Some(5.0));
        assert_eq!(percentile(&[], 50.0), None);
    }

    #[test]
    fn find_pairs_needs_matching_txt() {
        let dir = std::env::temp_dir().join(format!("roamies-voice-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for f in ["b.wav", "b.txt", "a.wav", "a.txt", "lonely.wav", "notes.txt"] {
            fs::write(dir.join(f), "x").unwrap();
        }
        let names: Vec<_> = find_pairs(&dir).unwrap().iter().map(|(w, _)| w.file_name().unwrap().to_owned()).collect();
        assert_eq!(names, ["a.wav", "b.wav"]);
        assert_eq!(dir_bytes(&dir), 6);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Says "hello world" from the second chunk on.
    struct Fake {
        chunks: usize,
    }

    impl SpeechEngine for Fake {
        fn name(&self) -> &str {
            "fake"
        }
        fn start(&mut self) -> Result<(), EngineError> {
            self.chunks = 0;
            Ok(())
        }
        fn accept(&mut self, _: &[f32]) {
            self.chunks += 1;
        }
        fn partial(&mut self) -> Option<String> {
            (self.chunks == 2).then(|| "hello".into())
        }
        fn finish(&mut self) -> String {
            "hello world".into()
        }
        fn cancel(&mut self) {}
    }

    #[test]
    fn run_clip_scores_and_times() {
        let mut e = Fake { chunks: 0 };
        let audio = vec![0.0f32; SAMPLE_RATE as usize / 2];
        let r = run_clip(&mut e, "c", &audio, "Hello, there world.").unwrap();
        assert_eq!((r.ref_words, r.edits), (3, 1));
        assert!((r.audio_s - 0.5).abs() < 1e-9);
        let ttfp = r.ttfp_s.unwrap();
        assert!((0.2..0.3).contains(&ttfp), "{ttfp}");
        let info = BenchInfo { model_dir: PathBuf::from("nope"), runtime: vec![] };
        let s = summarize(&e, &[r], 1.0, &info);
        assert!((s.wer - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!((s.clips, s.model_bytes), (1, 0));
    }
}
