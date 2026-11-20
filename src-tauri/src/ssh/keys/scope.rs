//! Original effect authority and resource CAS, not a caller-replaceable target.
use super::*;
use crate::services::operations::WorkLifetime;
use crate::ssh::session::review::Observed;

type Check = dyn Fn(&rusqlite::Connection) -> AppResult<()> + Send + Sync;
pub(super) struct Scope {
    origin: WorkLifetime,
    check: Box<Check>,
}
impl Scope {
    pub(super) fn new(
        check: impl Fn(&rusqlite::Connection) -> AppResult<()> + Send + Sync + 'static,
    ) -> Self {
        Self {
            origin: WorkLifetime::current(),
            check: Box::new(check),
        }
    }
    fn at<T>(
        &self,
        conn: &rusqlite::Connection,
        run: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        (self.check)(conn)?;
        run(conn)
    }
    pub(super) fn with_observed<T>(
        &self,
        app: &AppHandle,
        observed: &Observed,
        run: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        self.origin
            .with(|| observed.with_current(app, |conn| self.at(conn, run)))
    }
    pub(super) fn current<T>(
        &self,
        app: &AppHandle,
        target: &Target,
        run: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let observed = target.observe(app)?;
        self.with_observed(app, &observed, run)
    }
    pub(super) async fn current_background(
        &self,
        app: &AppHandle,
        target: &Target,
    ) -> AppResult<()> {
        let observed = target.observe_background(app).await?;
        self.with_observed(app, &observed, |_| Ok(()))
    }
}
#[cfg(test)]
mod tests;
