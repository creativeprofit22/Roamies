// Audio in: the default microphone (Windows, via cpal/WASAPI) or a WAV file played in real time (dev
// tests), both mixed down to mono 16 kHz for Parakeet and metered for the listening animation.

use crate::{Ev, RATE};
#[cfg(windows)]
use crate::log;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// Mono, any rate in, 16 kHz out. Each output sample averages the input it covers (a box filter),
/// which is enough anti-aliasing for speech.
pub struct Resampler {
    step: f64,
    next: f64,
    base: usize,
    hist: Vec<f32>,
}

impl Resampler {
    pub fn new(rate: u32) -> Self {
        Resampler { step: rate as f64 / RATE as f64, next: 0.0, base: 0, hist: Vec::new() }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.step == 1.0 {
            return out.extend_from_slice(input);
        }
        self.hist.extend_from_slice(input);
        let half = (self.step / 2.0).max(0.5);
        loop {
            let lo = (self.next - half).floor().max(0.0) as usize;
            let hi = (self.next + half).ceil() as usize;
            if hi > self.base + self.hist.len() {
                break;
            }
            let s = &self.hist[lo - self.base..hi - self.base];
            out.push(s.iter().sum::<f32>() / s.len() as f32);
            self.next += self.step;
        }
        let keep = ((self.next - half).floor().max(0.0) as usize).max(self.base);
        self.hist.drain(..keep - self.base);
        self.base = keep;
    }
}

/// Where captured audio goes: the take buffer (16 kHz mono) and level events.
pub struct Sink {
    buf: Arc<Mutex<Vec<f32>>>,
    tx: Sender<Ev>,
    resampler: Option<Resampler>,
    channels: usize,
    mono: Vec<f32>,
    out: Vec<f32>,
}

impl Sink {
    pub fn new(buf: Arc<Mutex<Vec<f32>>>, tx: Sender<Ev>) -> Self {
        Sink { buf, tx, resampler: None, channels: 1, mono: Vec::new(), out: Vec::new() }
    }

    fn start(&mut self, rate: u32, channels: usize) {
        self.resampler = Some(Resampler::new(rate));
        self.channels = channels.max(1);
    }

    /// Interleaved samples at the rate and channel count given to start().
    pub fn feed(&mut self, data: &[f32]) {
        let ch = self.channels;
        self.mono.clear();
        self.mono.extend(data.chunks(ch).map(|f| f.iter().sum::<f32>() / f.len() as f32));
        if self.mono.is_empty() {
            return;
        }
        let rms = (self.mono.iter().map(|s| s * s).sum::<f32>() / self.mono.len() as f32).sqrt();
        // Same scale as the Mac helper: about -55 dB is silence, -15 dB is loud speech.
        let level = ((20.0 * rms.max(1e-7).log10() as f64 + 55.0) / 40.0).clamp(0.0, 1.0);
        self.out.clear();
        if let Some(r) = self.resampler.as_mut() {
            r.push(&self.mono, &mut self.out);
        }
        self.buf.lock().unwrap().extend_from_slice(&self.out);
        let _ = self.tx.send(Ev::Level(level));
    }
}

/// Recording stops when this is dropped.
pub struct Source {
    #[cfg(windows)]
    _stream: Option<cpal::Stream>,
    stop: Arc<AtomicBool>,
}

impl Drop for Source {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn read_wav(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut r = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = r.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / scale).collect()
        }
    };
    let ch = spec.channels.max(1) as usize;
    let mono: Vec<f32> = raw.chunks(ch).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect();
    let mut out = Vec::new();
    Resampler::new(spec.sample_rate).push(&mono, &mut out);
    Ok((out, RATE))
}

/// Dev stand-in for the mic: plays a WAV into the sink at real speed, then silence until stopped.
pub fn play_file(path: &Path, mut sink: Sink) -> Result<Source, String> {
    let (samples, _) = read_wav(path)?;
    sink.start(RATE, 1);
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        let chunk = RATE as usize / 50;
        let silence = vec![0.0f32; chunk];
        let mut i = 0;
        while !stop2.load(Ordering::Relaxed) {
            let piece = if i < samples.len() { &samples[i..(i + chunk).min(samples.len())] } else { &silence[..] };
            sink.feed(piece);
            i += chunk;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    });
    Ok(Source {
        #[cfg(windows)]
        _stream: None,
        stop,
    })
}

#[cfg(windows)]
pub fn has_input() -> bool {
    use cpal::traits::HostTrait;
    cpal::default_host().default_input_device().is_some()
}

#[cfg(not(windows))]
pub fn has_input() -> bool {
    false
}

#[cfg(windows)]
pub fn open_mic(mut sink: Sink) -> Result<Source, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample};

    fn build<T>(dev: &cpal::Device, cfg: cpal::StreamConfig, mut sink: Sink, err_tx: Sender<Ev>) -> Result<cpal::Stream, cpal::Error>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let mut tmp = Vec::new();
        dev.build_input_stream::<T, _, _>(
            cfg,
            move |data: &[T], _| {
                tmp.clear();
                tmp.extend(data.iter().map(|&s| s.to_sample::<f32>()));
                sink.feed(&tmp);
            },
            move |e| {
                let _ = err_tx.send(Ev::AudioFailed(e.to_string()));
            },
            None,
        )
    }

    let dev = cpal::default_host().default_input_device().ok_or("no microphone")?;
    let supported = dev.default_input_config().map_err(|e| e.to_string())?;
    sink.start(supported.sample_rate(), supported.channels() as usize);
    let err_tx = sink.tx.clone();
    let format = supported.sample_format();
    let cfg: cpal::StreamConfig = supported.into();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&dev, cfg, sink, err_tx),
        SampleFormat::I16 => build::<i16>(&dev, cfg, sink, err_tx),
        SampleFormat::I32 => build::<i32>(&dev, cfg, sink, err_tx),
        SampleFormat::U16 => build::<u16>(&dev, cfg, sink, err_tx),
        SampleFormat::I8 => build::<i8>(&dev, cfg, sink, err_tx),
        SampleFormat::U8 => build::<u8>(&dev, cfg, sink, err_tx),
        other => return Err(format!("unsupported sample format {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    log("microphone on");
    Ok(Source { _stream: Some(stream), stop: Arc::new(AtomicBool::new(false)) })
}

#[cfg(not(windows))]
pub fn open_mic(_sink: Sink) -> Result<Source, String> {
    Err("the microphone is only wired up on Windows (use --test-audio)".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_48k_to_16k_in_any_chunking() {
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.001).sin()).collect();
        let mut whole = Vec::new();
        Resampler::new(48_000).push(&input, &mut whole);
        let mut pieces = Vec::new();
        let mut r = Resampler::new(48_000);
        for c in input.chunks(441) {
            r.push(c, &mut pieces);
        }
        assert!((15_990..=16_000).contains(&whole.len()), "{}", whole.len());
        assert_eq!(whole, pieces);
        // A slow sine survives the box filter almost unchanged.
        assert!((whole[8000] - input[24_000]).abs() < 0.01);
    }

    #[test]
    fn resamples_44k1_and_passes_16k_through() {
        let mut out = Vec::new();
        Resampler::new(44_100).push(&vec![0.5; 44_100], &mut out);
        assert!((15_990..=16_000).contains(&out.len()), "{}", out.len());
        assert!(out.iter().all(|s| (s - 0.5).abs() < 1e-6));
        let mut same = Vec::new();
        Resampler::new(16_000).push(&[0.1, 0.2, 0.3], &mut same);
        assert_eq!(same, vec![0.1, 0.2, 0.3]);
    }
}
