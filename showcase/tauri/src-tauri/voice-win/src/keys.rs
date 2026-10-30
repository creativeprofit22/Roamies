// The talk chord and the Windows microphone privacy switches.
// Modifier bits: control, option (Alt), shift, command (Win), the same names the Mac helper uses.

pub const CONTROL: u8 = 1;
pub const OPTION: u8 = 2;
pub const SHIFT: u8 = 4;
pub const COMMAND: u8 = 8;

pub fn mask(names: &[String]) -> Option<u8> {
    let mut m = 0u8;
    for n in names {
        m |= match n.to_lowercase().as_str() {
            "control" | "ctrl" => CONTROL,
            "option" | "alt" => OPTION,
            "shift" => SHIFT,
            "command" | "cmd" | "win" => COMMAND,
            _ => return None,
        };
    }
    (names.len() == 2 && m.count_ones() == 2).then_some(m)
}

pub struct Held {
    pub mods: u8,
    // Right Alt is AltGr on many layouts (Windows reports it as Ctrl+Alt), used to type characters such
    // as @ or €. It never counts as the chord's Alt, and holding it blocks a talk.
    pub altgr: bool,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    fn down(vk: i32) -> bool {
        // SAFETY: plain Win32 call with a virtual-key code; no pointers involved.
        unsafe { (GetAsyncKeyState(vk) as u16) & 0x8000 != 0 }
    }

    const VK_SHIFT: i32 = 0x10;
    const VK_CONTROL: i32 = 0x11;
    const VK_LMENU: i32 = 0xA4;
    const VK_RMENU: i32 = 0xA5;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;

    pub fn held() -> Held {
        let mut mods = 0;
        if down(VK_CONTROL) {
            mods |= CONTROL;
        }
        if down(VK_LMENU) {
            mods |= OPTION;
        }
        if down(VK_SHIFT) {
            mods |= SHIFT;
        }
        if down(VK_LWIN) || down(VK_RWIN) {
            mods |= COMMAND;
        }
        Held { mods, altgr: down(VK_RMENU) }
    }

    /// Any non-modifier key held (mouse buttons don't count).
    pub fn other_key_down() -> bool {
        (0x08..=0xFE).filter(|vk| !matches!(vk, 0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5)).any(down)
    }

    /// Windows has no prompt for desktop apps: the microphone is either allowed or switched off in
    /// Settings > Privacy & security > Microphone (for the whole PC, for this user, or for desktop apps).
    pub fn mic_allowed() -> bool {
        use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
        const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let denied = |root: HKEY, sub: &str| {
            let (sub, name) = (wide(sub), wide("Value"));
            let mut buf = [0u16; 16];
            let mut size = (buf.len() * 2) as u32;
            // SAFETY: valid NUL-terminated strings and a buffer whose byte size is passed in `size`.
            let rc = unsafe { RegGetValueW(root, sub.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) };
            rc == 0 && String::from_utf16_lossy(&buf[..(size as usize / 2).saturating_sub(1)]).eq_ignore_ascii_case("Deny")
        };
        !(denied(HKEY_LOCAL_MACHINE, KEY) || denied(HKEY_CURRENT_USER, KEY) || denied(HKEY_CURRENT_USER, &format!(r"{KEY}\NonPackaged")))
    }
}

// Elsewhere there's no hotkey (only {"cmd":"listen"} starts a take) and no privacy switch to read.
#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn held() -> Held {
        Held { mods: 0, altgr: false }
    }
    pub fn other_key_down() -> bool {
        false
    }
    pub fn mic_allowed() -> bool {
        true
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chords_need_two_different_known_modifiers() {
        let m = |a: &[&str]| mask(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(m(&["control", "option"]), Some(CONTROL | OPTION));
        assert_eq!(m(&["Ctrl", "shift"]), Some(CONTROL | SHIFT));
        assert_eq!(m(&["command", "option"]), Some(COMMAND | OPTION));
        assert_eq!(m(&["control", "control"]), None);
        assert_eq!(m(&["control"]), None);
        assert_eq!(m(&["control", "option", "shift"]), None);
        assert_eq!(m(&["control", "hyper"]), None);
    }
}
