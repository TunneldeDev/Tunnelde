//! Logical retirement never frees capacity held by actual native IO workers.
use super::contracts::*;
use crate::{error::AppResult, services::files::read::Source};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;

struct State {
    phase: Phase,
    source: Option<Source>,
    size: Option<u64>,
    deadline: Instant,
    active: usize,
}
pub(in crate::plugins) struct Entry {
    pub id: String,
    pub request: Prepare,
    state: Mutex<State>,
}
impl Entry {
    pub fn new(request: Prepare) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            request,
            state: Mutex::new(State {
                phase: Phase::Prepared,
                source: None,
                size: None,
                deadline: Instant::now() + Duration::from_millis(PREPARED_MS),
                active: 0,
            }),
        }
    }
    pub fn expired(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.phase == Phase::Closed || state.deadline <= Instant::now()
    }
    pub fn begin(self: &Arc<Self>) -> AppResult<Opening> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Prepared || state.deadline <= Instant::now() {
            return Err(unavailable());
        }
        state.phase = Phase::Opening;
        state.deadline = Instant::now() + Duration::from_millis(PREPARED_MS);
        state.active += 1;
        Ok(Opening {
            entry: self.clone(),
            complete: false,
        })
    }
    pub fn read(self: &Arc<Self>, offset: u64, length: u64) -> AppResult<Reading> {
        if offset > MAX_SAFE_INTEGER || length == 0 || length > MAX_CHUNK {
            return Err(invalid());
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Open || state.deadline <= Instant::now() {
            return Err(unavailable());
        }
        let size = state.size.ok_or_else(unavailable)?;
        if offset > size {
            return Err(invalid());
        }
        let source = state.source.clone().ok_or_else(unavailable)?;
        let length = length.min(size - offset);
        state.deadline = Instant::now() + Duration::from_millis(IDLE_MS);
        state.active += 1;
        Ok(Reading {
            entry: self.clone(),
            source,
            offset,
            length,
            size,
        })
    }
    /// Returns whether a caller/worker may still be settling. Native admission
    /// stays held independently even after this logical record is removed.
    pub fn close(&self) -> bool {
        let (source, active) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = Phase::Closed;
            let settling = state.active > 0 || state.source.is_some();
            (state.source.take(), settling)
        };
        if let Some(source) = source {
            source.retire();
        }
        active
    }
    pub fn observe(&self) -> Observation {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let closed = state.phase == Phase::Closed || state.deadline <= Instant::now();
        Observation {
            version: 1,
            content_id: self.id.clone(),
            state: if closed { Phase::Closed } else { state.phase },
            size: if closed { None } else { state.size },
            chunk_bytes: MAX_CHUNK,
            lease_ms: if closed {
                0
            } else {
                state
                    .deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u64
            },
        }
    }
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.close();
    }
}
pub(in crate::plugins) struct Opening {
    entry: Arc<Entry>,
    complete: bool,
}
impl Opening {
    pub fn finish(mut self, source: Source, size: u64) -> AppResult<Observation> {
        if size > MAX_SAFE_INTEGER {
            source.retire();
            return Err(invalid());
        }
        {
            let mut state = self.entry.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.phase != Phase::Opening || state.deadline <= Instant::now() {
                source.retire();
                return Err(unavailable());
            }
            state.source = Some(source);
            state.size = Some(size);
            state.phase = Phase::Open;
            state.deadline = Instant::now() + Duration::from_millis(IDLE_MS);
        }
        self.complete = true;
        Ok(self.entry.observe())
    }
}
impl Drop for Opening {
    fn drop(&mut self) {
        if !self.complete {
            self.entry.close();
        }
        self.entry
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active -= 1;
    }
}
pub(in crate::plugins) struct Reading {
    entry: Arc<Entry>,
    pub source: Source,
    pub offset: u64,
    pub length: u64,
    pub size: u64,
}
impl Reading {
    pub fn check(&self) -> AppResult<()> {
        if self.entry.expired() {
            Err(unavailable())
        } else {
            Ok(())
        }
    }
    pub fn finish(&self, bytes: Vec<u8>) -> AppResult<Chunk> {
        self.check()?;
        if bytes.len() as u64 != self.length {
            return Err(invalid());
        }
        Ok(Chunk {
            version: 1,
            content_id: self.entry.id.clone(),
            offset: self.offset,
            bytes: bytes.len(),
            data: STANDARD.encode(bytes),
            eof: self.offset + self.length >= self.size,
        })
    }
}
impl Drop for Reading {
    fn drop(&mut self) {
        self.entry
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active -= 1;
    }
}
