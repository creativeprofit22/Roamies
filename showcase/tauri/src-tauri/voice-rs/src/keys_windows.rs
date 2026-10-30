//! Windows key state for the talk chord: polls GetAsyncKeyState, so no keyboard hook,
//! no message loop and no admin rights.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::chord::Mods;
#[cfg(windows)]
use crate::chord::KeySource;

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

#[cfg(windows)]
pub struct WinKeys;

#[cfg(windows)]
fn down(vk: u16) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    // SAFETY: reads global key state; no pointers involved.
    (unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000) != 0
}

#[cfg(windows)]
impl KeySource for WinKeys {
    fn mods(&mut self) -> Mods {
        mods_from(down)
    }
    fn other_key_down(&mut self) -> bool {
        other_key_from(down)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(other_key_from(held(&[0x41, VK_LCONTROL])), "A");
        assert!(other_key_from(held(&[0x0D])), "Enter");
    }
}
