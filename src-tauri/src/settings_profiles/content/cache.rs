//! Small immutable projection cache, never an authorization or revision authority.
//! Every hit still requires a fresh repository version and current runtime grant.
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

struct Entry {
    revision: String,
    id: String,
    text: Arc<str>,
    inserted: Instant,
}

#[derive(Default)]
pub(super) struct Cache(VecDeque<Entry>);

impl Cache {
    fn prune(&mut self) {
        self.0
            .retain(|entry| entry.inserted.elapsed() < Duration::from_secs(30));
    }

    pub fn get(&mut self, revision: &str, id: &str) -> Option<Arc<str>> {
        self.prune();
        self.0
            .iter()
            .find(|e| e.revision == revision && e.id == id)
            .map(|e| e.text.clone())
    }

    pub fn insert(&mut self, revision: &str, id: &str, text: Arc<str>) {
        self.prune();
        self.0.retain(|e| e.revision != revision || e.id != id);
        while !self.0.is_empty()
            && (self.0.len() >= 4
                || self.0.iter().map(|e| e.text.len()).sum::<usize>() + text.len()
                    > 32 * 1024 * 1024)
        {
            self.0.pop_front();
        }
        self.0.push_back(Entry {
            revision: revision.into(),
            id: id.into(),
            text,
            inserted: Instant::now(),
        });
    }
}

pub(super) fn shared() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_is_bounded_expires_and_keys_both_identity_and_revision() {
        let mut cache = Cache::default();
        for i in 0..5 {
            cache.insert(&i.to_string(), "p", Arc::from("body"));
        }
        assert_eq!(cache.0.len(), 4);
        assert!(cache.get("0", "p").is_none());
        assert!(cache.get("4", "other").is_none());
        assert!(cache.get("4", "p").is_some());
        cache.0.back_mut().unwrap().inserted = Instant::now() - Duration::from_secs(31);
        assert!(cache.get("4", "p").is_none());
        for i in 0..3 {
            cache.insert(&i.to_string(), "p", Arc::from("x".repeat(12 * 1024 * 1024)));
        }
        assert_eq!(cache.0.len(), 2);
    }
}
