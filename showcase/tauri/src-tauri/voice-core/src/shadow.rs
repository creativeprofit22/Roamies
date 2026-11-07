//! Shadow role (`--shadow`): no mic, no keys, no chord. Reads only `transcribe` jobs and answers
//! each with one `shadow` event, so its text can never be mistaken for the user's (`final`).

use crate::engine::{SpeechEngine, SAMPLE_RATE};
use crate::metrics::Recorder;
use crate::pcm;
use crate::protocol::{parse_command, Command, Emitter, ErrorCode, Event};
use std::io::{self, BufRead, Write};
use std::time::Instant;

/// Same feed size as the live mic path (100 ms).
const CHUNK: usize = (SAMPLE_RATE / 10) as usize;

/// Transcribes one take; the engine sees the same start/accept/finish calls as a live talk.
pub fn transcribe<E: SpeechEngine>(engine: &mut E, request_id: &str, samples: &[f32], rss: Option<fn() -> Option<u64>>) -> Event {
    // Not real time, so no time-to-first-partial or revision rate: record it as finish-only.
    let mut rec = Recorder::new(false);
    let at = Instant::now();
    let started = engine.start();
    rec.warmup(at.elapsed());
    if started.is_err() {
        return Event::Shadow { request_id: request_id.into(), text: String::new(), metrics: None, error: Some(ErrorCode::Unavailable) };
    }
    for c in samples.chunks(CHUNK) {
        let at = Instant::now();
        engine.accept(c);
        let _ = engine.partial();
        rec.compute(at.elapsed());
        rec.audio(c.len());
    }
    rec.speech_end(0.0);
    let at = Instant::now();
    let text = engine.finish();
    let took = at.elapsed();
    let metrics = rec.finish(0.0, took, &text, rss.and_then(|f| f()));
    Event::Shadow { request_id: request_id.into(), text, metrics: Some(metrics), error: None }
}

/// The shadow loop: loads the model up front, then one `shadow` event per `transcribe` line.
/// Every other command is ignored.
pub fn run<E: SpeechEngine, R: BufRead, W: Write>(engine: &mut E, input: R, out: &mut Emitter<W>, rss: Option<fn() -> Option<u64>>) -> io::Result<()> {
    if let Err(e) = engine.prepare() {
        eprintln!("[voice] shadow: {e}");
    }
    for line in input.lines() {
        let Some(Command::Transcribe { request_id, pcm }) = parse_command(&line?) else { continue };
        let event = match pcm::decode(&pcm) {
            Some(samples) => transcribe(engine, &request_id, &samples, rss),
            None => Event::Shadow { request_id, text: String::new(), metrics: None, error: Some(ErrorCode::NoInput) },
        };
        out.emit(&event)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EngineError;
    use serde_json::{json, Value};

    /// Hears one word per 0.1 s of audio, and reports partials like a streaming engine.
    struct Words {
        heard: usize,
        ok: bool,
    }

    impl SpeechEngine for Words {
        fn name(&self) -> &str {
            "words"
        }
        fn start(&mut self) -> Result<(), EngineError> {
            self.heard = 0;
            if self.ok { Ok(()) } else { Err(EngineError::Unavailable("no model".into())) }
        }
        fn accept(&mut self, samples: &[f32]) {
            self.heard += samples.len();
        }
        fn partial(&mut self) -> Option<String> {
            Some(self.text())
        }
        fn finish(&mut self) -> String {
            self.text()
        }
        fn cancel(&mut self) {}
    }

    impl Words {
        fn text(&self) -> String {
            vec!["word"; self.heard / CHUNK].join(" ")
        }
    }

    fn lines(engine: &mut Words, input: &str) -> Vec<Value> {
        let mut out = Emitter::new(Vec::new());
        run(engine, input.as_bytes(), &mut out, None).unwrap();
        String::from_utf8(out.get_ref().clone()).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn only_shadow_events_come_out() {
        let pcm = pcm::encode(&vec![0.5; 3 * CHUNK]);
        let input = [
            json!({"cmd":"listen","request_id":"r0"}).to_string(),
            json!({"cmd":"shadow","on":true}).to_string(),
            json!({"cmd":"chord","mods":["control"]}).to_string(),
            json!({"cmd":"transcribe","request_id":"r1","pcm":pcm}).to_string(),
            "not json".into(),
            json!({"cmd":"transcribe","request_id":"r2","pcm":"!!"}).to_string(),
        ]
        .join("\n");
        let out = lines(&mut Words { heard: 0, ok: true }, &input);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|e| e["type"] == "shadow"));
        assert_eq!(out[0]["request_id"], "r1");
        assert_eq!(out[0]["text"], "word word word");
        let m = &out[0]["metrics"];
        assert_eq!(m["audio_s"], 0.3);
        assert_eq!(m["partial_count"], 0);
        assert!(m["time_to_first_partial_ms"].is_null());
        assert!(m.get("revision_rate").is_none());
        assert_eq!(m["empty"], false);
        assert_eq!(out[1], json!({"type":"shadow","request_id":"r2","text":"","error":"no_input"}));
    }

    #[test]
    fn a_missing_model_is_an_error_not_a_transcript() {
        let pcm = pcm::encode(&[0.5; 1600]);
        let input = json!({"cmd":"transcribe","request_id":"r","pcm":pcm}).to_string();
        let out = lines(&mut Words { heard: 0, ok: false }, &input);
        assert_eq!(out, vec![json!({"type":"shadow","request_id":"r","text":"","error":"unavailable"})]);
    }
}
