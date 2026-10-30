// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

/// Ordered, append-only schema migrations. Never edit an entry that has
/// shipped: add a new one and bump the array.
pub const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE groups (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL,
    parent_id  TEXT REFERENCES groups(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_groups_parent ON groups(parent_id);

CREATE TABLE hosts (
    id          TEXT PRIMARY KEY NOT NULL,
    group_id    TEXT REFERENCES groups(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL DEFAULT 22,
    username    TEXT NOT NULL DEFAULT '',
    auth_method TEXT NOT NULL DEFAULT 'password',
    favorite    INTEGER NOT NULL DEFAULT 0,
    color       TEXT,
    tags        TEXT NOT NULL DEFAULT '[]',
    note        TEXT,
    last_used_at INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_hosts_group ON hosts(group_id);
CREATE INDEX idx_hosts_recent ON hosts(last_used_at DESC);

CREATE TABLE tabs (
    id         TEXT PRIMARY KEY NOT NULL,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    host_id    TEXT REFERENCES hosts(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    state      TEXT
);
CREATE INDEX idx_tabs_order ON tabs(sort_order);

CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
"#,
    r#"
ALTER TABLE hosts ADD COLUMN key_path TEXT;

CREATE TABLE known_hosts (
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    algorithm   TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (host, port)
);
"#,
    r#"
CREATE TABLE command_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id      TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    command      TEXT NOT NULL,
    executed_at  INTEGER NOT NULL
);
CREATE INDEX idx_history_host ON command_history(host_id, executed_at DESC);
"#,
];
