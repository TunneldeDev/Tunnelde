-- Secret values never enter this database. Physical OS item names are derived
-- from random operation UUIDs; a retired item can never be published again.
CREATE TABLE credential_bindings (
    kind TEXT NOT NULL CHECK (kind IN ('host', 'proxy')),
    owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
    revision TEXT NOT NULL CHECK (length(revision) = 36),
    incarnation TEXT CHECK (incarnation IS NULL OR length(incarnation) = 36),
    item TEXT UNIQUE CHECK (item IS NULL OR length(item) = 36),
    legacy INTEGER NOT NULL CHECK (legacy IN (0, 1)),
    PRIMARY KEY (kind, owner),
    CHECK (legacy = 0 OR item IS NULL),
    FOREIGN KEY (item, kind, owner) REFERENCES credential_operations(id, kind, owner)
);
CREATE TABLE credential_operations (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
    kind TEXT NOT NULL CHECK (kind IN ('host', 'proxy')),
    owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
    run TEXT NOT NULL CHECK (length(run) = 36),
    expected_revision TEXT CHECK (expected_revision IS NULL OR length(expected_revision) = 36),
    authority TEXT NOT NULL CHECK (length(authority) = 64),
    phase TEXT NOT NULL CHECK (phase IN ('intent', 'written', 'published', 'abandoned')),
    created_at INTEGER NOT NULL,
    UNIQUE (id, kind, owner)
);
CREATE INDEX credential_operations_run ON credential_operations(run, phase);
CREATE INDEX credential_operations_owner ON credential_operations(kind, owner, phase);
CREATE TABLE credential_cleanup (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
    kind TEXT NOT NULL CHECK (kind IN ('host', 'proxy')),
    owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
    item TEXT CHECK (item IS NULL OR length(item) = 36),
    legacy INTEGER NOT NULL CHECK (legacy IN (0, 1)),
    claimed_run TEXT CHECK (claimed_run IS NULL OR length(claimed_run) = 36),
    created_at INTEGER NOT NULL,
    CHECK ((legacy = 1 AND item IS NULL) OR (legacy = 0 AND item IS NOT NULL)),
    FOREIGN KEY (item, kind, owner) REFERENCES credential_operations(id, kind, owner)
);
CREATE UNIQUE INDEX credential_cleanup_immutable ON credential_cleanup(item) WHERE legacy = 0;
CREATE UNIQUE INDEX credential_cleanup_legacy ON credential_cleanup(kind, owner) WHERE legacy = 1;
CREATE INDEX credential_cleanup_owner ON credential_cleanup(kind, owner);
