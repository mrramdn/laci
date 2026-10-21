//! How far a scan has come. The first scan of a big history takes minutes; the window shows this
//! meanwhile, so nobody takes it for stuck.
use std::sync::{
    Arc,
    atomic::{AtomicU8, AtomicU64, Ordering},
};

use serde_json::{Value, json};

/// Shared by every clone of an [`crate::env::Env`], so the app reads what a scan on another thread is doing.
#[derive(Debug, Clone, Default)]
pub struct Progress(Arc<Counters>);

#[derive(Debug, Default)]
struct Counters {
    step: AtomicU8,
    done: AtomicU64,
    total: AtomicU64,
    bytes: AtomicU64,
    total_bytes: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Reading agent logs that changed since the last scan: `total` logs of `total_bytes` bytes.
    History = 1,
    /// Walking the chosen folders for projects.
    Folders = 2,
    /// Reading each project and folder found: Git, README, to-dos.
    Projects = 3,
}

impl Progress {
    pub fn start(&self, step: Step, total: u64, total_bytes: u64) {
        let c = &self.0;
        c.done.store(0, Ordering::Relaxed);
        c.bytes.store(0, Ordering::Relaxed);
        c.total.store(total, Ordering::Relaxed);
        c.total_bytes.store(total_bytes, Ordering::Relaxed);
        c.step.store(step as u8, Ordering::Release);
    }
    /// One more of `total` is done, `bytes` of it read.
    pub fn advance(&self, bytes: u64) {
        self.0.bytes.fetch_add(bytes, Ordering::Relaxed);
        self.0.done.fetch_add(1, Ordering::Relaxed);
    }
    pub fn finish(&self) {
        self.0.step.store(0, Ordering::Release);
    }
    /// Ends the scan's progress when it returns, however it returns.
    pub fn until_done(&self) -> Done {
        Done(self.clone())
    }
    /// `{step, done, total, bytes, totalBytes}`, or null when no scan is running.
    pub fn to_json(&self) -> Value {
        let c = &self.0;
        let step = match c.step.load(Ordering::Acquire) {
            1 => "history",
            2 => "folders",
            3 => "projects",
            _ => return Value::Null,
        };
        let total = c.total.load(Ordering::Relaxed);
        let total_bytes = c.total_bytes.load(Ordering::Relaxed);
        json!({
            "step": step,
            "done": c.done.load(Ordering::Relaxed).min(total),
            "total": total,
            "bytes": c.bytes.load(Ordering::Relaxed).min(total_bytes),
            "totalBytes": total_bytes,
        })
    }
}

/// Ends a scan's progress when dropped. See [`Progress::until_done`].
#[must_use]
pub struct Done(Progress);
impl Drop for Done {
    fn drop(&mut self) {
        self.0.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scan_says_how_far_it_has_come_until_it_returns() {
        let progress = Progress::default();
        assert!(progress.to_json().is_null(), "no scan runs");
        let seen_by_the_app = progress.clone();
        {
            progress.start(Step::History, 3, 300);
            let _done = progress.until_done();
            progress.advance(100);
            progress.advance(150);
            assert_eq!(
                seen_by_the_app.to_json(),
                json!({"step":"history","done":2,"total":3,"bytes":250,"totalBytes":300})
            );
            progress.start(Step::Projects, 2, 0);
            assert_eq!(
                seen_by_the_app.to_json(),
                json!({"step":"projects","done":0,"total":2,"bytes":0,"totalBytes":0})
            );
            // More than was counted never shows as more than all of it.
            for _ in 0..3 {
                progress.advance(0);
            }
            assert_eq!(seen_by_the_app.to_json()["done"], 2);
        }
        assert!(seen_by_the_app.to_json().is_null(), "the step ends however the scan returns");
    }
}
