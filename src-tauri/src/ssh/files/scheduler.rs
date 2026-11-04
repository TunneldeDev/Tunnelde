use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

const ACTIVE_TASKS: usize = 4;
// Each remote endpoint can open a metadata and a data subsystem. Keep room for
// terminals, file browsers and other operations on the same SSH connection.
const CHANNELS_PER_CONNECTION: usize = 4;

#[derive(Clone, Default)]
pub(super) struct Scheduler(Arc<Inner>);

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    next: u64,
    waiting: VecDeque<Request>,
    active: BTreeMap<u64, BTreeMap<String, usize>>,
}

struct Request {
    id: u64,
    channels: BTreeMap<String, usize>,
}

struct Ticket {
    inner: Arc<Inner>,
    id: u64,
}

pub(super) struct Permit {
    _ticket: Ticket,
}

impl State {
    fn fits(&self, request: &Request) -> bool {
        self.active.len() < ACTIVE_TASKS
            && request.channels.iter().all(|(connection, required)| {
                let used: usize = self
                    .active
                    .values()
                    .map(|channels| channels.get(connection).copied().unwrap_or(0))
                    .sum();
                used + required <= CHANNELS_PER_CONNECTION
            })
    }

    fn ready(&self, index: usize) -> bool {
        let request = &self.waiting[index];
        self.fits(request)
            && self.waiting.iter().take(index).all(|earlier| {
                // Unrelated hosts can bypass a blocked request. An older ready
                // request or one sharing an endpoint keeps its place in line.
                !self.fits(earlier)
                    && !earlier
                        .channels
                        .keys()
                        .any(|connection| request.channels.contains_key(connection))
            })
    }
}

impl Scheduler {
    pub async fn acquire(&self, source: Option<&str>, target: Option<&str>) -> Permit {
        let ticket = {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            let id = state.next;
            state.next += 1;
            let mut channels = BTreeMap::new();
            for connection in [source, target].into_iter().flatten() {
                *channels.entry(connection.to_owned()).or_default() += 2;
            }
            state.waiting.push_back(Request { id, channels });
            Ticket {
                inner: self.0.clone(),
                id,
            }
        };
        loop {
            let notified = self.0.changed.notified();
            tokio::pin!(notified);
            // Register before checking capacity so a release cannot be missed.
            notified.as_mut().enable();
            let acquired = {
                let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
                let index = state
                    .waiting
                    .iter()
                    .position(|r| r.id == ticket.id)
                    .unwrap();
                if state.ready(index) {
                    let request = state.waiting.remove(index).unwrap();
                    state.active.insert(request.id, request.channels);
                    true
                } else {
                    false
                }
            };
            if acquired {
                self.0.changed.notify_waiters();
                return Permit { _ticket: ticket };
            }
            notified.await;
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.waiting.retain(|request| request.id != self.id);
        state.active.remove(&self.id);
        drop(state);
        self.inner.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn uploads_queue_after_two_and_release_advances_the_next_task() {
        let queue = Scheduler::default();
        let first = queue.acquire(None, Some("host")).await;
        let second = queue.acquire(None, Some("host")).await;
        let third = queue.acquire(None, Some("host"));
        tokio::pin!(third);
        assert!(futures_util::poll!(&mut third).is_pending());
        drop(first);
        let third = tokio::time::timeout(Duration::from_millis(250), third)
            .await
            .unwrap();
        assert_eq!(queue.0.state.lock().unwrap().active.len(), 2);
        drop((second, third));
        assert!(queue.0.state.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn same_connection_remote_copy_accounts_for_both_endpoints() {
        let queue = Scheduler::default();
        let copy = queue.acquire(Some("host"), Some("host")).await;
        let upload = queue.acquire(None, Some("host"));
        tokio::pin!(upload);
        assert!(futures_util::poll!(&mut upload).is_pending());
        drop(copy);
        let upload = upload.await;
        drop(upload);
    }

    #[tokio::test]
    async fn independent_hosts_can_progress_without_overtaking_shared_endpoints() {
        let queue = Scheduler::default();
        let one = queue.acquire(None, Some("a")).await;
        let two = queue.acquire(None, Some("a")).await;
        let blocked = queue.acquire(Some("a"), Some("b"));
        tokio::pin!(blocked);
        assert!(futures_util::poll!(&mut blocked).is_pending());
        let independent = queue.acquire(None, Some("c")).await;
        let later = queue.acquire(None, Some("b"));
        tokio::pin!(later);
        assert!(futures_util::poll!(&mut later).is_pending());
        drop(one);
        assert!(futures_util::poll!(&mut later).is_pending());
        let blocked = blocked.await;
        let later = later.await;
        drop((two, independent, blocked, later));
    }

    #[tokio::test]
    async fn cancelled_waiters_remove_reservations_and_wake_the_next_request() {
        let queue = Scheduler::default();
        let copy = queue.acquire(Some("a"), Some("a")).await;
        let mut cancelled = Box::pin(queue.acquire(Some("a"), Some("b")));
        assert!(futures_util::poll!(&mut cancelled).is_pending());
        let mut next = Box::pin(queue.acquire(None, Some("b")));
        assert!(futures_util::poll!(&mut next).is_pending());
        drop(cancelled);
        let next = tokio::time::timeout(Duration::from_millis(250), next)
            .await
            .unwrap();
        drop((copy, next));
        let state = queue.0.state.lock().unwrap();
        assert!(state.waiting.is_empty() && state.active.is_empty());
    }

    #[tokio::test]
    async fn opposite_direction_copies_reserve_endpoints_atomically() {
        let queue = Scheduler::default();
        let one = queue.acquire(Some("a"), Some("b")).await;
        let two = queue.acquire(Some("b"), Some("a")).await;
        let mut three = Box::pin(queue.acquire(Some("a"), Some("b")));
        assert!(futures_util::poll!(&mut three).is_pending());
        drop(one);
        let three = tokio::time::timeout(Duration::from_millis(250), three)
            .await
            .unwrap();
        drop((two, three));
    }

    #[tokio::test]
    async fn total_parallel_tasks_are_bounded_even_for_local_copies() {
        let queue = Scheduler::default();
        let mut active = Vec::new();
        for _ in 0..ACTIVE_TASKS {
            active.push(queue.acquire(None, None).await);
        }
        let mut waiting = Box::pin(queue.acquire(None, None));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        drop(active.pop());
        let waiting = waiting.await;
        drop((active, waiting));
    }
}
