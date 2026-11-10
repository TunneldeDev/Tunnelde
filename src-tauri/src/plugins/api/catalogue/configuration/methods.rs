use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!(
        "configuration.schema",
        [],
        "{}",
        "Read this runtime owner's declarative configuration schema."
    ),
    method!(
        "configuration.snapshot",
        [],
        "{}",
        "Read owned settings and schema status; never migrates or writes defaults."
    ),
    method!(
        "configuration.update",
        [],
        "{expectedRevision:string,schemaDigest:string,values:object}",
        "CAS replace a complete validated owned configuration; schema drift blocks writes."
    ),
    method!(
        "configuration.migrate",
        [],
        "{expectedRevision:string,schemaDigest:string}",
        "Explicitly apply declared data migrations and atomically retain the original backup."
    ),
    method!(
        "configuration.backups",
        [],
        "{}",
        "Read at most eight owned configuration backups; values are private to the owner."
    ),
    method!(
        "configuration.restore",
        [],
        "{expectedRevision:string,schemaDigest:string,backupId:string}",
        "Restore an owned backup with a fresh revision and retain the superseded document."
    ),
    method!(
        "configuration.deleteBackup",
        [],
        "{expectedRevision:string,schemaDigest:string,backupId:string}",
        "Explicitly remove one owned backup; no automatic retention eviction."
    ),
];
