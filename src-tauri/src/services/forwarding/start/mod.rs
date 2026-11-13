//! Main-application forwarding requests. Neither reviews nor plugin leases
//! confer this authority. Lock order: requests -> forwards -> database -> SSH.
pub(crate) mod commands;
mod connections;
mod consent;
mod operation;
pub(crate) mod receipt;

use super::contract::RevisionedRule;
use crate::{
    error::{AppError, AppResult},
    models::Host,
    ssh::session::review::{Review, Target},
    state::AppState,
};
use receipt::{Book, Input, Phase, Receipt};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone)]
struct Captured {
    entry: RevisionedRule,
    host: Host,
    jumps: Vec<Host>,
    review: Review,
}
#[derive(Default)]
struct State {
    book: Book<Captured>,
    pool: HashMap<String, Weak<connections::Connection>>,
}
#[derive(Default)]
pub(crate) struct ManagerState(Mutex<State>);
impl ManagerState {
    fn lock(&self) -> AppResult<MutexGuard<'_, State>> {
        self.0
            .lock()
            .map_err(|_| AppError::internal("forward.lock"))
    }
}
fn changed(app: &AppHandle) {
    let _ = app.emit("forwarding://start-changed", ());
}

pub(crate) fn begin(app: &AppHandle, input: Input) -> AppResult<Receipt> {
    let state = app.state::<AppState>();
    let mut manager = state.forward_starts.lock()?;
    if let Some(receipt) = manager.book.replay(&input, Instant::now())? {
        return Ok(receipt);
    }
    let entry =
        super::find(app, &input.id)?.ok_or_else(|| AppError::validation("forward.missing"))?;
    if entry.revision != input.revision {
        return Err(AppError::validation("forward.changed"));
    }
    if entry.info.active {
        return Err(AppError::validation("forward.alreadyActive"));
    }
    super::contract::validate(&entry.info.rule)?;
    let host = crate::services::hosts::resolve(app, &entry.info.rule.host_id)?;
    // Capture before any user consent. Later calls may only reconstruct an
    // equal reviewed route, never prepare a new target from frontend data.
    let target = Target::from_displayed(app, &host)?;
    let captured = Captured {
        entry: RevisionedRule {
            rule: entry.info.rule,
            revision: entry.revision,
        },
        host,
        jumps: target.jump_hosts(),
        review: target.review(),
    };
    let permit = super::interaction::admit()?;
    let receipt = manager.book.insert(
        input.clone(),
        captured.clone(),
        Instant::now(),
        crate::models::now_ms(),
    )?;
    drop(manager);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        consent::run(handle, input.request_id, captured, permit).await;
    });
    let handle = app.clone();
    let id = receipt.input.request_id.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let Ok(receipt) = status(&handle, &id) else {
                break;
            };
            if receipt.phase.terminal() {
                changed(&handle);
                break;
            }
        }
    });
    Ok(receipt)
}
pub(crate) fn status(app: &AppHandle, id: &str) -> AppResult<Receipt> {
    let state = app.state::<AppState>();
    let mut manager = state.forward_starts.lock()?;
    Ok(manager.book.get(id, Instant::now())?.receipt.clone())
}
pub(crate) fn cancel(app: &AppHandle, id: &str) -> AppResult<Receipt> {
    let receipt = app
        .state::<AppState>()
        .forward_starts
        .lock()?
        .book
        .cancel(id, Instant::now())?;
    changed(app);
    Ok(receipt)
}
pub(crate) fn cancel_pending(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut manager) = state.forward_starts.lock() {
            manager.book.cancel_pending(Instant::now());
        }
        changed(app);
    }
}
fn verify_rule(app: &AppHandle, captured: &Captured) -> AppResult<()> {
    let saved = super::find(app, &captured.entry.rule.id)?;
    if saved.as_ref().is_none_or(|e| {
        e.revision != captured.entry.revision || e.info.rule != captured.entry.rule || e.info.active
    }) {
        return Err(AppError::validation("forward.changed"));
    }
    Ok(())
}
