use super::*;
use crate::services::operations::Authority;
use std::sync::{Arc, Mutex};
struct Consent(Arc<Mutex<bool>>);
impl Authority for Consent {
    fn with_current(&self, run: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        let live = self.0.lock().unwrap();
        if !*live {
            return Err(AppError::validation("retired original consent"));
        }
        run()
    }
}
fn database() -> rusqlite::Connection {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE reviewed(revision TEXT, auth TEXT); INSERT INTO reviewed VALUES('one','password')").unwrap();
    db
}
fn scope() -> Scope {
    Scope::new(|db| {
        if db.query_row("SELECT revision FROM reviewed", [], |row| {
            row.get::<_, String>(0)
        })? != "one"
        {
            return Err(AppError::validation("forward.changed"));
        }
        Ok(())
    })
}
fn switch(scope: &Scope, db: &rusqlite::Connection) -> AppResult<()> {
    scope.origin.with(|| {
        scope.at(db, |conn| {
            conn.execute("UPDATE reviewed SET auth='key'", [])?;
            Ok(())
        })
    })
}
#[tokio::test]
async fn original_authority_is_retained_outside_its_task_and_not_replaced_by_later_consent() {
    let live = Arc::new(Mutex::new(true));
    let authority = Arc::new(Consent(live.clone()));
    let weak = Arc::downgrade(&authority);
    let captured = WorkLifetime::authorized(authority)
        .scope(async { scope() })
        .await;
    assert!(weak.upgrade().is_some());
    *live.lock().unwrap() = false;
    let db = database();
    let later = WorkLifetime::authorized(Arc::new(Consent(Arc::new(Mutex::new(true)))));
    let error = later
        .scope(async { switch(&captured, &db) })
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "retired original consent");
    assert_eq!(
        db.query_row("SELECT auth FROM reviewed", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "password"
    );
    drop(captured);
    assert!(weak.upgrade().is_none());
}
#[test]
fn resource_predicate_and_auth_publication_share_the_same_db_boundary() {
    let db = database();
    let captured = scope();
    db.execute("UPDATE reviewed SET revision='replacement'", [])
        .unwrap();
    assert_eq!(
        switch(&captured, &db).unwrap_err().to_string(),
        "forward.changed"
    );
    assert_eq!(
        db.query_row("SELECT auth FROM reviewed", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "password"
    );
    db.execute("UPDATE reviewed SET revision='one'", [])
        .unwrap();
    switch(&captured, &db).unwrap();
    assert_eq!(
        db.query_row("SELECT auth FROM reviewed", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "key"
    );
}
