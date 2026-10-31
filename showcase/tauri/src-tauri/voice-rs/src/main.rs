//! roamies-voice-moonshine: Windows voice helper. Wiring only; see the modules for behaviour.

mod audio;
mod bench;
mod engines;
mod keys_windows;
mod perms;
mod record;

use roamies_voice_core::{chord, engine, protocol, session};

use audio::{MicCapture, Resampler16k};
use engine::{SpeechEngine, SAMPLE_RATE};
use engines::moonshine::Size;
use engines::{Moonshine, SherpaZipformer};
use protocol::{parse_command, Command, Emitter, ErrorCode, Event};
use session::Session;
use std::io::{self, BufRead, Stdout};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

type Live = Session<Box<dyn SpeechEngine>, Stdout>;

struct Args {
    chord: Vec<String>,
    wav: Option<PathBuf>,
    bench: Option<PathBuf>,
    record: Option<PathBuf>,
    prompts: Option<PathBuf>,
    engine: String,
    moonshine_size: String,
    moonshine_lib: Option<PathBuf>,
    model_dir: Option<PathBuf>,
    perms: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        chord: Vec::new(),
        wav: None,
        bench: None,
        record: None,
        prompts: None,
        engine: "moonshine".into(),
        moonshine_size: "small".into(),
        moonshine_lib: None,
        model_dir: None,
        perms: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--chord" => {
                if let Some(v) = it.next() {
                    args.chord = v.split(',').map(str::to_string).collect();
                }
            }
            "--wav" => args.wav = it.next().map(PathBuf::from),
            "--bench" => args.bench = it.next().map(PathBuf::from),
            // Windows has no mic prompt for desktop apps, so --request just reports like --perms.
            "--perms" => args.perms = true,
            "--request" => {
                it.next();
                args.perms = true;
            }
            "--record" => args.record = it.next().map(PathBuf::from),
            "--prompts" => args.prompts = it.next().map(PathBuf::from),
            "--model-dir" => args.model_dir = it.next().map(PathBuf::from).or(args.model_dir),
            "--engine" => args.engine = it.next().unwrap_or(args.engine),
            "--moonshine-size" => args.moonshine_size = it.next().unwrap_or(args.moonshine_size),
            "--moonshine-lib" => args.moonshine_lib = it.next().map(PathBuf::from).or(args.moonshine_lib),
            other => log(&format!("ignoring argument {other}")),
        }
    }
    args
}

fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_default()
}

fn moonshine_lib_name() -> &'static str {
    if cfg!(windows) {
        "moonshine.dll"
    } else if cfg!(target_os = "macos") {
        "libmoonshine.dylib"
    } else {
        "libmoonshine.so"
    }
}

// Packaged builds ship models/ next to the exe; dev builds use the crate's fetched models/.
fn models_root() -> PathBuf {
    let packaged = exe_dir().join("models");
    if packaged.is_dir() {
        packaged
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("models")
    }
}

// Next to the exe when packaged; fetch-moonshine.sh puts it under models/moonshine-runtime.
fn default_moonshine_lib() -> PathBuf {
    let next_to_exe = exe_dir().join(moonshine_lib_name());
    let fetched = models_root().join("moonshine-runtime").join(moonshine_lib_name());
    if !next_to_exe.is_file() && fetched.is_file() {
        fetched
    } else {
        next_to_exe
    }
}

fn build_engine(args: &Args) -> Result<(Box<dyn SpeechEngine>, bench::BenchInfo), String> {
    match args.engine.as_str() {
        "zipformer" => {
            let dir = args.model_dir.clone().unwrap_or_else(|| models_root().join("zipformer"));
            // sherpa-onnx and its ONNX Runtime are linked into the exe.
            let runtime = std::env::current_exe().into_iter().collect();
            Ok((Box::new(SherpaZipformer::new(dir.clone())), bench::BenchInfo { model_dir: dir, runtime }))
        }
        "moonshine" => {
            let size = Size::parse(&args.moonshine_size)
                .ok_or_else(|| format!("unknown --moonshine-size {} (tiny, small or medium)", args.moonshine_size))?;
            let dir = args.model_dir.clone().unwrap_or_else(|| models_root().join(format!("moonshine-{}", size.as_str())));
            let lib = args.moonshine_lib.clone().unwrap_or_else(default_moonshine_lib);
            let ort = lib.with_file_name(if cfg!(windows) { "onnxruntime.dll" } else { "libonnxruntime.so" });
            let info = bench::BenchInfo { model_dir: dir.clone(), runtime: vec![lib.clone(), ort] };
            Ok((Box::new(Moonshine::new(lib, dir, size)), info))
        }
        other => Err(format!("unknown --engine {other} (zipformer or moonshine)")),
    }
}

fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|info| log(&format!("panic: {info}"))));
    let args = parse_args();
    if args.perms {
        let _ = Emitter::new(io::stdout()).emit(&Event::Perms { mic: perms::mic(), input: audio::has_input() });
        return ExitCode::SUCCESS;
    }
    if let Some(dir) = &args.record {
        return record::run(dir, args.prompts.as_deref());
    }
    let (mut engine, info) = match build_engine(&args) {
        Ok(e) => e,
        Err(e) => {
            log(&e);
            let _ = Emitter::new(io::stdout()).emit(&Event::Error { code: ErrorCode::Unavailable, spoke: None, message: Some(e), what: None });
            return ExitCode::FAILURE;
        }
    };
    if let Some(dir) = &args.bench {
        return bench::run(&mut *engine, dir, &info);
    }
    let mut session = Session::new(engine, Emitter::new(io::stdout()));
    let dry_run = args.wav.is_some();
    session.emit(&Event::Ready { engine: session.engine_name(), model: session.engine_model(), dry_run });
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
            session.emit(&Event::Error { code: ErrorCode::NoInput, spoke: None, message: Some(e), what: None });
            return ExitCode::FAILURE;
        }
    };
    let mut resampler = match Resampler16k::new(rate) {
        Ok(r) => r,
        Err(e) => {
            session.emit(&Event::Error { code: ErrorCode::NoInput, spoke: None, message: Some(e), what: None });
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
                    if perms::mic() == perms::Status::Denied {
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
