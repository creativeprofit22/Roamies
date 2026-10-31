// App lifecycle telemetry (docs/telemetry.md, "Lifecycle"): process start, events held while the sidecar is
// down, helper crash/restart counting and process memory.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Value};

use crate::telemetry::{self, Outcome, Telemetry};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Call first thing in `main`.
pub fn mark_process_start() {
    PROCESS_START.get_or_init(Instant::now);
}

pub fn process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

const BACKLOG_MAX: usize = 500;

/// Host events sent while the sidecar can't take them (not started yet, or dead), oldest dropped first.
pub struct Backlog {
    q: VecDeque<Value>,
    dropped: u64,
}

impl Backlog {
    pub const fn new() -> Self {
        Backlog { q: VecDeque::new(), dropped: 0 }
    }

    pub fn push(&mut self, e: Value) {
        if self.q.len() >= BACKLOG_MAX {
            self.q.pop_front();
            self.dropped += 1;
        }
        self.q.push_back(e);
    }

    /// Everything held, oldest first, and how many were dropped since the last drain.
    pub fn drain(&mut self) -> (Vec<Value>, u64) {
        (self.q.drain(..).collect(), std::mem::take(&mut self.dropped))
    }
}

pub static BACKLOG: Mutex<Backlog> = Mutex::new(Backlog::new());

pub fn hold(e: Value) {
    BACKLOG.lock().unwrap_or_else(|e| e.into_inner()).push(e);
}

/// The held events as one `telemetry` message, if any.
pub fn take_backlog() -> (Option<Value>, u64) {
    let (events, dropped) = BACKLOG.lock().unwrap_or_else(|e| e.into_inner()).drain();
    ((!events.is_empty()).then(|| json!({ "type": "telemetry", "events": events })), dropped)
}

/// How many times the voice helper died on its own since it last said `ready` (or was wanted again).
pub struct Restarts(AtomicUsize);

impl Restarts {
    pub const MAX: usize = 3;

    pub const fn new() -> Self {
        Restarts(AtomicUsize::new(0))
    }

    pub fn reset(&self) {
        self.0.store(0, Ordering::Relaxed);
    }

    pub fn count(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }

    /// The helper started at `started` exited with `code`. `ours`: it was still the wanted helper, so it crashed.
    /// Records `host.helper_exit` and returns whether to start it again.
    pub fn on_exit(&self, tel: &Telemetry, ours: bool, code: Option<i32>, started: Instant) -> bool {
        if !ours {
            return false;
        }
        let crashes = self.0.fetch_add(1, Ordering::Relaxed) + 1;
        let restart = crashes <= Self::MAX;
        let step = tel.start_at("host.helper_exit", None, None, started, Default::default());
        let a = telemetry::attrs(json!({ "code": code, "crashes": crashes, "restart": restart }));
        tel.end(step, Outcome::Error, Some("helper_crashed"), a);
        restart
    }
}

/// Resident memory of a process in bytes.
#[cfg(windows)]
pub fn rss_bytes(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut c: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = K32GetProcessMemoryInfo(h, &mut c, c.cb);
        CloseHandle(h);
        (ok != 0).then_some(c.WorkingSetSize as u64)
    }
}

#[cfg(target_os = "macos")]
pub fn rss_bytes(pid: u32) -> Option<u64> {
    // <sys/proc_info.h> struct proc_taskinfo
    #[repr(C)]
    #[derive(Default)]
    struct TaskInfo {
        virtual_size: u64,
        resident_size: u64,
        total_user: u64,
        total_system: u64,
        threads_user: u64,
        threads_system: u64,
        rest: [i32; 12],
    }
    extern "C" {
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut std::ffi::c_void, size: i32) -> i32;
    }
    const PROC_PIDTASKINFO: i32 = 4;
    let mut info = TaskInfo::default();
    let size = std::mem::size_of::<TaskInfo>() as i32;
    let n = unsafe { proc_pidinfo(pid as i32, PROC_PIDTASKINFO, 0, (&mut info as *mut TaskInfo).cast(), size) };
    (n == size).then_some(info.resident_size)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn rss_bytes(pid: u32) -> Option<u64> {
    let statm = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages * 4096)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn capture() -> (Telemetry, Arc<Mutex<Vec<Value>>>) {
        let tel = Telemetry::new();
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        tel.set_sink(move |e| g.lock().unwrap().push(e));
        (tel, got)
    }

    #[test]
    fn three_crashes_restart_the_fourth_does_not() {
        let (tel, got) = capture();
        let r = Restarts::new();
        let t = Instant::now();
        let restarts: Vec<bool> = (0..4).map(|i| r.on_exit(&tel, true, Some(100 + i), t)).collect();
        assert_eq!(restarts, [true, true, true, false]);
        let ends: Vec<Value> = got.lock().unwrap().iter().filter(|e| e["kind"] == "end").cloned().collect();
        assert_eq!(ends.len(), 4);
        for (i, e) in ends.iter().enumerate() {
            assert_eq!(e["step"], "host.helper_exit");
            assert_eq!(e["outcome"], "error");
            assert_eq!(e["error_code"], "helper_crashed");
            assert_eq!(e["attrs"]["code"], 100 + i as i64);
            assert_eq!(e["attrs"]["crashes"], i as u64 + 1);
            assert_eq!(e["attrs"]["restart"], i < 3);
        }
    }

    #[test]
    fn ready_resets_and_stopped_helpers_dont_count() {
        let (tel, got) = capture();
        let r = Restarts::new();
        for _ in 0..3 {
            assert!(r.on_exit(&tel, true, None, Instant::now()));
        }
        r.reset();
        assert!(r.on_exit(&tel, true, Some(1), Instant::now()));
        assert_eq!(r.count(), 1);
        let n = got.lock().unwrap().len();
        assert!(!r.on_exit(&tel, false, Some(0), Instant::now()));
        assert_eq!(got.lock().unwrap().len(), n, "a helper we stopped is not a crash");
        assert_eq!(r.count(), 1);
    }

    #[test]
    fn backlog_drops_oldest_and_drains_in_order() {
        let mut b = Backlog::new();
        for i in 0..(BACKLOG_MAX + 5) {
            b.push(json!(i));
        }
        let (events, dropped) = b.drain();
        assert_eq!(dropped, 5);
        assert_eq!(events.len(), BACKLOG_MAX);
        assert_eq!(events[0], json!(5));
        assert_eq!(events.last(), Some(&json!(BACKLOG_MAX + 4)));
        assert_eq!(b.drain(), (vec![], 0));
    }

    #[test]
    fn own_rss_is_readable() {
        assert!(rss_bytes(std::process::id()).is_some_and(|b| b > 0));
    }
}
