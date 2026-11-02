// Time and node budgets. Every verb runs on a worker thread; if a provider hangs inside a COM call, the
// main thread still answers with whatever the worker last published (flagged partial), then exits.
use serde_json::{json, Value};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    Time,
    Nodes,
}

impl Stop {
    pub fn reason(self) -> &'static str {
        match self {
            Stop::Time => "time",
            Stop::Nodes => "nodes",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Budget {
    deadline: Instant,
    nodes: usize,
    cap: usize,
}

impl Budget {
    pub fn new(ms: u64, cap: usize) -> Self {
        Budget { deadline: Instant::now() + Duration::from_millis(ms), nodes: 0, cap }
    }

    /// Same deadline, a fresh node count (one per window in find-text).
    pub fn with_nodes(&self, cap: usize) -> Self {
        Budget { deadline: self.deadline, nodes: 0, cap }
    }

    pub fn tick(&mut self) -> Result<(), Stop> {
        if Instant::now() >= self.deadline {
            return Err(Stop::Time);
        }
        if self.nodes >= self.cap {
            return Err(Stop::Nodes);
        }
        self.nodes += 1;
        Ok(())
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }
}

/// What the worker has found so far; the main thread prints it if the worker runs out of time.
pub type Snapshot = Arc<Mutex<Option<Value>>>;

pub fn publish(snap: &Snapshot, v: Value) {
    if let Ok(mut s) = snap.lock() {
        *s = Some(v);
    }
}

/// Grace past the budget before the main thread stops waiting for a stuck worker.
pub const GRACE_MS: u64 = 500;

/// Runs `work` on its own thread with `ms` to finish (plus a short grace). On a timeout it returns the last
/// published snapshot flagged partial, or a timeout error when nothing was published (capture never
/// publishes, so it never returns half an image).
pub fn run<F>(ms: u64, work: F) -> Value
where
    F: FnOnce(Snapshot) -> Value + Send + 'static,
{
    let snap: Snapshot = Arc::new(Mutex::new(None));
    let (tx, rx) = mpsc::channel();
    let s = snap.clone();
    std::thread::spawn(move || {
        let _ = tx.send(work(s));
    });
    match rx.recv_timeout(Duration::from_millis(ms + GRACE_MS)) {
        Ok(v) => v,
        Err(_) => {
            let last = snap.lock().ok().and_then(|mut s| s.take());
            match last {
                Some(mut v) => {
                    v["partial"] = json!(true);
                    v["partialReason"] = json!("time");
                    v
                }
                None => crate::protocol::fail("timeout", "The app didn't answer in time. Try again, or use a screenshot instead."),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_cap_stops_the_walk() {
        let mut b = Budget::new(10_000, 3);
        assert!(b.tick().is_ok() && b.tick().is_ok() && b.tick().is_ok());
        assert_eq!(b.tick(), Err(Stop::Nodes));
        let mut fresh = b.with_nodes(1);
        assert!(fresh.tick().is_ok());
        assert_eq!(fresh.tick(), Err(Stop::Nodes));
    }

    #[test]
    fn deadline_stops_the_walk() {
        let mut b = Budget::new(0, 100);
        assert_eq!(b.tick(), Err(Stop::Time));
        assert!(b.expired());
    }

    #[test]
    fn stuck_worker_returns_the_partial_snapshot() {
        let start = Instant::now();
        let v = run(50, |snap| {
            publish(&snap, json!({"ok": true, "matches": [1]}));
            std::thread::sleep(Duration::from_secs(5));
            json!({"ok": true, "matches": []})
        });
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(v["partial"], json!(true));
        assert_eq!(v["partialReason"], json!("time"));
        assert_eq!(v["matches"], json!([1]));
    }

    #[test]
    fn stuck_worker_without_snapshot_is_a_timeout_error() {
        let v = run(10, |_| {
            std::thread::sleep(Duration::from_secs(5));
            json!({"ok": true})
        });
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["code"], json!("timeout"));
    }

    #[test]
    fn finished_worker_wins() {
        assert_eq!(run(1000, |_| json!({"ok": true})), json!({"ok": true}));
    }
}
