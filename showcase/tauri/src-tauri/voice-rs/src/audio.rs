//! Mic capture (cpal), conversion to mono f32, real resampling to 16 kHz (rubato), and the level meter.

use crate::engine::SAMPLE_RATE;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Indexing, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioError {
    NoDevice,
    Stream(String),
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AudioError::NoDevice => write!(f, "no input device"),
            AudioError::Stream(why) => write!(f, "input stream: {why}"),
        }
    }
}

/// WASAPI on Windows, the platform default elsewhere (Handy's audio_toolkit/utils.rs pattern).
pub fn pick_host() -> cpal::Host {
    #[cfg(target_os = "windows")]
    {
        if let Ok(host) = cpal::host_from_id(cpal::HostId::Wasapi) {
            return host;
        }
    }
    cpal::default_host()
}

/// Averages interleaved frames of any sample format into mono f32.
pub fn downmix<T>(data: &[T], channels: usize) -> Vec<f32>
where
    T: Sample,
    f32: FromSample<T>,
{
    let channels = channels.max(1);
    data.chunks(channels)
        .map(|frame| frame.iter().map(|&s| f32::from_sample(s)).sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Microphone level 0-1 from RMS, the same curve as the Mac helper.
pub fn level(samples: &[f32]) -> f64 {
    let n = samples.len().max(1) as f64;
    let rms = (samples.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / n).sqrt();
    ((20.0 * rms.max(1e-7).log10() + 55.0) / 40.0).clamp(0.0, 1.0)
}

/// An open input stream; capture stops when it's dropped.
pub struct MicCapture {
    _stream: cpal::Stream,
    pub rate: u32,
}

impl MicCapture {
    /// Opens the default input device. `on_chunk` gets mono f32 at `rate`; `on_error` gets stream failures.
    pub fn open<C, E>(on_chunk: C, on_error: E) -> Result<Self, AudioError>
    where
        C: FnMut(Vec<f32>) + Send + 'static,
        E: FnMut(String) + Send + 'static,
    {
        let device = pick_host().default_input_device().ok_or(AudioError::NoDevice)?;
        let supported = device.default_input_config().map_err(|e| AudioError::Stream(e.to_string()))?;
        let config = supported.config();
        let rate = config.sample_rate;
        let channels = config.channels as usize;
        if rate == 0 || channels == 0 {
            return Err(AudioError::NoDevice);
        }
        let stream = match supported.sample_format() {
            SampleFormat::F32 => build::<f32, _, _>(&device, config, channels, on_chunk, on_error),
            SampleFormat::F64 => build::<f64, _, _>(&device, config, channels, on_chunk, on_error),
            SampleFormat::I8 => build::<i8, _, _>(&device, config, channels, on_chunk, on_error),
            SampleFormat::I16 => build::<i16, _, _>(&device, config, channels, on_chunk, on_error),
            SampleFormat::I32 => build::<i32, _, _>(&device, config, channels, on_chunk, on_error),
            SampleFormat::U8 => build::<u8, _, _>(&device, config, channels, on_chunk, on_error),
            SampleFormat::U16 => build::<u16, _, _>(&device, config, channels, on_chunk, on_error),
            SampleFormat::U32 => build::<u32, _, _>(&device, config, channels, on_chunk, on_error),
            other => Err(AudioError::Stream(format!("unsupported sample format {other}"))),
        }?;
        stream.play().map_err(|e| AudioError::Stream(e.to_string()))?;
        Ok(MicCapture { _stream: stream, rate })
    }
}

fn build<T, C, E>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    mut on_chunk: C,
    mut on_error: E,
) -> Result<cpal::Stream, AudioError>
where
    T: SizedSample,
    f32: FromSample<T>,
    C: FnMut(Vec<f32>) + Send + 'static,
    E: FnMut(String) + Send + 'static,
{
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| on_chunk(downmix(data, channels)),
            move |err: cpal::Error| {
                if is_fatal(err.kind()) {
                    on_error(err.to_string());
                } else {
                    eprintln!("[voice] mic: {err}");
                }
            },
            None,
        )
        .map_err(|e| AudioError::Stream(e.to_string()))
}

/// Glitches and reroutes leave the stream running; only these other kinds end the session.
fn is_fatal(kind: cpal::ErrorKind) -> bool {
    !matches!(kind, cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied)
}

const CHUNK: usize = 1024;

/// Streaming band-limited (sinc) resampler from the device rate to 16 kHz; passthrough at 16 kHz.
pub struct Resampler16k {
    inner: Option<Async<f32>>,
    pending: Vec<f32>,
    out: Vec<f32>,
}

impl Resampler16k {
    pub fn new(from_rate: u32) -> Result<Self, String> {
        if from_rate == 0 {
            return Err("sample rate 0".into());
        }
        if from_rate == SAMPLE_RATE {
            return Ok(Resampler16k { inner: None, pending: Vec::new(), out: Vec::new() });
        }
        let params = SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: Some(0.95),
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };
        let ratio = SAMPLE_RATE as f64 / from_rate as f64;
        let inner = Async::<f32>::new_sinc(ratio, 1.0, &params, CHUNK, 1, FixedAsync::Input).map_err(|e| e.to_string())?;
        let out = vec![0.0; inner.output_frames_max()];
        Ok(Resampler16k { inner: Some(inner), pending: Vec::new(), out })
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let Some(r) = self.inner.as_mut() else { return input.to_vec() };
        self.pending.extend_from_slice(input);
        let mut result = Vec::new();
        loop {
            let need = r.input_frames_next();
            if self.pending.len() < need {
                break;
            }
            match run(r, &self.pending[..need], &mut self.out, None) {
                Ok((used, made)) => {
                    result.extend_from_slice(&self.out[..made]);
                    self.pending.drain(..used.max(1).min(self.pending.len()));
                }
                Err(e) => {
                    log(&format!("resample: {e}"));
                    self.pending.clear();
                    break;
                }
            }
        }
        result
    }

    /// Pushes out what's buffered (padded with silence) at the end of a clip.
    pub fn flush(&mut self) -> Vec<f32> {
        let Some(r) = self.inner.as_mut() else { return Vec::new() };
        let mut result = Vec::new();
        let left = std::mem::take(&mut self.pending);
        let need = r.input_frames_next();
        let mut buf = left;
        buf.resize(need.max(buf.len()), 0.0);
        let partial = Indexing { partial_len: Some(buf.len().min(need)), ..Indexing::default() };
        if let Ok((_, made)) = run(r, &buf[..need], &mut self.out, Some(&partial)) {
            result.extend_from_slice(&self.out[..made]);
        }
        result
    }
}

fn run(r: &mut Async<f32>, input: &[f32], out: &mut [f32], indexing: Option<&Indexing>) -> Result<(usize, usize), String> {
    let frames_out = out.len();
    let inp = InterleavedSlice::new(input, 1, input.len()).map_err(|e| e.to_string())?;
    let mut outp = InterleavedSlice::new_mut(out, 1, frames_out).map_err(|e| e.to_string())?;
    r.process_into_buffer(&inp, &mut outp, indexing).map_err(|e| e.to_string())
}

fn log(s: &str) {
    eprintln!("[voice] {s}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, rate: u32, secs: f64) -> Vec<f32> {
        let n = (rate as f64 * secs) as usize;
        (0..n).map(|i| (0.5 * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin()) as f32).collect()
    }

    fn resample_all(from: u32, input: &[f32]) -> Vec<f32> {
        let mut r = Resampler16k::new(from).unwrap();
        let mut out = Vec::new();
        for chunk in input.chunks(480) {
            out.extend(r.process(chunk));
        }
        out.extend(r.flush());
        out
    }

    fn rms(s: &[f32]) -> f64 {
        (s.iter().map(|&x| (x as f64).powi(2)).sum::<f64>() / s.len().max(1) as f64).sqrt()
    }

    #[test]
    fn downmixes_every_sample_format() {
        assert_eq!(downmix(&[0.5f32, -0.5, 1.0, 0.0], 2), vec![0.0, 0.5]);
        assert_eq!(downmix(&[0.25f64, 0.75], 2), vec![0.5]);
        assert_eq!(downmix(&[i16::MAX, i16::MAX, 0, 0], 2), vec![f32::from_sample(i16::MAX), 0.0]);
        assert_eq!(downmix(&[0i8, 0], 1), vec![0.0, 0.0]);
        assert_eq!(downmix(&[i32::MIN], 1), vec![-1.0]);
        assert_eq!(downmix(&[u16::MAX / 2 + 1, u16::MAX / 2 + 1], 2), vec![0.0]);
        assert_eq!(downmix(&[128u8, 128, 128], 3), vec![0.0]);
        assert_eq!(downmix(&[u32::MAX / 2 + 1], 1), vec![0.0]);
        assert_eq!(downmix::<f32>(&[0.1, 0.2, 0.3], 1).len(), 3);
        assert!(downmix(&[u8::MAX], 1)[0] > 0.99);
    }

    #[test]
    fn overruns_and_reroutes_are_not_fatal() {
        assert!(!is_fatal(cpal::ErrorKind::Xrun));
        assert!(!is_fatal(cpal::ErrorKind::DeviceChanged));
        assert!(is_fatal(cpal::ErrorKind::DeviceNotAvailable));
    }

    #[test]
    fn resamples_48k_to_16k_length() {
        let out = resample_all(48_000, &tone(440.0, 48_000, 1.0));
        assert!((out.len() as i64 - 16_000).abs() < 400, "got {}", out.len());
    }

    #[test]
    fn keeps_a_1khz_tone_at_1khz() {
        let out = resample_all(48_000, &tone(1000.0, 48_000, 1.0));
        let mid = &out[2000..14_000];
        let crossings = mid.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        // 12000 samples at 16 kHz = 0.75 s of 1 kHz = 750 cycles = 1500 zero crossings.
        assert!((crossings as i64 - 1500).abs() <= 5, "crossings {crossings}");
        assert!((rms(mid) - 0.5 / 2f64.sqrt()).abs() < 0.02, "rms {}", rms(mid));
    }

    #[test]
    fn filters_above_nyquist_instead_of_aliasing() {
        // Naive 3:1 decimation would fold a 10 kHz tone to 6 kHz at full strength.
        let out = resample_all(48_000, &tone(10_000.0, 48_000, 1.0));
        assert!(rms(&out[2000..14_000]) < 0.01, "rms {}", rms(&out[2000..14_000]));
    }

    #[test]
    fn handles_44k1_and_passthrough() {
        let out = resample_all(44_100, &tone(440.0, 44_100, 1.0));
        assert!((out.len() as i64 - 16_000).abs() < 400, "got {}", out.len());
        let same = tone(440.0, 16_000, 0.1);
        assert_eq!(resample_all(16_000, &same), same);
        assert!(Resampler16k::new(0).is_err());
    }

    #[test]
    fn level_is_bounded() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 160]), 0.0);
        assert_eq!(level(&[1.0; 160]), 1.0);
        let mid = level(&[0.01; 160]);
        assert!((mid - 0.375).abs() < 1e-6, "{mid}");
    }
}
