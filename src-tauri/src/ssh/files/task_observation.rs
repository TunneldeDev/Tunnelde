//! Runtime task epochs outlive UI results. Neither clearing the result cache nor
//! retrying cleanup may discard an original unconfirmed protocol request.
use super::*;

impl TransferState {
    pub(super) fn observation_for_registration(
        &mut self,
        id: &str,
    ) -> AppResult<native_save::runtime::MutationObservation> {
        if let Some(previous) = self.unconfirmed.get(id) {
            close(previous)?;
            self.unconfirmed.remove(id);
        }
        Ok(native_save::runtime::MutationObservation::default())
    }

    pub(super) fn retain_observation(
        &mut self,
        id: &str,
        observation: native_save::runtime::MutationObservation,
    ) {
        if close(&observation).is_err() {
            self.unconfirmed.insert(id.into(), observation);
        }
    }
}

fn close(observation: &native_save::runtime::MutationObservation) -> AppResult<()> {
    if observation.closed() {
        Ok(())
    } else {
        observation.seal()
    }
}

impl TransferRegistry {
    pub(super) fn observation(
        &self,
        id: &str,
    ) -> AppResult<native_save::runtime::MutationObservation> {
        self.inner
            .lock()
            .map_err(|_| AppError::internal("sftp.transferRegistry"))?
            .active
            .get(id)
            .map(|task| task.observation.clone())
            .ok_or_else(|| AppError::validation("sftp.transferBusy"))
    }

    /// A cleanup epoch can start only after the original epoch is atomically
    /// sealed. Old queued clones then cannot mutate artifacts during cleanup.
    pub(super) fn begin_cleanup(
        &self,
        id: &str,
    ) -> AppResult<native_save::runtime::MutationObservation> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| AppError::internal("sftp.transferRegistry"))?;
        let task = state
            .active
            .get_mut(id)
            .ok_or_else(|| AppError::validation("sftp.transferBusy"))?;
        close(&task.observation)?;
        task.observation = native_save::runtime::MutationObservation::default();
        Ok(task.observation.clone())
    }
}

#[cfg(test)]
mod tests;
