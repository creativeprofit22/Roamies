//! Audio in: the default microphone (Windows, via cpal/WASAPI) as mono f32 at the device rate, a
//! box-filter resampler to 16 kHz for Parakeet, and WAV reading for `--wav` and `--bench`.

use roamies_voice_core::engine::SAMPLE_RATE;
use std::path::Path;

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
        Resampler { step: rate.max(1) as f64 / SAMPLE_RATE as f64, next: 0.0, base: 0, hist: Vec::new() }
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

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        self.push(input, &mut out);
        out
    }
}

/// Averages interleaved frames into mono.
pub fn downmix(data: &[f32], channels: usize) -> Vec<f32> {
    data.chunks(channels.max(1)).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect()
}

/// Any WAV as 16 kHz mono f32.
pub fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut r = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = r.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().collect::<Result<_, _>>().map_err(|e| e.to_string())?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample.clamp(1, 32) - 1)) as f32;
            r.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>().map_err(|e| e.to_string())?
        }
    };
    Ok(Resampler::new(spec.sample_rate).process(&downmix(&raw, spec.channels as usize)))
}

#[cfg(windows)]
pub use mic::*;

#[cfg(windows)]
mod mic {
    use super::downmix;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample};

    /// Whether a default mic exists, for the setup guide's "no microphone" row.
    pub fn has_input() -> bool {
        cpal::default_host().default_input_device().is_some()
    }

    /// An open input stream; capture stops when it's dropped.
    pub struct MicCapture {
        _stream: cpal::Stream,
        pub rate: u32,
    }

    impl MicCapture {
        /// Opens the default input device. `on_chunk` gets mono f32 at `rate`; `on_error` gets stream failures.
        pub fn open<C, E>(on_chunk: C, on_error: E) -> Result<Self, String>
        where
            C: FnMut(Vec<f32>) + Send + 'static,
            E: FnMut(String) + Send + 'static,
        {
            let device = cpal::default_host().default_input_device().ok_or("no input device")?;
            let supported = device.default_input_config().map_err(|e| e.to_string())?;
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let (rate, channels) = (config.sample_rate, config.channels as usize);
            if rate == 0 || channels == 0 {
                return Err("no input device".into());
            }
            let stream = match format {
                SampleFormat::F32 => build::<f32, _, _>(&device, config, channels, on_chunk, on_error),
                SampleFormat::I16 => build::<i16, _, _>(&device, config, channels, on_chunk, on_error),
                SampleFormat::I32 => build::<i32, _, _>(&device, config, channels, on_chunk, on_error),
                SampleFormat::U16 => build::<u16, _, _>(&device, config, channels, on_chunk, on_error),
                SampleFormat::I8 => build::<i8, _, _>(&device, config, channels, on_chunk, on_error),
                SampleFormat::U8 => build::<u8, _, _>(&device, config, channels, on_chunk, on_error),
                other => Err(format!("unsupported sample format {other:?}")),
            }?;
            stream.play().map_err(|e| e.to_string())?;
            Ok(MicCapture { _stream: stream, rate })
        }
    }

    fn build<T, C, E>(device: &cpal::Device, config: cpal::StreamConfig, channels: usize, mut on_chunk: C, mut on_error: E) -> Result<cpal::Stream, String>
    where
        T: SizedSample,
        f32: FromSample<T>,
        C: FnMut(Vec<f32>) + Send + 'static,
        E: FnMut(String) + Send + 'static,
    {
        let mut tmp = Vec::new();
        device
            .build_input_stream::<T, _, _>(
                config,
                move |data: &[T], _: &cpal::InputCallbackInfo| {
                    tmp.clear();
                    tmp.extend(data.iter().map(|&s| s.to_sample::<f32>()));
                    on_chunk(downmix(&tmp, channels));
                },
                move |e: cpal::Error| on_error(e.to_string()),
                None,
            )
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
pub use nomic::*;

// Elsewhere there's no mic: only `--wav` and `--bench` feed audio.
#[cfg(not(windows))]
mod nomic {
    pub fn has_input() -> bool {
        false
    }

    pub struct MicCapture {
        pub rate: u32,
    }

    impl MicCapture {
        pub fn open<C, E>(_on_chunk: C, _on_error: E) -> Result<Self, String>
        where
            C: FnMut(Vec<f32>) + Send + 'static,
            E: FnMut(String) + Send + 'static,
        {
            Err("the microphone is only wired up on Windows (use --wav)".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_48k_to_16k_in_any_chunking() {
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.001).sin()).collect();
        let whole = Resampler::new(48_000).process(&input);
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
        let out = Resampler::new(44_100).process(&vec![0.5; 44_100]);
        assert!((15_990..=16_000).contains(&out.len()), "{}", out.len());
        assert!(out.iter().all(|s| (s - 0.5).abs() < 1e-6));
        assert_eq!(Resampler::new(16_000).process(&[0.1, 0.2, 0.3]), vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn downmixes_stereo() {
        assert_eq!(downmix(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix(&[0.25], 0), vec![0.25]);
    }

    #[test]
    fn reads_wavs_as_16k_mono_and_reports_bad_files() {
        let path = std::env::temp_dir().join(format!("roamies-parakeet-wav-{}.wav", std::process::id()));
        let spec = hound::WavSpec { channels: 2, sample_rate: 32_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..32_000 {
            w.write_sample(16_384i16).unwrap();
            w.write_sample(0i16).unwrap();
        }
        w.finalize().unwrap();
        let audio = read_wav(&path).unwrap();
        assert!((15_990..=16_000).contains(&audio.len()), "{}", audio.len());
        assert!(audio.iter().all(|s| (s - 0.25).abs() < 1e-4));
        std::fs::write(&path, b"not a wav").unwrap();
        assert!(read_wav(&path).is_err());
        std::fs::remove_file(&path).unwrap();
    }
}
