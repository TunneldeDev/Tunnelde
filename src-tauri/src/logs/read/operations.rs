use super::{
    contracts::{Batch, Request, MAX_SAFE},
    cursor::Position,
    projection,
};
use crate::{
    db::Database,
    error::{AppError, AppResult},
};

pub(super) fn read(
    db: &Database,
    request: &Request,
    position: &mut Position,
    batch: &mut Batch,
    check: &impl Fn() -> AppResult<()>,
) -> AppResult<(bool, bool)> {
    check()?;
    // Avoid taking the policy while holding the DB lock: grants persist in reverse order.
    let (minimum, maximum, rows) = db.with(|connection| {
        let tx = connection.unchecked_transaction()?;
        let (minimum, maximum): (i64, i64) = tx.query_row(
            "SELECT coalesce(min(id),0), coalesce(max(id),0) FROM (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1000)", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        if minimum < 0 || maximum < 0 || maximum as u64 > MAX_SAFE { return Err(AppError::validation("logs.read.unavailable")); }
        let (minimum, maximum) = (minimum as u64, maximum as u64);
        let offset = if position.operation_id > maximum { 0 } else { position.operation_id };
        let offset = offset.max(minimum.saturating_sub(1));
        // Retention is 1000 rows; SQL limits also bound reads of an older database.
        let mut query = tx.prepare("SELECT id, ts, substr(action,1,1025), substr(target,1,1025) FROM audit_log WHERE id > ?1 ORDER BY id ASC LIMIT 1000")?;
        let rows = query.query_map([offset as i64], |row| Ok((row.get::<_,i64>(0)?, row.get::<_,i64>(1)?, row.get::<_,String>(2)?, row.get::<_,Option<String>>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
        Ok((minimum, maximum, rows))
    })?;
    check()?;
    let reset = position.operation_id > maximum;
    if reset {
        position.operation_id = 0;
    }
    batch.gap |= reset || minimum > position.operation_id.saturating_add(1);
    position.operation_id = position.operation_id.max(minimum.saturating_sub(1));
    for (id, timestamp, action, target) in rows {
        check()?;
        let entry = projection::operation(timestamp, action, target);
        if request.filter.matches(&entry) && !batch.push(entry, request) {
            break;
        }
        batch.gap |= id as u64 > position.operation_id.saturating_add(1);
        position.operation_id = id as u64;
    }
    check()?;
    Ok((position.operation_id < maximum, reset))
}
