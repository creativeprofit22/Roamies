// Key combos for the act verb's `key` step: "ctrl+shift+tab", "return", "cmd+l". Names follow KEYS and
// pressKey in hands/main.swift (so "delete" is Backspace, as on a Mac keyboard), plus f1-f12, insert and every
// letter and digit. The model writes Mac combos, so cmd/command mean Ctrl here. Combos that switch windows or
// reach the secure desktop are refused; the superset matching idea is from agent-desktop's blocked_combo.rs.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
    /// Windows virtual-key code.
    pub vk: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyError {
    Unknown,
    Blocked,
}

pub const VK_BACK: u16 = 0x08;
pub const VK_TAB: u16 = 0x09;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_ESCAPE: u16 = 0x1B;
pub const VK_SPACE: u16 = 0x20;
pub const VK_PRIOR: u16 = 0x21;
pub const VK_NEXT: u16 = 0x22;
pub const VK_END: u16 = 0x23;
pub const VK_HOME: u16 = 0x24;
pub const VK_LEFT: u16 = 0x25;
pub const VK_UP: u16 = 0x26;
pub const VK_RIGHT: u16 = 0x27;
pub const VK_DOWN: u16 = 0x28;
pub const VK_INSERT: u16 = 0x2D;
pub const VK_DELETE: u16 = 0x2E;
pub const VK_A: u16 = 0x41;
pub const VK_F1: u16 = 0x70;

/// Keys Windows wants sent with the extended-key flag (the arrow/navigation block).
pub fn extended(vk: u16) -> bool {
    matches!(vk, VK_PRIOR | VK_NEXT | VK_END | VK_HOME | VK_LEFT | VK_UP | VK_RIGHT | VK_DOWN | VK_INSERT | VK_DELETE)
}

fn vk_for(name: &str) -> Option<u16> {
    let vk = match name {
        "return" | "enter" => VK_RETURN,
        "tab" => VK_TAB,
        "space" => VK_SPACE,
        "delete" | "backspace" => VK_BACK,
        "forwarddelete" => VK_DELETE,
        "escape" | "esc" => VK_ESCAPE,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        "insert" => VK_INSERT,
        _ => {
            let mut cs = name.chars();
            match (cs.next(), cs.next()) {
                (Some(c @ 'a'..='z'), None) => c as u16 - 'a' as u16 + VK_A,
                (Some(c @ '0'..='9'), None) => c as u16,
                _ => {
                    let n: u16 = name.strip_prefix('f')?.parse().ok()?;
                    if !(1..=12).contains(&n) {
                        return None;
                    }
                    VK_F1 + n - 1
                }
            }
        }
    };
    Some(vk)
}

/// Combos that switch windows, open the Start menu or Task Manager, or reach the secure desktop. A combo is
/// blocked when it holds at least these modifiers with this key (Ctrl+Alt+Shift+Tab is still Alt+Tab).
const BLOCKED: [(bool, bool, bool, u16); 7] = [
    // (ctrl, alt, shift, key)
    (false, true, false, VK_TAB),
    (false, true, false, VK_ESCAPE),
    (true, false, false, VK_ESCAPE),
    (true, true, false, VK_DELETE),
    (true, true, false, VK_BACK),
    (true, true, false, VK_END),
    (true, true, true, VK_ESCAPE),
];

pub fn blocked(c: &Combo) -> bool {
    // Every Win-key combo (Win+L locks, Win+Tab, Win+D, Win+R…) leaves the app.
    c.win || BLOCKED.iter().any(|&(ctrl, alt, shift, vk)| c.vk == vk && (c.ctrl || !ctrl) && (c.alt || !alt) && (c.shift || !shift))
}

pub fn parse(combo: &str) -> Result<Combo, KeyError> {
    let mut c = Combo::default();
    let mut key = None;
    for part in combo.trim().to_lowercase().split('+').map(str::trim) {
        match part {
            "cmd" | "command" | "ctrl" | "control" => c.ctrl = true,
            "opt" | "option" | "alt" => c.alt = true,
            "shift" => c.shift = true,
            "win" | "windows" | "super" | "meta" => c.win = true,
            _ => {
                if key.is_some() {
                    return Err(KeyError::Unknown);
                }
                key = Some(vk_for(part).ok_or(KeyError::Unknown)?);
            }
        }
    }
    c.vk = key.ok_or(KeyError::Unknown)?;
    if blocked(&c) {
        return Err(KeyError::Blocked);
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_names_and_modifiers() {
        assert_eq!(parse("return"), Ok(Combo { vk: VK_RETURN, ..Default::default() }));
        assert_eq!(parse("cmd+l"), Ok(Combo { ctrl: true, vk: 0x4C, ..Default::default() }));
        assert_eq!(parse("Ctrl+Shift+Tab"), Ok(Combo { ctrl: true, shift: true, vk: VK_TAB, ..Default::default() }));
        assert_eq!(parse("opt+left").map(|c| (c.alt, c.vk)), Ok((true, VK_LEFT)));
        assert_eq!(parse("f5").map(|c| c.vk), Ok(0x74));
        assert_eq!(parse("f12").map(|c| c.vk), Ok(0x7B));
        assert_eq!(parse("7").map(|c| c.vk), Ok(0x37));
        assert_eq!(parse("delete").map(|c| c.vk), Ok(VK_BACK));
        assert_eq!(parse("forwarddelete").map(|c| c.vk), Ok(VK_DELETE));
        assert_eq!(parse("pagedown").map(|c| c.vk), Ok(VK_NEXT));
        assert!(extended(VK_LEFT) && extended(VK_DELETE) && !extended(VK_RETURN));
    }

    #[test]
    fn unknown_keys_are_errors() {
        for bad in ["", "ctrl", "f13", "f0", "hyper+a", "ctrl+a+b", "ab", "é"] {
            assert_eq!(parse(bad), Err(KeyError::Unknown), "{bad:?}");
        }
    }

    #[test]
    fn window_switching_and_secure_desktop_combos_are_blocked() {
        for bad in ["alt+tab", "alt+shift+tab", "ctrl+alt+tab", "alt+esc", "ctrl+esc", "ctrl+shift+esc", "ctrl+alt+forwarddelete", "ctrl+alt+delete",
            "ctrl+alt+shift+delete", "ctrl+alt+end", "win+l", "win+tab", "win+d", "super+r", "meta+e", "win+shift+s", "opt+tab", "cmd+opt+esc"] {
            assert_eq!(parse(bad), Err(KeyError::Blocked), "{bad:?}");
        }
        for fine in ["ctrl+tab", "shift+tab", "ctrl+shift+tab", "alt+f4", "ctrl+w", "escape", "ctrl+end", "alt+end", "ctrl+delete"] {
            assert!(parse(fine).is_ok(), "{fine:?}");
        }
    }
}
