//! Shared core of the Windows voice helpers: the JSON-lines protocol, the engine seam, the talk
//! chord state machine, the session that runs it, and bench scoring.

pub mod chord;
pub mod engine;
pub mod level;
pub mod metrics;
pub mod pcm;
pub mod protocol;
pub mod score;
pub mod session;
pub mod shadow;
pub mod telemetry;
