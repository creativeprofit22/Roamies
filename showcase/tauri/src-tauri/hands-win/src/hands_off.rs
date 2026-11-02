// Apps Roamies may point at but never capture, read or type into on Windows: password managers, Windows
// Security and credential prompts. The list is shared with the sidecar's DICTATION_BLOCK (a test checks it).
use serde_json::Value;
use std::sync::OnceLock;

const LIST: &str = include_str!("../hands-off.json");

fn table() -> &'static Value {
    static T: OnceLock<Value> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(LIST).expect("hands-off.json is valid JSON"))
}

/// The display name when this window is hands-off, by exe (any case, with or without a path) or class.
pub fn lookup(exe: &str, class: &str) -> Option<&'static str> {
    let file = exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_lowercase();
    table()["exes"][file.as_str()].as_str().or_else(|| table()["classes"][class].as_str())
}

/// Any of the given exes (the real one, plus a --fake-exe in tests) or the class being hands-off.
pub fn check(exes: &[&str], class: &str) -> Option<&'static str> {
    exes.iter().find_map(|e| lookup(e, "")).or_else(|| lookup("", class))
}

pub fn refusal(name: &str) -> Value {
    crate::protocol::fail(
        "hands_off",
        &format!("Blocked for safety: I can point at {name}, but I never read, capture or type in it. Show the user where to look instead."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_by_exe_in_any_case_and_path() {
        assert_eq!(lookup("KeePassXC.exe", ""), Some("KeePassXC"));
        assert_eq!(lookup(r"C:\Program Files\Bitwarden\Bitwarden.exe", ""), Some("Bitwarden"));
        assert_eq!(lookup("SecHealthUI.exe", ""), Some("Windows Security"));
        assert_eq!(lookup("consent.exe", ""), Some("the admin prompt"));
        assert_eq!(lookup("notepad.exe", "Notepad"), None);
    }

    #[test]
    fn finds_by_class() {
        assert_eq!(lookup("explorer.exe", "Credential Dialog Xaml Host"), Some("a Windows sign-in prompt"));
    }

    #[test]
    fn a_fake_exe_can_only_add_a_refusal() {
        assert_eq!(check(&["notepad.exe", "keepass.exe"], ""), Some("KeePass"));
        assert_eq!(check(&["keepass.exe", "notepad.exe"], ""), Some("KeePass"));
        assert_eq!(check(&["notepad.exe"], ""), None);
        let r = refusal("KeePass");
        assert_eq!(r["code"], "hands_off");
        assert_eq!(r["ok"], false);
    }
}
