use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

const ACTIVE_TASKS: usize = 4;
// Metadata + data per remote endpoint, plus either an optional archive channel
// or the target's overwrite commit channel. A same-connection archive copy
// needs six; an overwrite copy needs five.
// Reserve all endpoints together, while leaving interactive work outside this
// bounded transfer budget.
const CHANNELS_PER_CONNECTION: usize = 6;

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
    #[cfg(test)]
    pub async fn acquire(
        &self,
        source: Option<&str>,
        target: Option<&str>,
        atomic_target: bool,
    ) -> Permit {
        self.reserve(source, target, atomic_target, false).await
    }

    pub async fn reserve(
        &self,
        source: Option<&str>,
        target: Option<&str>,
        atomic_target: bool,
        archive: bool,
    ) -> Permit {
        let ticket = {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            let id = state.next;
            state.next += 1;
            let mut channels = BTreeMap::new();
            for (connection, slots) in [
                (source, 2 + usize::from(archive)),
                (target, 2 + usize::from(atomic_target || archive)),
            ] {
                if let Some(connection) = connection {
                    *channels.entry(connection.to_owned()).or_default() += slots;
                }
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
    async fn archive_channels_are_reserved_for_both_endpoints() {
        let queue = Scheduler::default();
        let first = queue.reserve(None, Some("host"), false, true).await;
        let second = queue.reserve(Some("host"), None, false, true).await;
        let mut third = Box::pin(queue.reserve(None, Some("host"), false, true));
        assert!(futures_util::poll!(&mut third).is_pending());
        assert_eq!(
            queue
                .0
                .state
                .lock()
                .unwrap()
                .active
                .values()
                .map(|channels| channels["host"])
                .sum::<usize>(),
            CHANNELS_PER_CONNECTION
        );
        drop(first);
        let third = tokio::time::timeout(Duration::from_millis(250), third)
            .await
            .unwrap();
        drop((second, third));
        let same_host = queue.reserve(Some("host"), Some("host"), false, true).await;
        assert_eq!(
            queue
                .0
                .state
                .lock()
                .unwrap()
                .active
                .values()
                .map(|channels| channels["host"])
                .sum::<usize>(),
            CHANNELS_PER_CONNECTION
        );
        drop(same_host);
    }

    #[tokio::test]
    async fn uploads_queue_after_two_and_release_advances_the_next_task() {
        let queue = Scheduler::default();
        let first = queue.acquire(None, Some("host"), true).await;
        let second = queue.acquire(None, Some("host"), true).await;
        let third = queue.acquire(None, Some("host"), true);
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
    async fn ordinary_transfers_use_two_slots_and_overwrite_reserves_its_commit_channel() {
        let queue = Scheduler::default();
        let first = queue.acquire(None, Some("host"), false).await;
        let second = queue.acquire(None, Some("host"), false).await;
        let mut overwrite = Box::pin(queue.acquire(None, Some("host"), true));
        assert!(futures_util::poll!(&mut overwrite).is_pending());
        assert_eq!(
            queue
                .0
                .state
                .lock()
                .unwrap()
                .active
                .values()
                .map(|c| c["host"])
                .sum::<usize>(),
            4
        );
        // A newer two-slot upload fits, but cannot jump the older overwrite.
        let mut later = Box::pin(queue.acquire(None, Some("host"), false));
        assert!(futures_util::poll!(&mut later).is_pending());
        drop(first);
        let overwrite = tokio::time::timeout(Duration::from_millis(250), overwrite)
            .await
            .unwrap();
        assert!(futures_util::poll!(&mut later).is_pending());
        assert_eq!(
            queue
                .0
                .state
                .lock()
                .unwrap()
                .active
                .values()
                .map(|c| c["host"])
                .sum::<usize>(),
            5
        );
        drop(second);
        let later = tokio::time::timeout(Duration::from_millis(250), later)
            .await
            .unwrap();
        drop((overwrite, later));
        assert!(queue.0.state.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn three_ordinary_uploads_fit_but_a_fourth_queues() {
        let queue = Scheduler::default();
        let mut permits = Vec::new();
        for _ in 0..3 {
            permits.push(queue.acquire(None, Some("host"), false).await);
        }
        let mut waiting = Box::pin(queue.acquire(None, Some("host"), false));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        drop(permits.pop());
        let next = tokio::time::timeout(Duration::from_millis(250), waiting)
            .await
            .unwrap();
        drop((permits, next));
    }

    #[tokio::test]
    async fn all_endpoint_combinations_fit_once_and_never_exceed_the_connection_budget() {
        for source in [None, Some("a"), Some("b")] {
            for target in [None, Some("a"), Some("b")] {
                for atomic in [false, true] {
                    let queue = Scheduler::default();
                    let permit = tokio::time::timeout(
                        Duration::from_millis(250),
                        queue.acquire(source, target, atomic),
                    )
                    .await
                    .expect("a task cannot reserve an impossible channel count");
                    {
                        let state = queue.0.state.lock().unwrap();
                        let channels = state.active.values().next().unwrap();
                        for host in ["a", "b"] {
                            let expected = usize::from(source == Some(host)) * 2
                                + usize::from(target == Some(host)) * (2 + usize::from(atomic));
                            assert_eq!(channels.get(host).copied().unwrap_or(0), expected);
                            assert!(expected <= CHANNELS_PER_CONNECTION);
                        }
                    }
                    drop(permit);
                }
            }
        }
    }

    #[tokio::test]
    async fn same_connection_remote_copy_accounts_for_both_endpoints() {
        let queue = Scheduler::default();
        let copy = queue.acquire(Some("host"), Some("host"), true).await;
        let upload = queue.acquire(None, Some("host"), true);
        tokio::pin!(upload);
        assert!(futures_util::poll!(&mut upload).is_pending());
        drop(copy);
        let upload = upload.await;
        drop(upload);
    }

    #[tokio::test]
    async fn independent_hosts_can_progress_without_overtaking_shared_endpoints() {
        let queue = Scheduler::default();
        let one = queue.acquire(None, Some("a"), true).await;
        let two = queue.acquire(None, Some("a"), true).await;
        let blocked = queue.acquire(Some("a"), Some("b"), true);
        tokio::pin!(blocked);
        assert!(futures_util::poll!(&mut blocked).is_pending());
        let independent = queue.acquire(None, Some("c"), true).await;
        let later = queue.acquire(None, Some("b"), true);
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
        let copy = queue.acquire(Some("a"), Some("a"), true).await;
        let mut cancelled = Box::pin(queue.acquire(Some("a"), Some("b"), true));
        assert!(futures_util::poll!(&mut cancelled).is_pending());
        let mut next = Box::pin(queue.acquire(None, Some("b"), true));
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
        let one = queue.acquire(Some("a"), Some("b"), true).await;
        let two = queue.acquire(Some("b"), Some("a"), true).await;
        let mut three = Box::pin(queue.acquire(Some("a"), Some("b"), true));
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
            active.push(queue.acquire(None, None, true).await);
        }
        let mut waiting = Box::pin(queue.acquire(None, None, true));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        drop(active.pop());
        let waiting = waiting.await;
        drop((active, waiting));
    }
}
