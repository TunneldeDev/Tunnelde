CREATE TABLE mount_groups (
    id TEXT PRIMARY KEY NOT NULL,
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE (id, host_id)
);
CREATE INDEX idx_mount_groups_host ON mount_groups(host_id, id);
CREATE TABLE mount_rules (
    id TEXT PRIMARY KEY NOT NULL,
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY (group_id, host_id) REFERENCES mount_groups(id, host_id) ON DELETE CASCADE
);
CREATE INDEX idx_mount_rules_host ON mount_rules(host_id, id);
CREATE INDEX idx_mount_rules_group ON mount_rules(group_id, id);
CREATE TABLE mount_state (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL);
INSERT INTO mount_state(id,revision) VALUES(1,lower(hex(randomblob(16))));
CREATE TRIGGER mount_groups_insert AFTER INSERT ON mount_groups BEGIN UPDATE mount_state SET revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER mount_groups_update AFTER UPDATE ON mount_groups BEGIN UPDATE mount_state SET revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER mount_groups_delete AFTER DELETE ON mount_groups BEGIN UPDATE mount_state SET revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER mount_rules_insert AFTER INSERT ON mount_rules BEGIN UPDATE mount_state SET revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER mount_rules_update AFTER UPDATE ON mount_rules BEGIN UPDATE mount_state SET revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER mount_rules_delete AFTER DELETE ON mount_rules BEGIN UPDATE mount_state SET revision=lower(hex(randomblob(16))) WHERE id=1; END;

CREATE TABLE mount_legacy_dismissed (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL);
