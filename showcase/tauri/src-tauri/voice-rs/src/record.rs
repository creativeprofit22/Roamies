//! `--record <dir>`: walks the user through bench-prompts.txt and saves each read as `NN.wav`
//! (16 kHz mono 16-bit) plus `NN.txt`, ready for `--bench`. Existing clips are kept, so it resumes.

use crate::audio::{MicCapture, Resampler16k};
use crate::engine::SAMPLE_RATE;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

pub fn parse_prompts(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(str::to_string).collect()
}

pub fn clip_stem(index: usize) -> String {
    format!("{:02}", index + 1)
}

pub fn write_wav16(path: &Path, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 1, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for &s in samples {
        w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).map_err(|e| e.to_string())?;
    }
    w.finalize().map_err(|e| e.to_string())
}

fn default_prompts() -> PathBuf {
    let here = PathBuf::from("bench-prompts.txt");
    if here.is_file() {
        here
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("bench-prompts.txt")
    }
}

fn wait_enter(lines: &mut impl Iterator<Item = io::Result<String>>) -> Option<String> {
    lines.next().and_then(Result::ok)
}

pub fn run(dir: &Path, prompts_file: Option<&Path>) -> ExitCode {
    let path = prompts_file.map(Path::to_path_buf).unwrap_or_else(default_prompts);
    let prompts = match fs::read_to_string(&path) {
        Ok(t) => parse_prompts(&t),
        Err(e) => {
            eprintln!("[record] can't read {}: {e}", path.display());
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("[record] can't create {}: {e}", dir.display());
        return ExitCode::FAILURE;
    }
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let total = prompts.len();
    for (i, prompt) in prompts.iter().enumerate() {
        let stem = clip_stem(i);
        let wav = dir.join(format!("{stem}.wav"));
        if wav.is_file() {
            continue;
        }
        loop {
            eprint!("\n[{}/{total}] Read this, in your normal voice:\n\n    {prompt}\n\nEnter = start (q = quit) ", i + 1);
            let _ = io::stderr().flush();
            match wait_enter(&mut lines) {
                Some(l) if l.trim().eq_ignore_ascii_case("q") => return ExitCode::SUCCESS,
                Some(_) => {}
                None => return ExitCode::SUCCESS,
            }
            let buf = Arc::new(Mutex::new(Vec::<f32>::new()));
            let sink = Arc::clone(&buf);
            let mic = match MicCapture::open(
                move |chunk| sink.lock().unwrap_or_else(|p| p.into_inner()).extend(chunk),
                |e| eprintln!("[record] mic: {e}"),
            ) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[record] can't open the mic: {e}");
                    return ExitCode::FAILURE;
                }
            };
            eprint!("recording... Enter = stop ");
            let _ = io::stderr().flush();
            let stopped = wait_enter(&mut lines);
            let rate = mic.rate;
            drop(mic);
            if stopped.is_none() {
                return ExitCode::SUCCESS;
            }
            let raw = std::mem::take(&mut *buf.lock().unwrap_or_else(|p| p.into_inner()));
            let audio = match Resampler16k::new(rate) {
                Ok(mut r) => {
                    let mut a = r.process(&raw);
                    a.extend(r.flush());
                    a
                }
                Err(e) => {
                    eprintln!("[record] {e}");
                    return ExitCode::FAILURE;
                }
            };
            let secs = audio.len() as f64 / SAMPLE_RATE as f64;
            if secs < 0.5 {
                eprintln!("[record] only {secs:.1}s captured; again.");
                continue;
            }
            let txt = dir.join(format!("{stem}.txt"));
            if let Err(e) = write_wav16(&wav, &audio).and_then(|_| fs::write(&txt, format!("{prompt}\n")).map_err(|e| e.to_string())) {
                eprintln!("[record] can't save {stem}: {e}");
                return ExitCode::FAILURE;
            }
            eprintln!("saved {} ({secs:.1}s)", wav.display());
            break;
        }
    }
    eprintln!("\nall {total} clips are in {}", dir.display());
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_skip_comments_and_blanks() {
        assert_eq!(parse_prompts("# hi\n\n  One.  \nTwo\n#x\n"), ["One.", "Two"]);
        assert_eq!(clip_stem(0), "01");
        assert_eq!(clip_stem(24), "25");
    }

    #[test]
    fn committed_prompts_cover_twenty_clips() {
        let text = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("bench-prompts.txt")).unwrap();
        assert!(parse_prompts(&text).len() >= 20);
    }

    #[test]
    fn wav16_round_trips_through_read_wav() {
        let path = std::env::temp_dir().join(format!("roamies-voice-rec-{}.wav", std::process::id()));
        let samples: Vec<f32> = (0..1600).map(|i| (i as f32 / 100.0).sin() * 0.5).collect();
        write_wav16(&path, &samples).unwrap();
        let (back, rate) = crate::read_wav(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!((rate, back.len()), (SAMPLE_RATE, samples.len()));
        assert!(back.iter().zip(&samples).all(|(a, b)| (a - b).abs() < 1e-3));
    }
}
