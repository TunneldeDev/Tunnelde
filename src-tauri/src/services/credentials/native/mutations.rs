use super::*;

impl<P: Platform> Service<'_, P> {
    pub(in crate::services::credentials) fn save<Before, Check>(
        &self,
        request: &Request<'_, Before, Check>,
        secret: &str,
        job: &Cancellation,
    ) -> AppResult<()>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&Connection) -> AppResult<Stamp>,
    {
        self.save_with(request, secret, || job.commit())
    }

    /// Compound host/profile persistence already admitted its original write.
    pub(in crate::services::credentials) fn save_after_admission<Before, Check>(
        &self,
        request: &Request<'_, Before, Check>,
        secret: &str,
    ) -> AppResult<()>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&Connection) -> AppResult<Stamp>,
    {
        self.save_with(request, secret, || Ok(()))
    }

    fn save_with<Before, Check>(
        &self,
        request: &Request<'_, Before, Check>,
        secret: &str,
        admit: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&Connection) -> AppResult<Stamp>,
    {
        self.own(request)?;
        let intent = request.with(|conn| {
            transaction(conn, |conn| {
                let intent = bindings::begin(conn, &request.binding, &request.stamp.0, self.run)?;
                // Queue cancellation and DB/policy waits must settle before the
                // original request admits even the first OS mutation.
                admit()?;
                Ok(intent)
            })
        })?;

        if let Err(error) = self.platform.write(&intent.physical().key(), secret) {
            // A failed OS reply does not prove absence or rollback. Keep intent
            // as unknown under its original identity for controlled recovery.
            tracing::warn!(target: "credentials", operation = %intent.id(),
                stage = "os-write", reason = error.code(), action = "inspect_original_operation",
                "Credential write result is unconfirmed; original operation retained");
            return Err(error);
        }

        let publication = self
            .transaction(|conn| bindings::written(conn, &intent))
            .and_then(|()| {
                request.with(|conn| {
                    transaction(conn, |conn| {
                        bindings::publish(conn, &intent, &request.stamp.0)
                    })
                })
            });
        if let Err(error) = publication {
            // The original operation still owns its item, even after its host,
            // profile, request or authorization changed. Cleanup cannot depend
            // on reacquiring authority to the replacement logical target.
            if let Err(cleanup) = self.transaction(|conn| bindings::abandon(conn, &intent)) {
                tracing::warn!(target: "credentials", operation = %intent.id(),
                    stage = "retirement-record", reason = cleanup.code(),
                    action = "inspect_original_operation",
                    "Could not record retirement; durable credential intent retained");
            }
            return Err(error);
        }
        Ok(())
    }

    /// Forget publishes only a tombstone. Slow OS deletion runs separately and
    /// only against the captured retired item, after all authority gates end.
    pub(in crate::services::credentials) fn forget<Before, Check>(
        &self,
        request: &Request<'_, Before, Check>,
        job: &Cancellation,
    ) -> AppResult<()>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&Connection) -> AppResult<Stamp>,
    {
        self.forget_with(request, || job.commit())
    }

    pub(in crate::services::credentials) fn forget_after_admission<Before, Check>(
        &self,
        request: &Request<'_, Before, Check>,
    ) -> AppResult<()>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&Connection) -> AppResult<Stamp>,
    {
        self.forget_with(request, || Ok(()))
    }

    fn forget_with<Before, Check>(
        &self,
        request: &Request<'_, Before, Check>,
        admit: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&Connection) -> AppResult<Stamp>,
    {
        self.own(request)?;
        request.with(|conn| {
            transaction(conn, |conn| {
                bindings::verify(conn, &request.binding)?;
                admit()?;
                bindings::forget(conn, &request.binding)
            })
        })
    }
}
