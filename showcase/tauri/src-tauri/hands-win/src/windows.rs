// Top-level windows front to back: visible, not cloaked, not tool windows or owned popups, at least 80×60,
// never Roamies itself. Bounds are the DWM extended frame (what's actually drawn), already in physical pixels
// under Per-Monitor V2, so they are never rescaled (cua #1879).
use crate::geom::Rect;
use crate::protocol::WinInfo;
use std::collections::HashMap;
use w32::core::{BOOL, HSTRING, PCWSTR, PWSTR};
use w32::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT};
use w32::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use w32::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use w32::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use w32::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use w32::Win32::UI::HiDpi::GetDpiForWindow;
use w32::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, FindWindowExW, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
};

const WS_EX_TOOLWINDOW: isize = 0x80;
const WS_EX_APPWINDOW: isize = 0x40000;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
const SHELL_CLASSES: [&str; 4] = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];
/// Hosts whose real app lives in a child CoreWindow (UWP: Settings, Windows Security, Calculator).
pub const FRAME_HOST: &str = "ApplicationFrameWindow";

pub fn hwnd(id: i64) -> HWND {
    HWND(id as isize as *mut _)
}

fn text(buf: &[u16], n: i32) -> String {
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    text(&buf, n)
}

fn title_of(h: HWND) -> String {
    let mut buf = vec![0u16; 512];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    text(&buf, n)
}

pub fn pid_of(h: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    pid
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Full exe path. PROCESS_QUERY_LIMITED_INFORMATION works on elevated apps too.
pub fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let h = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn token_elevated(process: HANDLE) -> Option<bool> {
    unsafe {
        let mut tok = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut tok).ok()?;
        let tok = Handle(tok);
        let mut e = TOKEN_ELEVATION::default();
        let mut ret = 0u32;
        GetTokenInformation(tok.0, TokenElevation, Some(&mut e as *mut _ as *mut _), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut ret).ok()?;
        Some(e.TokenIsElevated != 0)
    }
}

/// The app runs as administrator while this helper doesn't, so UI Automation can't read it.
pub fn elevated_above_us(pid: u32) -> bool {
    if token_elevated(unsafe { GetCurrentProcess() }) == Some(true) {
        return false;
    }
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let h = Handle(h);
                token_elevated(h.0) == Some(true)
            }
            Err(_) => false,
        }
    }
}

/// The exe's FileDescription ("Google Chrome", "Notepad"), else its file name without .exe.
fn describe(path: &str) -> String {
    let stem = path.rsplit('\\').next().unwrap_or(path);
    let stem = stem.strip_suffix(".exe").or_else(|| stem.strip_suffix(".EXE")).unwrap_or(stem).to_string();
    unsafe {
        let p = HSTRING::from(path);
        let size = GetFileVersionInfoSizeW(&p, None);
        if size == 0 {
            return stem;
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(&p, None, size, data.as_mut_ptr() as *mut _).is_err() {
            return stem;
        }
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        let mut langs: Vec<(u16, u16)> = Vec::new();
        if VerQueryValueW(data.as_ptr() as *const _, &HSTRING::from("\\VarFileInfo\\Translation"), &mut ptr, &mut len).as_bool() && !ptr.is_null() {
            let pairs = std::slice::from_raw_parts(ptr as *const u16, (len / 2) as usize);
            langs.extend(pairs.chunks_exact(2).map(|c| (c[0], c[1])));
        }
        langs.extend([(0x0409, 0x04b0), (0x0409, 0x04e4)]);
        for (lang, cp) in langs {
            let key = HSTRING::from(format!("\\StringFileInfo\\{lang:04x}{cp:04x}\\FileDescription"));
            if VerQueryValueW(data.as_ptr() as *const _, &key, &mut ptr, &mut len).as_bool() && !ptr.is_null() && len > 1 {
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(ptr as *const u16, len as usize - 1)).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
        stem
    }
}

pub fn frame_bounds(h: HWND) -> Option<Rect> {
    unsafe {
        let mut r = RECT::default();
        if DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).is_err() {
            GetWindowRect(h, &mut r).ok()?;
        }
        Rect::from_ltrb(r.left, r.top, r.right, r.bottom)
    }
}

fn cloaked(h: HWND) -> bool {
    let mut c = 0u32;
    unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut c as *mut _ as *mut _, 4).is_ok() && c != 0 }
}

/// The process that really owns a window: for a UWP frame host, the CoreWindow inside it.
fn owner_pid(h: HWND, class: &str) -> u32 {
    if class == FRAME_HOST {
        if let Ok(core) = unsafe { FindWindowExW(Some(h), None, &HSTRING::from("Windows.UI.Core.CoreWindow"), PCWSTR::null()) } {
            if !core.is_invalid() {
                return pid_of(core);
            }
        }
    }
    pid_of(h)
}

unsafe extern "system" fn collect(h: HWND, data: LPARAM) -> BOOL {
    (*(data.0 as *mut Vec<HWND>)).push(h);
    true.into()
}

/// Every top-level window that could be one the user sees, front to back, minimized ones included
/// (flagged), so a target can still name them.
pub fn all() -> Vec<WinInfo> {
    let mut hs: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut hs as *mut _ as isize));
    }
    let me = unsafe { GetCurrentProcessId() };
    let mut names: HashMap<u32, (String, String)> = HashMap::new();
    let mut out = Vec::new();
    for h in hs {
        unsafe {
            if !IsWindowVisible(h).as_bool() || cloaked(h) {
                continue;
            }
            if GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
                continue;
            }
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            if ex & WS_EX_TOOLWINDOW != 0 || (ex & WS_EX_NOACTIVATE != 0 && ex & WS_EX_APPWINDOW == 0) {
                continue;
            }
        }
        let class = class_of(h);
        if SHELL_CLASSES.contains(&class.as_str()) {
            continue;
        }
        let title = title_of(h);
        if title.trim().is_empty() {
            continue;
        }
        let minimized = unsafe { IsIconic(h).as_bool() };
        let Some(bounds) = frame_bounds(h) else { continue };
        if !minimized && (bounds.w < 80 || bounds.h < 60) {
            continue;
        }
        let pid = owner_pid(h, &class);
        if pid == me || pid == 0 {
            continue;
        }
        let (exe, app) = names
            .entry(pid)
            .or_insert_with(|| match exe_path(pid) {
                Some(p) => (p.rsplit('\\').next().unwrap_or(&p).to_lowercase(), describe(&p)),
                None => (String::new(), title.clone()),
            })
            .clone();
        if exe == "roamies.exe" || exe == "roamies-hands.exe" {
            continue;
        }
        let dpi = unsafe { GetDpiForWindow(h) };
        out.push(WinInfo {
            id: h.0 as isize as i64,
            pid,
            app,
            exe,
            class,
            title,
            bounds,
            scale: if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 },
            minimized,
        });
    }
    out
}

pub fn front_pid() -> Option<u32> {
    let h = unsafe { GetForegroundWindow() };
    (!h.is_invalid()).then(|| owner_pid(h, &class_of(h)))
}

/// Descendant windows with this class (Chromium's page widget lives a level or two down).
pub fn children_with_class(parent: HWND, class: &str) -> Vec<HWND> {
    let mut hs: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(Some(parent), Some(collect), LPARAM(&mut hs as *mut _ as isize));
    }
    hs.into_iter().filter(|h| class_of(*h) == class).collect()
}
