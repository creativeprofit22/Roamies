//! roamies-voice: Windows voice helper. Wiring only; see the modules for behaviour.

mod audio;
mod chord;
mod engine;
mod engines;
mod keys_windows;
mod protocol;
mod session;

use audio::{MicCapture, Resampler16k};
use engine::SAMPLE_RATE;
use engines::SherpaZipformer;
use protocol::{parse_command, Command, Emitter, ErrorCode, Event};
use session::Session;
use std::io::{self, BufRead, Stdout};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

type Live = Session<SherpaZipformer, Stdout>;

struct Args {
    chord: Vec<String>,
    wav: Option<PathBuf>,
    model_dir: PathBuf,
}

fn parse_args() -> Args {
    let mut args = Args { chord: Vec::new(), wav: None, model_dir: default_model_dir() };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--chord" => {
                if let Some(v) = it.next() {
                    args.chord = v.split(',').map(str::to_string).collect();
                }
            }
            "--wav" => args.wav = it.next().map(PathBuf::from),
            "--model-dir" => {
                if let Some(v) = it.next() {
                    args.model_dir = PathBuf::from(v);
                }
            }
            other => log(&format!("ignoring argument {other}")),
        }
    }
    args
}

fn default_model_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default()
        .join("models")
        .join("zipformer")
}

fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|info| log(&format!("panic: {info}"))));
    let args = parse_args();
    let mut session = Session::new(SherpaZipformer::new(args.model_dir.clone()), Emitter::new(io::stdout()));
    let dry_run = args.wav.is_some();
    session.emit(&Event::Ready { engine: session.engine_name(), dry_run });
    if !args.chord.is_empty() {
        session.set_chord(&args.chord);
    }
    match args.wav {
        Some(path) => run_wav(&mut session, &path),
        None => run_live(&mut session),
    }
}

// ---------- --wav dry run ----------

fn run_wav(session: &mut Live, path: &Path) -> ExitCode {
    let (samples, rate) = match read_wav(path) {
        Ok(v) => v,
        Err(e) => {
            log(&format!("can't read {}: {e}", path.display()));
            session.emit(&Event::Error { code: ErrorCode::NoInput, spoke: None, message: Some(e) });
            return ExitCode::FAILURE;
        }
    };
    let mut resampler = match Resampler16k::new(rate) {
        Ok(r) => r,
        Err(e) => {
            session.emit(&Event::Error { code: ErrorCode::NoInput, spoke: None, message: Some(e) });
            return ExitCode::FAILURE;
        }
    };
    if session.listen(|| 0.0).is_err() {
        return ExitCode::FAILURE;
    }
    let mut audio = resampler.process(&samples);
    audio.extend(resampler.flush());
    // The clock follows sample time; hands-free auto-end is off so the whole file is heard.
    let chunk = (SAMPLE_RATE / 10) as usize;
    let mut t = 0.0;
    for c in audio.chunks(chunk) {
        session.audio(c, t);
        t += c.len() as f64 / SAMPLE_RATE as f64;
    }
    session.finish(t);
    session.tick(t + 1.0, &mut chord::NoKeys);
    ExitCode::SUCCESS
}

fn read_wav(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>().map_err(|e| e.to_string())?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample.clamp(1, 32) - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?
        }
    };
    Ok((audio::downmix(&interleaved, spec.channels as usize), spec.sample_rate))
}

// ---------- live ----------

enum Msg {
    Line(String),
    StdinClosed,
    Audio(u64, Vec<f32>),
    AudioFailed(u64, String),
}

fn run_live(session: &mut Live) -> ExitCode {
    let (tx, rx) = mpsc::channel::<Msg>();
    let stdin_tx = tx.clone();
    let reader = thread::Builder::new().name("stdin".into()).spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(l) => {
                    if stdin_tx.send(Msg::Line(l)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stdin_tx.send(Msg::StdinClosed);
    });
    if let Err(e) = reader {
        log(&format!("can't read stdin: {e}"));
        return ExitCode::FAILURE;
    }

    session.prepare();
    #[cfg(windows)]
    let mut keys = keys_windows::WinKeys;
    #[cfg(not(windows))]
    let mut keys = chord::NoKeys;
    // ~100 Hz key polling; a tap is 0.25 s and the release debounce 0.09 s.
    let every = Duration::from_millis(10);
    let mut next_tick = Instant::now();
    let clock = Instant::now();
    let now = || clock.elapsed().as_secs_f64();
    let mut mic: Option<(MicCapture, Resampler16k)> = None;
    // Chunks from a mic closed earlier are dropped by generation.
    let mut generation = 0u64;
    loop {
        match rx.recv_timeout(next_tick.saturating_duration_since(Instant::now())) {
            Ok(Msg::Line(line)) => match parse_command(&line) {
                Some(Command::Listen) => {
                    let _ = session.listen(now);
                }
                Some(Command::Cancel) => session.cancel(),
                Some(Command::Chord { mods }) => session.set_chord(&mods),
                Some(Command::Mute { on }) => log(&format!("mute while talking: {on}")),
                None => {}
            },
            Ok(Msg::StdinClosed) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Ok(Msg::Audio(g, chunk)) => {
                if let (true, Some((_, resampler))) = (g == generation, mic.as_mut()) {
                    let samples = resampler.process(&chunk);
                    session.audio(&samples, now());
                }
            }
            Ok(Msg::AudioFailed(g, e)) => {
                if g == generation {
                    log(&format!("mic: {e}"));
                    mic = None;
                    session.audio_failed();
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= next_tick {
            session.tick(now(), &mut keys);
            next_tick += every;
            // After a stall (model load, slow stdout) don't burst to catch up.
            next_tick = next_tick.max(Instant::now());
        }

        if session.wants_audio() && mic.is_none() {
            generation += 1;
            match open_mic(&tx, generation) {
                Ok(m) => mic = Some(m),
                Err(e) => {
                    log(&format!("mic: {e}"));
                    session.audio_failed();
                }
            }
        } else if !session.wants_audio() && mic.is_some() {
            mic = None;
            generation += 1;
        }
    }
    ExitCode::SUCCESS
}

fn open_mic(tx: &mpsc::Sender<Msg>, generation: u64) -> Result<(MicCapture, Resampler16k), String> {
    let chunk_tx = tx.clone();
    let err_tx = tx.clone();
    let capture = MicCapture::open(
        move |chunk| {
            let _ = chunk_tx.send(Msg::Audio(generation, chunk));
        },
        move |e| {
            let _ = err_tx.send(Msg::AudioFailed(generation, e));
        },
    )
    .map_err(|e| e.to_string())?;
    log(&format!("mic open at {} Hz", capture.rate));
    let resampler = Resampler16k::new(capture.rate)?;
    Ok((capture, resampler))
}

fn log(s: &str) {
    eprintln!("[voice] {s}");
}
