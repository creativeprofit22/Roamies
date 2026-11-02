// Which window a command is about: front | screen | app:<name> | window:<id>.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Front,
    Screen,
    App(String),
    Window(i64),
}

pub fn parse(s: &str) -> Option<Target> {
    match s {
        "front" => Some(Target::Front),
        "screen" => Some(Target::Screen),
        _ => {
            if let Some(name) = s.strip_prefix("app:") {
                let name = name.trim();
                (!name.is_empty()).then(|| Target::App(name.to_string()))
            } else if let Some(id) = s.strip_prefix("window:") {
                id.trim().parse().ok().map(Target::Window)
            } else {
                None
            }
        }
    }
}

/// Known browsers: (display names, exe).
const BROWSERS: [(&[&str], &str); 7] = [
    (&["google chrome", "chrome"], "chrome.exe"),
    (&["microsoft edge", "edge"], "msedge.exe"),
    (&["brave browser", "brave"], "brave.exe"),
    (&["firefox", "mozilla firefox"], "firefox.exe"),
    (&["opera", "opera internet browser"], "opera.exe"),
    (&["vivaldi"], "vivaldi.exe"),
    (&["chromium"], "chromium.exe"),
];

pub fn is_browser(app: &str, exe: &str) -> bool {
    let a = app.to_lowercase();
    let e = exe.to_lowercase();
    BROWSERS.iter().any(|(names, x)| *x == e || names.contains(&a.as_str()))
}

fn stem(exe: &str) -> String {
    let e = exe.to_lowercase();
    e.strip_suffix(".exe").unwrap_or(&e).to_string()
}

/// Fuzzy app match like the macOS helper: "browser" means any known browser; otherwise a case-insensitive
/// match either way round, against the app's name and its exe.
pub fn app_matches(app: &str, exe: &str, want: &str) -> bool {
    let w = want.trim().to_lowercase();
    if w.is_empty() {
        return false;
    }
    if ["browser", "web browser", "my browser"].contains(&w.as_str()) {
        return is_browser(app, exe);
    }
    let close = |a: &str| !a.is_empty() && (a == w || a.contains(&w) || w.contains(a));
    close(&app.to_lowercase()) || close(&stem(exe)) || stem(&w) == stem(exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_targets() {
        assert_eq!(parse("front"), Some(Target::Front));
        assert_eq!(parse("screen"), Some(Target::Screen));
        assert_eq!(parse("app:Notepad"), Some(Target::App("Notepad".into())));
        assert_eq!(parse("window:132456"), Some(Target::Window(132456)));
        assert_eq!(parse("window:abc"), None);
        assert_eq!(parse("app:"), None);
        assert_eq!(parse("Notepad"), None);
    }

    #[test]
    fn matches_apps_by_name_or_exe() {
        assert!(app_matches("Notepad", "Notepad.exe", "notepad"));
        assert!(app_matches("Microsoft Edge", "msedge.exe", "Edge"));
        assert!(app_matches("Microsoft Edge", "msedge.exe", "msedge.exe"));
        assert!(app_matches("Google Chrome", "chrome.exe", "chrome"));
        assert!(!app_matches("Google Chrome", "chrome.exe", "Notepad"));
        assert!(!app_matches("", "", "x"));
    }

    #[test]
    fn browser_means_known_browsers() {
        assert!(app_matches("Google Chrome", "chrome.exe", "browser"));
        assert!(app_matches("Brave Browser", "brave.exe", "web browser"));
        assert!(app_matches("Firefox", "firefox.exe", "my browser"));
        assert!(!app_matches("Notepad", "notepad.exe", "browser"));
    }
}
