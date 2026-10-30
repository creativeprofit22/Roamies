//! The engine seam: anything that turns 16 kHz mono f32 audio into text.

use std::fmt;

pub const SAMPLE_RATE: u32 = 16_000;

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
    /// Begins a new utterance, dropping anything left from the last one.
    fn start(&mut self) -> Result<(), EngineError>;
    /// Feeds 16 kHz mono samples in [-1, 1].
    fn accept(&mut self, samples: &[f32]);
    /// The whole session's text so far, when it changed since the last call.
    fn partial(&mut self) -> Option<String>;
    /// Ends the utterance and returns its full text (empty when nothing was heard).
    fn finish(&mut self) -> String;
    fn cancel(&mut self);
}
