// The speech engine registry (voice-engines.json, shared with the sidecar and build.rs). Everything
// engine-specific lives there; the rest of the host only talks to "the voice helper".

use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

const REGISTRY: &str = include_str!("../../voice-engines.json");

#[derive(Debug, Clone)]
pub(crate) struct Engine {
    pub id: String,
    pub helper: String,
    pub streaming: bool,
    args: Vec<String>,
}

struct Registry {
    default: String,
    engines: Vec<Engine>,
}

fn parse(text: &str) -> Result<Registry, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let str_of = |e: &Value, k: &str| e.get(k).and_then(Value::as_str).map(str::to_owned).ok_or(format!("engine without {k}"));
    let mut engines = Vec::new();
    for e in v.get("engines").and_then(Value::as_array).ok_or("no engines")? {
        engines.push(Engine {
            id: str_of(e, "id")?,
            helper: str_of(e, "helper")?,
            streaming: e.get("streaming").and_then(Value::as_bool).ok_or("engine without streaming")?,
            args: e.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect()).unwrap_or_default(),
        });
    }
    let default = v.get("default").and_then(Value::as_str).ok_or("no default")?.to_owned();
    Ok(Registry { default, engines })
}

fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| parse(REGISTRY).expect("voice-engines.json is checked by tests"))
}

pub(crate) fn all() -> &'static [Engine] {
    &registry().engines
}

pub(crate) fn get(id: &str) -> Option<&'static Engine> {
    all().iter().find(|e| e.id == id)
}

pub(crate) fn default_id() -> &'static str {
    &registry().default
}

/// The helper's command line for this engine: registry flags (`{bin}/` = the helper's folder) plus the model.
pub(crate) fn args(engine: &Engine, bin_dir: &Path, model_dir: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = engine
        .args
        .iter()
        .map(|a| match a.strip_prefix("{bin}/") {
            Some(rest) => bin_dir.join(rest).to_string_lossy().into_owned(),
            None => a.clone(),
        })
        .collect();
    if let Some(m) = model_dir.filter(|m| !m.is_empty()) {
        out.extend(["--model-dir".into(), m.to_owned()]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn raw() -> Value {
        serde_json::from_str(REGISTRY).unwrap()
    }

    #[test]
    fn parses() {
        assert!(parse(REGISTRY).is_ok());
        assert!(all().len() >= 2);
    }

    #[test]
    fn ids_and_helpers_unique() {
        let ids: HashSet<_> = all().iter().map(|e| &e.id).collect();
        let helpers: HashSet<_> = all().iter().map(|e| &e.helper).collect();
        assert_eq!(ids.len(), all().len());
        assert_eq!(helpers.len(), all().len());
    }

    #[test]
    fn model_files_pinned() {
        for e in raw()["engines"].as_array().unwrap() {
            let files = e["model"]["files"].as_array().unwrap();
            assert!(!files.is_empty(), "{} has no model files", e["id"]);
            for f in files {
                let sha = f["sha256"].as_str().unwrap();
                assert!(sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "bad sha256 {sha}");
                assert!(f["size"].as_u64().unwrap() > 0);
                assert!(!f["name"].as_str().unwrap().is_empty());
            }
            assert!(e["model"]["dir"].as_str().is_some_and(|d| !d.is_empty()));
            assert!(e["model"]["rev"].as_str().is_some_and(|d| !d.is_empty()));
        }
    }

    #[test]
    fn default_is_listed() {
        assert!(get(default_id()).is_some());
        assert_eq!(default_id(), "moonshine");
    }

    #[test]
    fn capabilities() {
        assert!(get("moonshine").unwrap().streaming);
        assert!(!get("parakeet").unwrap().streaming);
    }

    #[test]
    fn unknown_id() {
        assert!(get("whisper").is_none());
    }

    #[test]
    fn args_substitute_bin_and_add_model() {
        let dir = Path::new("app");
        let m = args(get("moonshine").unwrap(), dir, Some("models/m"));
        let lib = dir.join("moonshine.dll").to_string_lossy().into_owned();
        assert!(m.windows(2).any(|w| w[0] == "--moonshine-lib" && w[1] == lib), "{m:?}");
        assert_eq!(&m[m.len() - 2..], ["--model-dir", "models/m"]);
        assert_eq!(args(get("parakeet").unwrap(), dir, Some("p")), ["--model-dir", "p"]);
        assert!(args(get("parakeet").unwrap(), dir, Some("")).is_empty());
        assert!(args(get("parakeet").unwrap(), dir, None).is_empty());
    }

    #[test]
    fn rejects_bad_registry() {
        assert!(parse("{}").is_err());
        assert!(parse(r#"{"default":"a","engines":[{"id":"a"}]}"#).is_err());
    }
}
