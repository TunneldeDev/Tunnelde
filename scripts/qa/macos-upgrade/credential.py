"""Resolve only a synthetic host's credential identity; never read OS secrets."""
import uuid


def canonical_uuid(value, version=None):
    parsed = uuid.UUID(value)
    if str(parsed) != value or (version is not None and parsed.version != version):
        raise ValueError("Noncanonical credential identity")
    return value


def credential_identity(connection, host):
    canonical_uuid(host)
    table = connection.execute(
        "SELECT type FROM sqlite_master WHERE name='credential_bindings'"
    ).fetchone()
    if table is None:
        return {"kind": "legacy", "id": host}
    if table != ("table",):
        raise ValueError("Invalid credential binding table")
    row = connection.execute(
        "SELECT revision, item, incarnation, legacy FROM credential_bindings "
        "WHERE kind='host' AND owner=?", (host,)
    ).fetchone()
    if row is None:
        return {"kind": "legacy", "id": host}
    revision, item, incarnation, legacy = row
    canonical_uuid(revision, 4)
    if incarnation is not None:
        canonical_uuid(incarnation, 4)
    if legacy not in (0, 1) or (legacy == 1 and item is not None):
        raise ValueError("Invalid credential binding")
    if item is not None:
        canonical_uuid(item, 4)
        published = connection.execute(
            "SELECT 1 FROM credential_operations "
            "WHERE id=? AND kind='host' AND owner=? AND phase='published'", (item, host)
        ).fetchall()
        if published != [(1,)]:
            raise ValueError("Credential item is not uniquely published for this host")
        return {"kind": "immutable", "id": item}
    if legacy == 1:
        return {"kind": "legacy", "id": host}
    raise ValueError("Synthetic credential was forgotten")
