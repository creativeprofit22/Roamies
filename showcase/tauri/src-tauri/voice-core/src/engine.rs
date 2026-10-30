//! The engine seam: anything that turns 16 kHz mono f32 audio into text.

use std::fmt;

pub const SAMPLE_RATE: u32 = 16_000;
/// Mic level (see `level::level`) above which a chunk counts as voice.
pub const VOICE_LEVEL: f64 = 0.2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// The model or runtime can't be loaded; maps to the `unavailable` error code.
    Unavailable(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Unavailable(why) => write!(f, "engine unavailable: {why}"),
        }
    }
}

pub trait SpeechEngine {
    fn name(&self) -> &str;
    /// Which model this engine runs, when it knows (reported in `ready`).
    fn model(&self) -> Option<String> {
        None
    }
    /// Begins a new utterance, dropping anything left from the last one.
    fn start(&mut self) -> Result<(), EngineError>;
    /// Feeds 16 kHz mono samples in [-1, 1].
    fn accept(&mut self, samples: &[f32]);
    /// The whole session's text so far, when it changed since the last call.
    fn partial(&mut self) -> Option<String>;
    /// Ends the utterance and returns its full text (empty when nothing was heard).
    fn finish(&mut self) -> String;
    fn cancel(&mut self);
    /// Loads whatever `start` needs ahead of time, so arming never waits on a model load.
    fn prepare(&mut self) -> Result<(), EngineError> {
        Ok(())
    }
    /// True once after the engine closed a nonempty segment at a pause (its endpoint rule).
    fn endpoint(&mut self) -> bool {
        false
    }
    /// False for engines that only produce text in `finish` (no partials): hands-free then ends on
    /// a pause in the voice instead of a pause in the text.
    fn streaming(&self) -> bool {
        true
    }
    /// Mic level that counts as voice; a finish-only engine returns the level it reads takes at, so
    /// hands-free never cancels a take the engine would have read.
    fn voice_level(&self) -> f64 {
        VOICE_LEVEL
    }
}

impl<T: SpeechEngine + ?Sized> SpeechEngine for Box<T> {
    fn name(&self) -> &str {
        (**self).name()
    }
    fn model(&self) -> Option<String> {
        (**self).model()
    }
    fn start(&mut self) -> Result<(), EngineError> {
        (**self).start()
    }
    fn accept(&mut self, samples: &[f32]) {
        (**self).accept(samples)
    }
    fn partial(&mut self) -> Option<String> {
        (**self).partial()
    }
    fn finish(&mut self) -> String {
        (**self).finish()
    }
    fn cancel(&mut self) {
        (**self).cancel()
    }
    fn prepare(&mut self) -> Result<(), EngineError> {
        (**self).prepare()
    }
    fn endpoint(&mut self) -> bool {
        (**self).endpoint()
    }
    fn streaming(&self) -> bool {
        (**self).streaming()
    }
    fn voice_level(&self) -> f64 {
        (**self).voice_level()
    }
}
