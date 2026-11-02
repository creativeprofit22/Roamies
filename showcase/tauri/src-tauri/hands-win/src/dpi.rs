// Per-Monitor V2 DPI awareness, so every rect is in physical pixels and nothing needs rescaling. A V1 context
// passes a naive "is it aware?" check, so the thread's context is compared to V2 exactly (idea from Pinvou).
use crate::geom::Rect;
use crate::protocol::{fail, Monitor};
use serde_json::Value;
use w32::core::BOOL;
use w32::Win32::Foundation::{LPARAM, RECT};
use w32::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
use w32::Win32::UI::HiDpi::{
    AreDpiAwarenessContextsEqual, GetDpiForMonitor, GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext, SetThreadDpiAwarenessContext,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI,
};

pub fn set_process() {
    // Fails harmlessly when a manifest already set it; the worker thread checks the real result.
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

fn thread_is_v2() -> bool {
    unsafe { AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).as_bool() }
}

pub fn verify_thread() -> Result<(), Value> {
    if thread_is_v2() {
        return Ok(());
    }
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if thread_is_v2() {
        Ok(())
    } else {
        Err(fail("dpi", "Couldn't switch to per-monitor DPI awareness (V2), so positions would be wrong. Windows 10 1703 or newer is needed."))
    }
}

unsafe extern "system" fn on_monitor(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<Monitor>);
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if GetMonitorInfoW(h, &mut mi).as_bool() {
        let r = mi.rcMonitor;
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        if let Some(bounds) = Rect::from_ltrb(r.left, r.top, r.right, r.bottom) {
            out.push(Monitor { bounds, scale: dx as f64 / 96.0, primary: mi.dwFlags & 1 != 0 });
        }
    }
    true.into()
}

/// Every monitor, in physical pixels on the virtual desktop; the primary one has its origin at 0,0.
pub fn monitors() -> Vec<Monitor> {
    let mut out: Vec<Monitor> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(on_monitor), LPARAM(&mut out as *mut _ as isize));
    }
    out
}
