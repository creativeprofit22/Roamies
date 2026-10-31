//! roamies-voice-parakeet: Windows voice helper with NVIDIA Parakeet. Wiring only; see the modules
//! and roamies-voice-core for behaviour. Same JSON lines in and out as roamies-voice-moonshine.
//!
//! roamies-voice-parakeet [--model-dir <dir>] [--chord control,option]   normal use (Roamies starts it)
//! roamies-voice-parakeet --perms                                       prints {"type":"perms",…}
//! roamies-voice-parakeet --wav <file>                                  dev: a WAV stands in for the mic
//! roamies-voice-parakeet --bench <dir>                                 dev: WER over wav+txt pairs

mod audio;
mod bench;
mod engine;
mod keys;

use audio::{MicCapture, Resampler};
use engine::Parakeet;
use roamies_voice_core::chord::{self, KeySource};
use roamies_voice_core::engine::SAMPLE_RATE;
use roamies_voice_core::protocol::{parse_command, Command, Emitter, ErrorCode, Event, MicStatus};
use roamies_voice_core::session::Session;
use std::io::{self, BufRead, Stdout};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

type Live = Session<Parakeet, Stdout>;

#[derive(Default)]
struct Args {
    chord: Vec<String>,
    model_dir: Option<PathBuf>,
    wav: Option<PathBuf>,
    bench: Option<PathBuf>,
    perms: bool,
}

fn parse_args() -> Args {
    let mut args = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--chord" => {
                if let Some(v) = it.next() {
                    args.chord = v.split(',').map(str::to_string).collect();
                }
            }
            // --model is the old name, still accepted.
            "--model-dir" | "--model" => args.model_dir = it.next().map(PathBuf::from).or(args.model_dir),
            "--wav" => args.wav = it.next().map(PathBuf::from),
            "--bench" => args.bench = it.next().map(PathBuf::from),
            // Windows has no mic prompt for desktop apps, so --request just reports like --perms.
            "--perms" => args.perms = true,
            "--request" => {
                it.next();
                args.perms = true;
            }
            other => log(&format!("ignoring argument {other}")),
        }
    }
    args
}

// Packaged builds ship models/parakeet next to the exe; dev builds use the crate's fetched models/.
fn default_model_dir() -> PathBuf {
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_default();
    let packaged = exe_dir.join("models").join("parakeet");
    if packaged.is_dir() {
        packaged
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("models").join("parakeet")
    }
}

fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|info| log(&format!("panic: {info}"))));
    let args = parse_args();
    if args.perms {
        let _ = Emitter::new(io::stdout()).emit(&Event::Perms { mic: keys::mic_status(), input: audio::has_input() });
        return ExitCode::SUCCESS;
    }
    let model_dir = args.model_dir.clone().unwrap_or_else(default_model_dir);
    let mut engine = Parakeet::new(model_dir.clone());
    if let Some(dir) = &args.bench {
        return bench::run(&mut engine, dir, &model_dir);
    }
    let mut session = Session::new(engine, Emitter::new(io::stdout()));
    session.emit(&Event::Ready { engine: session.engine_name(), model: session.engine_model(), dry_run: args.wav.is_some() });
    if !args.chord.is_empty() {
        session.set_chord(&args.chord);
    }
    match &args.wav {
        Some(path) => run_wav(&mut session, path),
        None => run_live(&mut session),
    }
}

// ---------- --wav dry run ----------

fn run_wav(session: &mut Live, path: &Path) -> ExitCode {
    let audio = match audio::read_wav(path) {
        Ok(a) => a,
        Err(e) => {
            log(&format!("can't read {}: {e}", path.display()));
            session.emit(&Event::Error { code: ErrorCode::NoInput, spoke: None, message: Some(e), what: None });
            return ExitCode::FAILURE;
        }
    };
    if session.listen(|| 0.0).is_err() {
        return ExitCode::FAILURE;
    }
    // The clock follows sample time and nothing ticks until the end, so the whole file is heard.
    let mut t = 0.0;
    for c in audio.chunks((SAMPLE_RATE / 10) as usize) {
        session.audio(c, t);
        t += c.len() as f64 / SAMPLE_RATE as f64;
    }
    session.finish(t);
    session.tick(t + 1.0, &mut chord::NoKeys);
    ExitCode::SUCCESS
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
    let mut keys = key_source();
    // ~100 Hz key polling; a tap is 0.25 s and the release debounce 0.09 s.
    let every = Duration::from_millis(10);
    let mut next_tick = Instant::now();
    let clock = Instant::now();
    let now = || clock.elapsed().as_secs_f64();
    let mut mic: Option<(MicCapture, Resampler)> = None;
    // Chunks from a mic closed earlier are dropped by generation.
    let mut generation = 0u64;
    loop {
        match rx.recv_timeout(next_tick.saturating_duration_since(Instant::now())) {
            Ok(Msg::Line(line)) => match parse_command(&line) {
                Some(Command::Listen { request_id }) => {
                    let _ = session.listen_with(request_id, now);
                }
                Some(Command::Request { request_id }) => session.set_request_id(&request_id),
                Some(Command::Telemetry { on }) => session.set_telemetry(on),
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
            session.tick(now(), keys.as_mut());
            next_tick += every;
            // After a stall (a model load or a long read) don't burst to catch up.
            next_tick = next_tick.max(Instant::now());
        }

        if session.wants_audio() && mic.is_none() {
            generation += 1;
            match open_mic(&tx, generation) {
                Ok(m) => mic = Some(m),
                Err(e) => {
                    log(&format!("mic: {e}"));
                    if keys::mic_status() == MicStatus::Denied {
                        session.mic_denied();
                    } else {
                        session.audio_failed();
                    }
                }
            }
        } else if !session.wants_audio() && mic.is_some() {
            mic = None;
            generation += 1;
        }
    }
    ExitCode::SUCCESS
}

#[cfg(windows)]
fn key_source() -> Box<dyn KeySource> {
    Box::new(keys::WinKeys)
}

#[cfg(not(windows))]
fn key_source() -> Box<dyn KeySource> {
    Box::new(chord::NoKeys)
}

fn open_mic(tx: &mpsc::Sender<Msg>, generation: u64) -> Result<(MicCapture, Resampler), String> {
    let chunk_tx = tx.clone();
    let err_tx = tx.clone();
    let capture = MicCapture::open(
        move |chunk| {
            let _ = chunk_tx.send(Msg::Audio(generation, chunk));
        },
        move |e| {
            let _ = err_tx.send(Msg::AudioFailed(generation, e));
        },
    )?;
    log(&format!("mic open at {} Hz", capture.rate));
    let resampler = Resampler::new(capture.rate);
    Ok((capture, resampler))
}

fn log(s: &str) {
    eprintln!("[voice] {s}");
}
