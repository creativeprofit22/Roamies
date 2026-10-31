//! The JSON-lines protocol shared with the Roamies host (same shapes as voice/main.swift).

use serde::{Deserialize, Serialize};
use std::io::{self, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Listening,
    Processing,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Handsfree,
    Hold,
}

/// Microphone access as the OS reports it (`--perms`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MicStatus {
    Granted,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NoInput,
    Unavailable,
    NothingHeard,
    Permission,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    Ready {
        engine: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(rename = "dryRun", skip_serializing_if = "std::ops::Not::not")]
        dry_run: bool,
    },
    State {
        state: SessionState,
        #[serde(skip_serializing_if = "Option::is_none")]
        mode: Option<Mode>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
    },
    Partial {
        text: String,
    },
    Level {
        v: f64,
    },
    Final {
        text: String,
    },
    Error {
        code: ErrorCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        spoke: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        what: Option<&'static str>,
    },
    Perms {
        mic: MicStatus,
        input: bool,
    },
    /// One schema v1 telemetry event (docs/telemetry.md); the host forwards it to the sidecar.
    Telemetry {
        event: serde_json::Value,
    },
}

impl Event {
    pub fn state(state: SessionState) -> Self {
        Event::State { state, mode: None, cancelled: None }
    }

    pub fn level(v: f64) -> Self {
        Event::Level { v: (v * 100.0).round() / 100.0 }
    }

    pub fn error(code: ErrorCode) -> Self {
        Event::Error { code, spoke: None, message: None, what: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Command {
    Cancel,
    Listen {
        #[serde(default)]
        request_id: Option<String>,
    },
    Chord { mods: Vec<String> },
    Mute { on: bool },
    /// The id for the next talk-chord session.
    Request { request_id: String },
    Telemetry { on: bool },
}

/// Unknown or malformed lines are ignored, like the Mac helper does.
pub fn parse_command(line: &str) -> Option<Command> {
    serde_json::from_str(line.trim()).ok()
}

/// Writes one JSON object per line and flushes each line so the host sees it at once.
pub struct Emitter<W: Write> {
    out: W,
}

impl<W: Write> Emitter<W> {
    pub fn new(out: W) -> Self {
        Emitter { out }
    }

    pub fn emit(&mut self, event: &Event) -> io::Result<()> {
        let line = serde_json::to_string(event).map_err(io::Error::other)?;
        self.out.write_all(line.as_bytes())?;
        self.out.write_all(b"\n")?;
        self.out.flush()
    }

    #[cfg(test)]
    pub fn get_ref(&self) -> &W {
        &self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn js(e: &Event) -> Value {
        serde_json::to_value(e).unwrap()
    }

    #[test]
    fn events_match_the_swift_shapes() {
        assert_eq!(
            js(&Event::Ready { engine: "zipformer".into(), model: None, dry_run: false }),
            json!({"type":"ready","engine":"zipformer"})
        );
        assert_eq!(
            js(&Event::Ready { engine: "zipformer".into(), model: None, dry_run: true }),
            json!({"type":"ready","engine":"zipformer","dryRun":true})
        );
        assert_eq!(
            js(&Event::Ready { engine: "moonshine".into(), model: Some("small-streaming-en".into()), dry_run: false }),
            json!({"type":"ready","engine":"moonshine","model":"small-streaming-en"})
        );
        assert_eq!(
            js(&Event::State { state: SessionState::Listening, mode: Some(Mode::Handsfree), cancelled: None }),
            json!({"type":"state","state":"listening","mode":"handsfree"})
        );
        assert_eq!(
            js(&Event::State { state: SessionState::Listening, mode: Some(Mode::Hold), cancelled: None }),
            json!({"type":"state","state":"listening","mode":"hold"})
        );
        assert_eq!(js(&Event::state(SessionState::Processing)), json!({"type":"state","state":"processing"}));
        assert_eq!(js(&Event::state(SessionState::Idle)), json!({"type":"state","state":"idle"}));
        assert_eq!(
            js(&Event::State { state: SessionState::Idle, mode: None, cancelled: Some(true) }),
            json!({"type":"state","state":"idle","cancelled":true})
        );
        assert_eq!(js(&Event::Partial { text: "hi".into() }), json!({"type":"partial","text":"hi"}));
        assert_eq!(js(&Event::Final { text: "hi there".into() }), json!({"type":"final","text":"hi there"}));
        assert_eq!(js(&Event::level(0.5)), json!({"type":"level","v":0.5}));
        assert_eq!(js(&Event::error(ErrorCode::NoInput)), json!({"type":"error","code":"no_input"}));
        assert_eq!(js(&Event::error(ErrorCode::Unavailable)), json!({"type":"error","code":"unavailable"}));
        assert_eq!(
            js(&Event::Error { code: ErrorCode::NothingHeard, spoke: Some(false), message: None, what: None }),
            json!({"type":"error","code":"nothing_heard","spoke":false})
        );
        assert_eq!(
            js(&Event::Error { code: ErrorCode::Permission, spoke: None, message: None, what: Some("microphone") }),
            json!({"type":"error","code":"permission","what":"microphone"})
        );
        assert_eq!(
            js(&Event::Perms { mic: MicStatus::Denied, input: false }),
            json!({"type":"perms","mic":"denied","input":false})
        );
        assert_eq!(
            js(&Event::Perms { mic: MicStatus::Granted, input: true }),
            json!({"type":"perms","mic":"granted","input":true})
        );
        assert_eq!(
            js(&Event::Telemetry { event: json!({"schema":1}) }),
            json!({"type":"telemetry","event":{"schema":1}})
        );
    }

    #[test]
    fn level_rounds_to_two_decimals() {
        assert_eq!(Event::level(0.12345), Event::Level { v: 0.12 });
        assert_eq!(Event::level(0.666), Event::Level { v: 0.67 });
        assert_eq!(Event::level(1.0), Event::Level { v: 1.0 });
        assert_eq!(Event::level(0.0), Event::Level { v: 0.0 });
    }

    #[test]
    fn parses_host_commands() {
        assert_eq!(parse_command(r#"{"cmd":"cancel"}"#), Some(Command::Cancel));
        assert_eq!(parse_command(r#"{"cmd":"listen"}"#), Some(Command::Listen { request_id: None }));
        assert_eq!(
            parse_command(r#"{"cmd":"listen","request_id":"0123456789abcdef0123456789abcdef"}"#),
            Some(Command::Listen { request_id: Some("0123456789abcdef0123456789abcdef".into()) })
        );
        assert_eq!(
            parse_command(r#"{"cmd":"request","request_id":"ab"}"#),
            Some(Command::Request { request_id: "ab".into() })
        );
        assert_eq!(parse_command(r#"{"cmd":"telemetry","on":false}"#), Some(Command::Telemetry { on: false }));
        assert_eq!(
            parse_command(r#"{"cmd":"chord","mods":["ctrl","alt"]}"#),
            Some(Command::Chord { mods: vec!["ctrl".into(), "alt".into()] })
        );
        assert_eq!(parse_command(r#"{"cmd":"mute","on":false}"#), Some(Command::Mute { on: false }));
        assert_eq!(parse_command("  {\"cmd\":\"listen\",\"extra\":1}\r"), Some(Command::Listen { request_id: None }));
    }

    #[test]
    fn ignores_bad_lines() {
        for line in ["", "nope", "{}", r#"{"cmd":"dance"}"#, r#"{"cmd":"mute"}"#, r#"{"cmd":"chord","mods":"ctrl"}"#, r#"{"cmd":"request"}"#, r#"{"cmd":"telemetry"}"#, "[1,2]"] {
            assert_eq!(parse_command(line), None, "{line}");
        }
    }

    #[test]
    fn emitter_writes_one_flushed_line_per_event() {
        let mut em = Emitter::new(Vec::new());
        em.emit(&Event::state(SessionState::Idle)).unwrap();
        em.emit(&Event::Partial { text: "a\nb".into() }).unwrap();
        let text = String::from_utf8(em.get_ref().clone()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(serde_json::from_str::<Value>(lines[1]).unwrap(), json!({"type":"partial","text":"a\nb"}));
    }
}
