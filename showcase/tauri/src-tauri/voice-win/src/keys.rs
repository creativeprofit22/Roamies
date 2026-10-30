//! Windows key state for the talk chord (GetAsyncKeyState polling: no hook, no admin rights) and
//! the microphone privacy switches. Same rules as voice-rs, so both helpers react to keys alike.
#![cfg_attr(not(windows), allow(dead_code))]

use roamies_voice_core::chord::Mods;
#[cfg(windows)]
use roamies_voice_core::chord::KeySource;
use roamies_voice_core::protocol::MicStatus;

const VK_LWIN: u16 = 0x5B;
const VK_RWIN: u16 = 0x5C;
const VK_LSHIFT: u16 = 0xA0;
const VK_RSHIFT: u16 = 0xA1;
const VK_LCONTROL: u16 = 0xA2;
const VK_RCONTROL: u16 = 0xA3;
const VK_LMENU: u16 = 0xA4;
const VK_RMENU: u16 = 0xA5;
const VK_PACKET: u16 = 0xE7;

pub fn mods_from(is_down: impl Fn(u16) -> bool) -> Mods {
    let ralt = is_down(VK_RMENU);
    let mut m = Mods::NONE;
    // AltGr reports a fake LCtrl with RAlt, so typing @ on a German layout must not look like Ctrl+Alt.
    if is_down(VK_RCONTROL) || (is_down(VK_LCONTROL) && !ralt) {
        m = m.union(Mods::CONTROL);
    }
    if ralt || is_down(VK_LMENU) {
        m = m.union(Mods::ALT);
    }
    if is_down(VK_LWIN) || is_down(VK_RWIN) {
        m = m.union(Mods::WIN);
    }
    if is_down(VK_LSHIFT) || is_down(VK_RSHIFT) {
        m = m.union(Mods::SHIFT);
    }
    m
}

fn is_other_key(vk: u16) -> bool {
    !matches!(vk, 0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5 | VK_PACKET)
}

/// Any non-modifier key down (mouse buttons 0x01-0x06 are below the scanned range).
pub fn other_key_from(is_down: impl Fn(u16) -> bool) -> bool {
    (0x08u16..=0xFE).any(|vk| is_other_key(vk) && is_down(vk))
}

const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Hive {
    LocalMachine,
    CurrentUser,
}

/// Denied if any switch is off: the device-wide one, "Microphone access" or "Let desktop apps access
/// your microphone". Missing keys mean the default, which is allowed.
pub fn mic_status_from(read: impl Fn(Hive, &str) -> Option<String>) -> MicStatus {
    let nonpackaged = format!(r"{STORE}\NonPackaged");
    let checks = [(Hive::LocalMachine, STORE), (Hive::CurrentUser, STORE), (Hive::CurrentUser, nonpackaged.as_str())];
    if checks.iter().any(|(hive, path)| read(*hive, path).is_some_and(|v| v.trim().eq_ignore_ascii_case("deny"))) {
        MicStatus::Denied
    } else {
        MicStatus::Granted
    }
}

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use super::*;

    pub struct WinKeys;

    fn down(vk: u16) -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        // SAFETY: reads global key state; no pointers involved.
        (unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000) != 0
    }

    impl KeySource for WinKeys {
        fn mods(&mut self) -> Mods {
            mods_from(down)
        }
        fn other_key_down(&mut self) -> bool {
            other_key_from(down)
        }
    }

    pub fn mic_status() -> MicStatus {
        mic_status_from(read_value)
    }

    /// Reads the REG_SZ `Value` under `path`.
    fn read_value(hive: Hive, path: &str) -> Option<String> {
        use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
        let root = match hive {
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
            Hive::CurrentUser => HKEY_CURRENT_USER,
        };
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (sub, name) = (wide(path), wide("Value"));
        let mut buf = [0u16; 64];
        let mut size = std::mem::size_of_val(&buf) as u32;
        // SAFETY: NUL-terminated strings and a buffer whose byte size is passed in `size`.
        let rc = unsafe { RegGetValueW(root, sub.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) };
        if rc != 0 {
            return None;
        }
        let chars = (size as usize / 2).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..chars]).trim_end_matches('\0').to_string())
    }
}

/// Elsewhere there's no privacy switch to read.
#[cfg(not(windows))]
pub fn mic_status() -> MicStatus {
    MicStatus::Granted
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn held(keys: &'static [u16]) -> impl Fn(u16) -> bool {
        move |vk| keys.contains(&vk)
    }

    #[test]
    fn reads_either_side_of_each_modifier() {
        let ca = Mods::CONTROL.union(Mods::ALT);
        assert_eq!(mods_from(held(&[VK_LCONTROL, VK_LMENU])), ca);
        assert_eq!(mods_from(held(&[VK_RCONTROL, VK_RMENU])), ca, "RCtrl+RAlt still works");
        assert_eq!(mods_from(held(&[VK_RWIN, VK_LSHIFT])), Mods::WIN.union(Mods::SHIFT));
        assert_eq!(mods_from(held(&[])), Mods::NONE);
    }

    #[test]
    fn altgr_is_not_ctrl_alt() {
        assert_eq!(mods_from(held(&[VK_LCONTROL, VK_RMENU])), Mods::ALT);
    }

    #[test]
    fn other_keys_skip_mouse_and_modifiers() {
        assert!(!other_key_from(held(&[0x01, 0x02, 0x04, 0x05, 0x06])), "mouse buttons");
        assert!(!other_key_from(held(&[0x10, 0x11, 0x12, VK_LWIN, VK_RWIN, VK_LSHIFT, VK_RMENU, VK_PACKET])));
        assert!(other_key_from(held(&[0x53])), "S");
        assert!(other_key_from(held(&[0x0D])), "Enter");
    }

    fn with(values: &[(Hive, &str, &str)]) -> MicStatus {
        let map: HashMap<(Hive, String), String> = values.iter().map(|(h, p, v)| ((*h, p.to_string()), v.to_string())).collect();
        mic_status_from(|h, p| map.get(&(h, p.to_string())).cloned())
    }

    #[test]
    fn mic_is_denied_by_any_switch() {
        let np = format!(r"{STORE}\NonPackaged");
        assert_eq!(with(&[]), MicStatus::Granted);
        assert_eq!(with(&[(Hive::CurrentUser, STORE, "Allow"), (Hive::CurrentUser, &np, "Allow")]), MicStatus::Granted);
        assert_eq!(with(&[(Hive::LocalMachine, STORE, "Deny")]), MicStatus::Denied);
        assert_eq!(with(&[(Hive::CurrentUser, &np, "deny")]), MicStatus::Denied);
        assert_eq!(with(&[(Hive::CurrentUser, STORE, "Prompt")]), MicStatus::Granted);
    }
}
