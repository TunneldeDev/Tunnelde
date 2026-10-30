// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use keyring::{Entry, Error as KeyringError};

use crate::error::{AppError, AppResult};

const SERVICE: &str = "dev.tunnelde.app";

fn entry(host_id: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, host_id)
        .map_err(|error| AppError::Ssh(format!("vault.unavailable: {error}")))
}

pub fn save(host_id: &str, password: &str) -> AppResult<()> {
    entry(host_id)?
        .set_password(password)
        .map_err(|error| AppError::Ssh(format!("vault.save: {error}")))
}

pub fn load(host_id: &str) -> AppResult<Option<String>> {
    match entry(host_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(AppError::Ssh(format!("vault.load: {error}"))),
    }
}

pub fn forget(host_id: &str) -> AppResult<()> {
    match entry(host_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(AppError::Ssh(format!("vault.forget: {error}"))),
    }
}

pub fn has(host_id: &str) -> AppResult<bool> {
    Ok(load(host_id)?.is_some())
}
