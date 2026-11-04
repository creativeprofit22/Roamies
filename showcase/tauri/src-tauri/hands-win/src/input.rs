// Real mouse and keyboard input, for the steps UI Automation can't do. SendInput only; the mouse is placed
// with SetCursorPos, which takes physical pixels because the helper is per-monitor DPI aware. Adapted from
// injaneity/pi-computer-use native/windows/bridge-rs/src/input.rs (MIT, Copyright (c) 2026 Zane Chee; see
// licenses/pi-computer-use-LICENSE.txt): Unicode typing per UTF-16 unit and checking SendInput's count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputError {
    /// The user still holds Ctrl/Alt/Shift/Win (the talk chord): typed letters would become shortcuts.
    KeysHeld,
    /// Windows took fewer events than sent, or the mouse didn't land where asked.
    Failed(String),
}

impl InputError {
    pub fn code(&self) -> &'static str {
        match self {
            InputError::KeysHeld => "keys_held",
            InputError::Failed(_) => "input",
        }
    }

    pub fn message(&self) -> String {
        match self {
            InputError::KeysHeld => "The user is still holding Ctrl, Alt, Shift or the Windows key, so typing now would trigger shortcuts. Nothing was typed; try again once the keys are released.".into(),
            InputError::Failed(m) => format!("Windows didn't take the input ({m}). It may have been blocked by another app or the lock screen."),
        }
    }
}

/// One thing to type: a character (one UTF-16 unit, or both halves of a surrogate pair) or Return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Char(Vec<u16>),
    Return,
}

/// `\r\n`, `\r` and `\n` each become one Return; everything else is typed as Unicode.
pub fn pieces(text: &str) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push(Piece::Return);
            }
            '\n' => out.push(Piece::Return),
            c => {
                let mut buf = [0u16; 2];
                out.push(Piece::Char(c.encode_utf16(&mut buf).to_vec()));
            }
        }
    }
    out
}

/// Characters sent per SendInput call; apps drop keys when a long burst arrives at once.
pub const CHUNK: usize = 16;

#[cfg(windows)]
mod sys {
    use super::{pieces, InputError, Piece, CHUNK};
    use crate::keys::{extended, Combo};
    use std::time::{Duration, Instant};
    use w32::Win32::Foundation::POINT;
    use w32::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_WHEEL,
        MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RETURN, VK_RWIN, VK_SHIFT,
    };
    use w32::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

    fn send(inputs: &[INPUT]) -> Result<(), InputError> {
        if inputs.is_empty() {
            return Ok(());
        }
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            Err(InputError::Failed(format!("{sent} of {} events sent", inputs.len())))
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, mouseData: data as u32, ..Default::default() } },
        }
    }

    fn vk(code: u16, up: bool) -> INPUT {
        let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
        if extended(code) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(code), dwFlags: flags, ..Default::default() } } }
    }

    fn unit(u: u16, up: bool) -> INPUT {
        let flags = if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE };
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wScan: u, dwFlags: flags, ..Default::default() } } }
    }

    fn held() -> bool {
        [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN].iter().any(|k| unsafe { GetAsyncKeyState(k.0 as i32) } < 0)
    }

    /// Waits up to `ms` for the user to let go of every modifier.
    pub fn wait_keys_released(ms: u64) -> Result<(), InputError> {
        let end = Instant::now() + Duration::from_millis(ms);
        while held() {
            if Instant::now() >= end {
                return Err(InputError::KeysHeld);
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        Ok(())
    }

    /// Puts the cursor on x,y (physical pixels) and checks it got there.
    pub fn move_to(x: i32, y: i32) -> Result<(), InputError> {
        unsafe { SetCursorPos(x, y) }.map_err(|e| InputError::Failed(format!("moving the mouse: {e}")))?;
        let mut p = POINT::default();
        unsafe { GetCursorPos(&mut p) }.map_err(|e| InputError::Failed(format!("reading the mouse: {e}")))?;
        if (p.x - x).abs() > 1 || (p.y - y).abs() > 1 {
            return Err(InputError::Failed(format!("the mouse went to {},{} instead of {x},{y}", p.x, p.y)));
        }
        Ok(())
    }

    pub fn click(x: i32, y: i32) -> Result<(), InputError> {
        wait_keys_released(1500)?;
        move_to(x, y)?;
        std::thread::sleep(Duration::from_millis(30));
        send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0), mouse(MOUSEEVENTF_LEFTUP, 0)])
    }

    /// Wheel notches at x,y: positive `down` scrolls the content down (wheel towards the user), positive
    /// `right` scrolls right.
    pub fn wheel(x: i32, y: i32, down: i32, right: i32) -> Result<(), InputError> {
        move_to(x, y)?;
        let mut ev = Vec::new();
        if down != 0 {
            ev.push(mouse(MOUSEEVENTF_WHEEL, -down.clamp(-50, 50) * 120));
        }
        if right != 0 {
            ev.push(mouse(MOUSEEVENTF_HWHEEL, right.clamp(-50, 50) * 120));
        }
        send(&ev)
    }

    /// Presses a combo: modifiers down, the key, modifiers up, as one batch so nothing slips in between.
    pub fn key(c: &Combo) -> Result<(), InputError> {
        wait_keys_released(1500)?;
        let mods: Vec<u16> = [(c.ctrl, VK_CONTROL.0), (c.alt, VK_MENU.0), (c.shift, VK_SHIFT.0), (c.win, VK_LWIN.0)]
            .into_iter()
            .filter_map(|(on, k)| on.then_some(k))
            .collect();
        let mut ev: Vec<INPUT> = mods.iter().map(|&m| vk(m, false)).collect();
        ev.push(vk(c.vk, false));
        ev.push(vk(c.vk, true));
        ev.extend(mods.iter().rev().map(|&m| vk(m, true)));
        send(&ev)
    }

    /// Types text into whatever has keyboard focus, as Unicode characters (any language, emoji), with
    /// line breaks as Return.
    pub fn type_text(text: &str) -> Result<(), InputError> {
        wait_keys_released(1500)?;
        let all = pieces(text);
        for chunk in all.chunks(CHUNK) {
            let mut ev = Vec::new();
            for p in chunk {
                match p {
                    Piece::Return => {
                        ev.push(vk(VK_RETURN.0, false));
                        ev.push(vk(VK_RETURN.0, true));
                    }
                    Piece::Char(units) => {
                        ev.extend(units.iter().map(|&u| unit(u, false)));
                        ev.extend(units.iter().map(|&u| unit(u, true)));
                    }
                }
            }
            send(&ev)?;
            std::thread::sleep(Duration::from_millis(12));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use sys::{click, key, type_text, wait_keys_released, wheel};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_becomes_characters_and_returns() {
        assert_eq!(pieces("a\r\nb\nc\r"), vec![
            Piece::Char(vec![b'a' as u16]),
            Piece::Return,
            Piece::Char(vec![b'b' as u16]),
            Piece::Return,
            Piece::Char(vec![b'c' as u16]),
            Piece::Return,
        ]);
        assert!(pieces("").is_empty());
    }

    #[test]
    fn surrogate_pairs_stay_together() {
        let p = pieces("é😀");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0], Piece::Char(vec![0xE9]));
        assert_eq!(p[1], Piece::Char(vec![0xD83D, 0xDE00]), "both halves of the emoji are sent");
    }

    #[test]
    fn errors_have_codes() {
        assert_eq!(InputError::KeysHeld.code(), "keys_held");
        assert_eq!(InputError::Failed("x".into()).code(), "input");
        assert!(InputError::KeysHeld.message().contains("Nothing was typed"));
    }
}
