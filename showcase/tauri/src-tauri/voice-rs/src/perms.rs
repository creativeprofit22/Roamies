//! Windows microphone privacy state (Settings > Privacy & security > Microphone), read from the
//! CapabilityAccessManager consent store. Desktop apps get no prompt: it's either allowed or not.

use serde::Serialize;

const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Hive {
    LocalMachine,
    CurrentUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Granted,
    Denied,
}

/// Denied if any switch is off: the device-wide one, "Microphone access" or "Let desktop apps access
/// your microphone". Missing keys mean the default, which is allowed.
pub fn mic_status(read: impl Fn(Hive, &str) -> Option<String>) -> Status {
    let nonpackaged = format!(r"{STORE}\NonPackaged");
    let checks = [(Hive::LocalMachine, STORE), (Hive::CurrentUser, STORE), (Hive::CurrentUser, nonpackaged.as_str())];
    let denied = checks.iter().any(|(hive, path)| read(*hive, path).is_some_and(|v| v.trim().eq_ignore_ascii_case("deny")));
    if denied {
        Status::Denied
    } else {
        Status::Granted
    }
}

#[cfg(windows)]
pub fn mic() -> Status {
    mic_status(read_value)
}

#[cfg(not(windows))]
pub fn mic() -> Status {
    Status::Granted
}

/// Reads the REG_SZ `Value` under `path`.
#[cfg(windows)]
fn read_value(hive: Hive, path: &str) -> Option<String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let key = match hive {
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        Hive::CurrentUser => HKEY_CURRENT_USER,
    };
    let sub = HSTRING::from(path);
    let mut buf = [0u16; 64];
    let mut len = std::mem::size_of_val(&buf) as u32;
    let rc = unsafe { RegGetValueW(key, &sub, w!("Value"), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut len)) };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let chars = (len as usize / 2).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..chars]).trim_end_matches('\0').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(values: &[(Hive, &str, &str)]) -> Status {
        let map: HashMap<(Hive, String), String> =
            values.iter().map(|(h, p, v)| ((*h, p.to_string()), v.to_string())).collect();
        mic_status(|h, p| map.get(&(h, p.to_string())).cloned())
    }

    fn np() -> String {
        format!(r"{STORE}\NonPackaged")
    }

    #[test]
    fn missing_keys_mean_granted() {
        assert_eq!(with(&[]), Status::Granted);
    }

    #[test]
    fn all_allow_is_granted() {
        let np = np();
        assert_eq!(
            with(&[(Hive::LocalMachine, STORE, "Allow"), (Hive::CurrentUser, STORE, "Allow"), (Hive::CurrentUser, &np, "Allow")]),
            Status::Granted
        );
    }

    #[test]
    fn deny_at_any_level_is_denied() {
        let np = np();
        assert_eq!(with(&[(Hive::LocalMachine, STORE, "Deny")]), Status::Denied);
        assert_eq!(with(&[(Hive::CurrentUser, STORE, "Deny"), (Hive::LocalMachine, STORE, "Allow")]), Status::Denied);
        assert_eq!(with(&[(Hive::CurrentUser, &np, "deny")]), Status::Denied);
    }

    #[test]
    fn unknown_values_are_not_denied() {
        assert_eq!(with(&[(Hive::CurrentUser, STORE, "Prompt")]), Status::Granted);
    }
}
