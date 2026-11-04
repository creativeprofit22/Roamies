// Apps Roamies may point at but never capture, read or type into on Windows: password managers, Windows
// Security and credential prompts. The list is shared with the sidecar's DICTATION_BLOCK (a test checks it).
// `noInput` apps (terminals, system tools) may be read but never typed or clicked in by `act`.
use serde_json::Value;
use std::sync::OnceLock;

const LIST: &str = include_str!("../hands-off.json");
// Shown for every window when the list can't be read: refusing everything is safer than refusing nothing.
const UNREADABLE: &str = "this app (the hands-off list couldn't be read)";

fn table() -> Option<&'static Value> {
    static T: OnceLock<Option<Value>> = OnceLock::new();
    T.get_or_init(|| parse(LIST)).as_ref()
}

fn parse(src: &str) -> Option<Value> {
    serde_json::from_str::<Value>(src).ok().filter(|v| v["exes"].is_object())
}

fn file_of(exe: &str) -> String {
    exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_lowercase()
}

/// The display name when this window is hands-off, by exe (any case, with or without a path) or class.
pub fn lookup(exe: &str, class: &str) -> Option<&'static str> {
    let Some(t) = table() else { return Some(UNREADABLE) };
    t["exes"][file_of(exe).as_str()].as_str().or_else(|| t["classes"][class].as_str())
}

/// Any of the given exes (the real one, plus a --fake-exe in tests) or the class being hands-off.
pub fn check(exes: &[&str], class: &str) -> Option<&'static str> {
    exes.iter().find_map(|e| lookup(e, "")).or_else(|| lookup("", class))
}

/// The display name when the helper may read this app but never type or click in it.
pub fn no_input(exe: &str) -> Option<&'static str> {
    let Some(t) = table() else { return Some(UNREADABLE) };
    t["noInput"][file_of(exe).as_str()].as_str()
}

/// Input-only by window class: a console window shows whatever shell runs in it, so its exe isn't enough.
pub fn no_input_class(class: &str) -> Option<&'static str> {
    let Some(t) = table() else { return Some(UNREADABLE) };
    t["noInputClasses"][class].as_str()
}

/// What `act` refuses: hands-off apps and input-only ones, for any of the given exes or the class.
pub fn act_check(exes: &[&str], class: &str) -> Option<&'static str> {
    check(exes, class).or_else(|| exes.iter().find_map(|e| no_input(e))).or_else(|| no_input_class(class))
}

pub fn refusal(name: &str) -> Value {
    crate::protocol::fail(
        "hands_off",
        &format!("Blocked for safety: I can point at {name}, but I never read, capture or type in it. Show the user where to look instead."),
    )
}

pub fn act_refusal(name: &str) -> Value {
    crate::protocol::fail(
        "hands_off",
        &format!("Blocked for safety: I can point at things in {name}, but I never type or click in it. Show the user where to click instead."),
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

    #[test]
    fn terminals_are_readable_but_never_typed_in() {
        assert_eq!(lookup("cmd.exe", "ConsoleWindowClass"), None, "reading a terminal stays allowed");
        assert_eq!(no_input(r"C:\Windows\System32\cmd.exe"), Some("Command Prompt"));
        assert_eq!(no_input("WindowsTerminal.exe"), Some("Windows Terminal"));
        assert_eq!(no_input("pwsh.exe"), Some("PowerShell"));
        assert_eq!(no_input("regedit.exe"), Some("Registry Editor"));
        assert_eq!(no_input("notepad.exe"), None);
        assert_eq!(act_check(&["notepad.exe", "cmd.exe"], ""), Some("Command Prompt"));
        assert_eq!(act_check(&["notepad.exe", "KeePassXC.exe"], ""), Some("KeePassXC"));
        assert_eq!(act_check(&["notepad.exe"], "Notepad"), None);
        assert_eq!(act_check(&["wsl.exe"], "ConsoleWindowClass"), Some("the console"), "any shell in a console");
        assert_eq!(act_check(&["python.exe"], "CASCADIA_HOSTING_WINDOW_CLASS"), Some("Windows Terminal"));
        assert_eq!(act_check(&["bash.exe"], "mintty"), Some("the Git Bash terminal"));
        assert_eq!(no_input_class("Notepad"), None);
        let r = act_refusal("PowerShell");
        assert_eq!(r["code"], "hands_off");
        assert!(r["error"].as_str().is_some_and(|e| e.contains("never type or click")));
    }

    #[test]
    fn an_unreadable_list_refuses_everything() {
        assert!(parse("{not json").is_none());
        assert!(parse("{}").is_none(), "a list without exes counts as unreadable");
        assert!(parse(LIST).is_some(), "the shipped list parses");
    }
}
