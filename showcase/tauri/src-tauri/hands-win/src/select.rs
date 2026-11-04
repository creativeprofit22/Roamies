// `select <out.png>`: the user picks part of the screen, like macOS's built-in selection. A dimmed, topmost
// overlay covers every monitor (physical pixels): drag for an area, click for the window under the pointer,
// Esc or right-click to cancel. The overlay is gone before the pixels are read, and the area is refused
// when a hands-off app shows in it.
use crate::budget::Budget;
use crate::geom::Rect;
use crate::protocol::{self as p, fail, Monitor};
use crate::{capture, dpi, hands_off, windows};
use serde_json::Value;
use std::cell::RefCell;
use std::time::{Duration, Instant};
use w32::core::w;
use w32::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use w32::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
use w32::Win32::Graphics::Gdi::{BeginPaint, EndPaint, FillRect, GetStockObject, InvalidateRect, BLACK_BRUSH, HBRUSH, PAINTSTRUCT, WHITE_BRUSH};
use w32::Win32::System::LibraryLoader::GetModuleHandleW;
use w32::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, ReleaseCapture, SetCapture, VK_ESCAPE};
use w32::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, LoadCursorW, PeekMessageW, RegisterClassW,
    SetLayeredWindowAttributes, ShowWindow, TranslateMessage, UnregisterClassW, IDC_CROSS, LWA_ALPHA, MSG, PM_REMOVE, SW_SHOW, WM_ERASEBKGND,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONDOWN, WNDCLASSW, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

/// Smaller drags than this count as a click.
const CLICK_PX: i32 = 4;
/// About 35% black over the screen.
const DIM: u8 = 90;
/// Time for the compositor to take the overlay off screen before reading pixels.
const HIDE_MS: u64 = 80;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Pick {
    Area(Rect),
    Point(i32, i32),
    Cancel,
}

#[derive(Default)]
struct State {
    origin: (i32, i32),
    start: Option<(i32, i32)>,
    now: (i32, i32),
    pick: Option<Pick>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

pub fn run(out: &str, fit: Option<(u32, u32)>, fake: &str, budget: &Budget) -> Result<Value, Value> {
    let mons = dpi::monitors();
    let desk = desktop(&mons).ok_or_else(|| fail("capture_failed", "No monitor found."))?;
    let deadline = Instant::now() + budget.remaining().saturating_sub(Duration::from_millis(1500));
    let area = match overlay(desk, deadline)? {
        Pick::Cancel => return Ok(p::select_cancelled()),
        Pick::Area(r) => r,
        Pick::Point(x, y) => under(x, y, &mons).unwrap_or(desk),
    };
    let Some(area) = area.clamp_to(&desk) else { return Ok(p::select_cancelled()) };
    if let Some(v) = blocked(area, fake) {
        return Err(v);
    }
    let img = capture::screen_region(area).ok_or_else(|| fail("capture_failed", "Screen capture failed (the PC may be locked)."))?;
    let sent = capture::sent_size(area, fit);
    let img = capture::scale_to(img, sent).map_err(|e| fail("capture_failed", &e))?;
    capture::write_png(out, &img).map_err(|e| fail("capture_failed", &e))?;
    Ok(p::select_reply(out, sent))
}

/// All monitors together (the virtual desktop).
fn desktop(mons: &[Monitor]) -> Option<Rect> {
    let l = mons.iter().map(|m| m.bounds.x).min()?;
    let t = mons.iter().map(|m| m.bounds.y).min()?;
    let r = mons.iter().map(|m| m.bounds.right()).max()?;
    let b = mons.iter().map(|m| m.bounds.bottom()).max()?;
    Rect::from_ltrb(l, t, r as i32, b as i32)
}

/// The area between two drag corners, or None when it's too thin to be a drag (then it's a click).
fn drag_rect(a: (i32, i32), b: (i32, i32)) -> Option<Rect> {
    if (a.0 - b.0).abs() < CLICK_PX || (a.1 - b.1).abs() < CLICK_PX {
        return None;
    }
    Rect::from_ltrb(a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1))
}

/// The front-most window at a point, else the monitor there.
fn under(x: i32, y: i32, mons: &[Monitor]) -> Option<Rect> {
    windows::all()
        .into_iter()
        .filter(|w| !w.minimized)
        .find(|w| w.bounds.contains(x, y))
        .map(|w| w.bounds)
        .or_else(|| mons.iter().find(|m| m.bounds.contains(x, y)).map(|m| m.bounds))
}

/// A hands-off app showing in the area.
fn blocked(area: Rect, fake: &str) -> Option<Value> {
    windows::all()
        .iter()
        .filter(|w| !w.minimized && w.bounds.intersects(&area))
        .find_map(|w| hands_off::check(&[&w.exe, fake], &w.class))
        .map(hands_off::refusal)
}

fn cursor() -> (i32, i32) {
    let mut pt = POINT::default();
    let _ = unsafe { GetCursorPos(&mut pt) };
    (pt.x, pt.y)
}

fn escape_down() -> bool {
    (unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } as u16) & 0x8000 != 0
}

/// Shows the overlay until the user picks, cancels or `deadline` passes; it's destroyed before this returns.
fn overlay(desk: Rect, deadline: Instant) -> Result<Pick, Value> {
    let err = |e: w32::core::Error| fail("unavailable", &format!("Couldn't show the selection overlay: {e}"));
    STATE.with(|s| *s.borrow_mut() = State { origin: (desk.x, desk.y), ..Default::default() });
    let class = w!("RoamiesSelect");
    let inst: HINSTANCE = unsafe { GetModuleHandleW(None) }.map_err(err)?.into();
    let cross = unsafe { LoadCursorW(None, IDC_CROSS) }.map_err(err)?;
    let wc = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: inst, lpszClassName: class, hCursor: cross, ..Default::default() };
    if unsafe { RegisterClassW(&wc) } == 0 {
        return Err(err(w32::core::Error::from_thread()));
    }
    let made = unsafe {
        CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED, class, w!("Roamies"), WS_POPUP, desk.x, desk.y, desk.w, desk.h, None, None, Some(inst), None)
    };
    let hwnd = match made {
        Ok(h) => h,
        Err(e) => {
            let _ = unsafe { UnregisterClassW(class, Some(inst)) };
            return Err(err(e));
        }
    };
    unsafe {
        let off: i32 = 1;
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, &off as *const i32 as *const _, 4);
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), DIM, LWA_ALPHA);
        let _ = ShowWindow(hwnd, SW_SHOW);
    }
    crate::focus::bring_to_front(hwnd, Instant::now() + Duration::from_millis(500));
    // An Esc still held from before the overlay opened must not cancel it.
    let held = escape_down();
    let pick = loop {
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        // Polled too, so Esc works even when Windows refused to give the overlay the keyboard.
        if escape_down() && !held {
            break Pick::Cancel;
        }
        if let Some(p) = STATE.with(|s| s.borrow().pick) {
            break p;
        }
        if Instant::now() >= deadline {
            break Pick::Cancel;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    unsafe {
        let _ = ReleaseCapture();
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(class, Some(inst));
    }
    std::thread::sleep(Duration::from_millis(HIDE_MS));
    Ok(pick)
}

fn choose(p: Pick) -> LRESULT {
    STATE.with(|s| s.borrow_mut().pick = Some(p));
    LRESULT(0)
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_LBUTTONDOWN => {
            let at = cursor();
            STATE.with(|s| {
                let mut s = s.borrow_mut();
                s.start = Some(at);
                s.now = at;
            });
            SetCapture(hwnd);
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let dragging = STATE.with(|s| {
                let mut s = s.borrow_mut();
                s.now = cursor();
                s.start.is_some()
            });
            if dragging {
                let _ = InvalidateRect(Some(hwnd), None, false);
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => match STATE.with(|s| s.borrow().start) {
            Some(start) => {
                let at = cursor();
                choose(drag_rect(start, at).map(Pick::Area).unwrap_or(Pick::Point(at.0, at.1)))
            }
            None => LRESULT(0),
        },
        WM_RBUTTONDOWN => choose(Pick::Cancel),
        WM_KEYDOWN if wp.0 == VK_ESCAPE.0 as usize => choose(Pick::Cancel),
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut ps);
            let (origin, sel) = STATE.with(|s| {
                let s = s.borrow();
                (s.origin, s.start.and_then(|a| drag_rect(a, s.now)))
            });
            FillRect(dc, &ps.rcPaint, HBRUSH(GetStockObject(BLACK_BRUSH).0));
            if let Some(r) = sel {
                let rc = RECT { left: r.x - origin.0, top: r.y - origin.1, right: r.x + r.w - origin.0, bottom: r.y + r.h - origin.1 };
                FillRect(dc, &rc, HBRUSH(GetStockObject(WHITE_BRUSH).0));
            }
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: i32, y: i32, w: i32, h: i32) -> Monitor {
        Monitor { bounds: Rect::new(x, y, w, h), scale: 1.0, primary: x == 0 && y == 0 }
    }

    #[test]
    fn desktop_spans_every_monitor() {
        assert_eq!(desktop(&[mon(0, 0, 1920, 1080), mon(-1280, -200, 1280, 1024)]), Some(Rect::new(-1280, -200, 3200, 1280)));
        assert_eq!(desktop(&[]), None);
    }

    #[test]
    fn small_or_thin_drags_are_clicks() {
        assert_eq!(drag_rect((10, 10), (12, 13)), None);
        assert_eq!(drag_rect((10, 10), (11, 60)), None);
        assert_eq!(drag_rect((50, 40), (10, 10)), Some(Rect::new(10, 10, 40, 30)));
    }
}
