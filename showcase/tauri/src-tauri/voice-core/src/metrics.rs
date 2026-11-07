//! Per-talk speech KPIs (`final.metrics`, docs/voice-engines.md). Pure: the session passes in its
//! clock and the wall time it measured around each engine call.

use crate::engine::SAMPLE_RATE;
use crate::protocol::Metrics;
use std::time::Duration;

#[derive(Debug, Default)]
pub struct Recorder {
    streaming: bool,
    samples: usize,
    compute: Duration,
    warmup: Duration,
    started_at: Option<f64>,
    first_text_at: Option<f64>,
    speech_end_at: Option<f64>,
    partial_count: u32,
    last_shown: String,
    revised: usize,
    shown: usize,
}

/// Characters in `a` and `b` up to their first difference.
fn common_prefix(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

fn round(v: f64, places: i32) -> f64 {
    let k = 10f64.powi(places);
    (v * k).round() / k
}

impl Recorder {
    pub fn new(streaming: bool) -> Self {
        Recorder { streaming, ..Default::default() }
    }

    /// Forgets the last talk.
    pub fn reset(&mut self) {
        *self = Recorder::new(self.streaming);
    }

    /// The talk started at session time `now` (chord down, or `listen`).
    pub fn started(&mut self, now: f64) {
        self.started_at = Some(now);
    }

    pub fn warmup(&mut self, took: Duration) {
        self.warmup += took;
    }

    pub fn compute(&mut self, took: Duration) {
        self.compute += took;
    }

    pub fn audio(&mut self, samples: usize) {
        self.samples += samples;
    }

    /// The engine's text changed to `text` (non-empty) at `now`.
    pub fn partial(&mut self, now: f64, text: &str) {
        self.first_text_at.get_or_insert(now);
        self.partial_count += 1;
        self.revise(text);
    }

    fn revise(&mut self, next: &str) {
        let cp = common_prefix(&self.last_shown, next);
        self.revised += self.last_shown.chars().count() - cp;
        self.shown += next.chars().count() - cp;
        self.last_shown = next.to_string();
    }

    /// Speech ended (release, pause or end of file).
    pub fn speech_end(&mut self, now: f64) {
        self.speech_end_at.get_or_insert(now);
    }

    /// The take's numbers, once the final text is known at `now`; `final_took` is the engine's
    /// finish time, which happens after the session clock was read.
    pub fn finish(&mut self, now: f64, final_took: Duration, text: &str, peak_rss: Option<u64>) -> Metrics {
        self.compute += final_took;
        if self.streaming && text != self.last_shown {
            self.revise(text);
        }
        let audio_s = self.samples as f64 / SAMPLE_RATE as f64;
        let compute_s = self.compute.as_secs_f64();
        let tail = self.speech_end_at.map_or(0.0, |e| (now - e).max(0.0));
        Metrics {
            audio_s: round(audio_s, 3),
            compute_s: round(compute_s, 3),
            rtf: (audio_s > 0.0).then(|| round(compute_s / audio_s, 4)),
            warmup_ms: round(self.warmup.as_secs_f64() * 1000.0, 1),
            speech_end_to_final_ms: round((tail + final_took.as_secs_f64()) * 1000.0, 1),
            time_to_first_partial_ms: match (self.streaming, self.started_at, self.first_text_at) {
                (true, Some(s), Some(f)) => Some(round((f - s).max(0.0) * 1000.0, 1)),
                _ => None,
            },
            partial_count: self.partial_count,
            revision_rate: self
                .streaming
                .then(|| if self.shown == 0 { 0.0 } else { round(self.revised as f64 / self.shown as f64, 4) }),
            peak_rss_mb: peak_rss.map(|b| round(b as f64 / 1_048_576.0, 1)),
            empty: text.is_empty(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    #[test]
    fn streaming_take() {
        let mut r = Recorder::new(true);
        r.reset();
        r.started(1.0);
        r.warmup(MS(40));
        r.audio(32_000);
        r.compute(MS(300));
        r.partial(1.5, "hello word");
        // "hello word" -> "hello world": 1 char revised ("d"), 2 shown ("ld").
        r.partial(1.8, "hello world");
        r.speech_end(2.0);
        let m = r.finish(2.3, MS(100), "hello world.", Some(200 * 1_048_576));
        assert_eq!(m.audio_s, 2.0);
        assert_eq!(m.compute_s, 0.4);
        assert_eq!(m.rtf, Some(0.2));
        assert_eq!(m.warmup_ms, 40.0);
        assert_eq!(m.speech_end_to_final_ms, 400.0);
        assert_eq!(m.time_to_first_partial_ms, Some(500.0));
        assert_eq!(m.partial_count, 2);
        // shown: 10 + 2 + 1 = 13, revised: 1.
        assert_eq!(m.revision_rate, Some(round(1.0 / 13.0, 4)));
        assert_eq!(m.peak_rss_mb, Some(200.0));
        assert!(!m.empty);
    }

    #[test]
    fn finish_only_take_has_no_streaming_numbers() {
        let mut r = Recorder::new(false);
        r.reset();
        r.started(0.0);
        r.audio(16_000);
        r.speech_end(1.0);
        let m = r.finish(1.3, MS(500), "hi", None);
        assert_eq!(m.time_to_first_partial_ms, None);
        assert_eq!(m.revision_rate, None);
        assert_eq!(m.partial_count, 0);
        assert_eq!(m.rtf, Some(0.5));
        assert_eq!(m.speech_end_to_final_ms, 800.0);
        assert_eq!(m.peak_rss_mb, None);
    }

    #[test]
    fn empty_take_without_audio() {
        let mut r = Recorder::new(true);
        r.reset();
        r.started(0.0);
        let m = r.finish(0.0, Duration::ZERO, "", None);
        assert!(m.empty);
        assert_eq!(m.rtf, None);
        assert_eq!(m.revision_rate, Some(0.0));
        assert_eq!(m.time_to_first_partial_ms, None);
    }

    #[test]
    fn reset_forgets_the_last_talk() {
        let mut r = Recorder::new(true);
        r.reset();
        r.started(0.0);
        r.partial(0.1, "a");
        r.reset();
        r.started(5.0);
        r.partial(5.2, "b");
        let m = r.finish(5.3, Duration::ZERO, "b", None);
        assert_eq!((m.partial_count, m.revision_rate), (1, Some(0.0)));
        assert_eq!(m.time_to_first_partial_ms, Some(200.0));
    }
}
