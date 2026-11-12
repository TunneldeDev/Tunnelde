//! Revision-CAS transitions. The write transaction also arbitrates quota/path admission.
#[cfg(test)]
use super::Binding;
use super::{DispatchPermit, Error, Journal, Record, Result, Stage};
use crate::ssh::files::native_save;
use native_save::contracts::{self, receipt::Observation};
use rusqlite::{params, Connection, TransactionBehavior};
const MAX_RECORD: usize = 32768;
const CAPACITY: usize = 128;
impl Journal {
    pub fn records(&self) -> Result<Vec<Record>> {
        self.verify()?;
        read_records(&self.conn, &self.id)
    }
    pub fn current(&self, expected: &Record) -> Result<Record> {
        self.records()?
            .into_iter()
            .find(|record| record.binding.operation_id == expected.binding.operation_id)
            .filter(|record| record == expected)
            .ok_or(Error::Changed)
    }
    #[cfg(test)]
    pub fn reserve(&mut self, binding: Binding) -> Result<Record> {
        if !binding.valid() {
            return Err(Error::Unrecognized);
        }
        self.verify()?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        let records = read_records(&tx, &self.id)?;
        if records.len() >= CAPACITY {
            return Err(Error::Capacity);
        }
        if records.iter().any(|record| {
            record.binding.operation_id == binding.operation_id
                || (record.blocks_target() && record.binding.overlaps(&binding))
        }) {
            return Err(Error::Occupied);
        }
        let record = Record {
            journal_id: self.id.clone(),
            binding,
            revision: 1,
            stage: Stage::Reserved,
            observation: None,
            release: None,
        };
        let (bytes, digest) = encode(&record)?;
        tx.execute(
            "INSERT INTO records VALUES(?1,?2,?3,?4)",
            params![
                record.binding.operation_id,
                record.revision as i64,
                bytes,
                digest
            ],
        )
        .map_err(|_| Error::Unavailable)?;
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()?;
        Ok(record)
    }
    pub(super) fn replace(&mut self, expected: &Record, next: &Record) -> Result<Record> {
        self.verify()?;
        if next.binding != expected.binding
            || next.journal_id != expected.journal_id
            || next.revision != expected.revision.checked_add(1).ok_or(Error::Capacity)?
        {
            return Err(Error::Changed);
        }
        let (bytes, digest) = encode(next)?;
        let (previous, previous_digest) = encode(expected)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        if !expected.occupies_worker() && next.occupies_worker() {
            let active = read_records(&tx, &self.id)?
                .into_iter()
                .filter(Record::occupies_worker)
                .count();
            if active >= 4 {
                return Err(Error::Capacity);
            }
        }
        let changed = tx.execute("UPDATE records SET revision=?1,value=?2,digest=?3 WHERE id=?4 AND revision=?5 AND value=?6 AND digest=?7", params![next.revision as i64,bytes,digest,expected.binding.operation_id,expected.revision as i64,previous,previous_digest]).map_err(|_| Error::Unavailable)?;
        if changed != 1 {
            return Err(Error::Changed);
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()?;
        Ok(next.clone())
    }
    #[cfg(test)]
    pub fn ready(&mut self, record: &Record) -> Result<Record> {
        if record.stage != Stage::Reserved {
            return Err(Error::Changed);
        }
        let mut next = record.clone();
        next.stage = Stage::Ready;
        next.revision += 1;
        self.replace(record, &next)
    }
    pub fn dispatch(&mut self, record: &Record) -> Result<(Record, DispatchPermit)> {
        if record.stage != Stage::Ready {
            return Err(Error::Changed);
        }
        let mut next = record.clone();
        next.stage = Stage::Dispatched;
        next.revision += 1;
        let next = self.replace(record, &next)?;
        Ok((
            next,
            DispatchPermit {
                binding: record.binding.clone(),
            },
        ))
    }
    pub fn observe(&mut self, record: &Record, receipt: Observation) -> Result<Record> {
        if record.stage != Stage::Dispatched
            || !receipt.valid()
            || record
                .observation
                .as_ref()
                .is_some_and(|previous| !native_save::client::follows(previous, &receipt))
        {
            return Err(Error::Changed);
        }
        let mut next = record.clone();
        next.observation = Some(receipt);
        next.revision += 1;
        self.replace(record, &next)
    }
    pub fn release(&mut self, record: &Record, discard_backup: bool) -> Result<Record> {
        let receipt = record.observation.as_ref().ok_or(Error::Changed)?;
        if record.stage != Stage::Dispatched
            || record.release.is_some()
            || !receipt.releasable()
            || (receipt.backup_retained == Some(true) && !discard_backup)
        {
            return Err(Error::Changed);
        }
        let mut next = record.clone();
        next.release = Some(super::record::Release {
            revision: receipt.revision,
            discard_backup,
        });
        next.revision += 1;
        self.replace(record, &next)
    }
}

pub(super) fn encode(record: &Record) -> Result<(String, String)> {
    if !record.valid() {
        return Err(Error::Unrecognized);
    }
    let bytes = serde_json::to_string(record).map_err(|_| Error::Unrecognized)?;
    if bytes.len() > MAX_RECORD {
        return Err(Error::Capacity);
    }
    let digest = contracts::hash(b"tunnelde.files.journal.v1\0", bytes.as_bytes());
    Ok((bytes, digest))
}
// Called both for public reads and inside the actual write transaction.
pub(super) fn read_records(conn: &Connection, journal_id: &str) -> Result<Vec<Record>> {
    let mut query = conn
        .prepare("SELECT id,revision,value,digest FROM records LIMIT 129")
        .map_err(|_| Error::Unrecognized)?;
    let mut rows = query.query([]).map_err(|_| Error::Unavailable)?;
    let mut records = Vec::new();
    while let Some(row) = rows.next().map_err(|_| Error::Unrecognized)? {
        let id: String = row.get(0).map_err(|_| Error::Unrecognized)?;
        let revision: i64 = row.get(1).map_err(|_| Error::Unrecognized)?;
        let bytes = row
            .get_ref(2)
            .map_err(|_| Error::Unrecognized)?
            .as_str()
            .map_err(|_| Error::Unrecognized)?;
        let digest: String = row.get(3).map_err(|_| Error::Unrecognized)?;
        if bytes.len() > MAX_RECORD
            || contracts::hash(b"tunnelde.files.journal.v1\0", bytes.as_bytes()) != digest
        {
            return Err(Error::Unrecognized);
        }
        let record: Record = serde_json::from_str(bytes).map_err(|_| Error::Unrecognized)?;
        if !record.valid()
            || record.journal_id != journal_id
            || record.binding.operation_id != id
            || revision <= 0
            || record.revision != revision as u64
        {
            return Err(Error::Unrecognized);
        }
        records.push(record);
    }
    if records.len() > CAPACITY {
        return Err(Error::Capacity);
    }
    Ok(records)
}
