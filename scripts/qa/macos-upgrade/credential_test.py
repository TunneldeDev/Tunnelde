import sqlite3
import unittest
from credential import credential_identity

HOST = "9694d335-6ed3-44c6-9a69-3618c092ccc5"
ITEM = "24647adc-9ccb-4c5b-b7ad-879a62f03c9c"
REV = "f348be40-465b-4e92-8153-ad5a780f089d"


class CredentialIdentityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)

    def tables(self):
        self.db.executescript("""
            CREATE TABLE credential_bindings(kind, owner, revision, item, incarnation, legacy);
            CREATE TABLE credential_operations(id, kind, owner, phase);
        """)

    def binding(self, item=ITEM, legacy=0, revision=REV, incarnation=None):
        self.db.execute("INSERT INTO credential_bindings VALUES ('host',?,?,?,?,?)",
                        (HOST, revision, item, incarnation, legacy))

    def test_legacy_without_schema_or_binding(self):
        self.assertEqual(credential_identity(self.db, HOST), {"kind": "legacy", "id": HOST})
        self.tables()
        self.assertEqual(credential_identity(self.db, HOST), {"kind": "legacy", "id": HOST})
        self.binding(item=None, legacy=1)
        self.assertEqual(credential_identity(self.db, HOST), {"kind": "legacy", "id": HOST})

    def test_published_immutable_item(self):
        self.tables()
        self.binding()
        self.db.execute("INSERT INTO credential_operations VALUES (?,'host',?,'published')", (ITEM, HOST))
        before = self.db.total_changes
        self.assertEqual(credential_identity(self.db, HOST), {"kind": "immutable", "id": ITEM})
        self.assertEqual(self.db.total_changes, before)

    def test_tombstone_cannot_fall_back_to_legacy(self):
        self.tables()
        self.binding(item=None)
        with self.assertRaisesRegex(ValueError, "forgotten"):
            credential_identity(self.db, HOST)

    def test_invalid_metadata_cannot_fall_back(self):
        self.tables()
        for kwargs in [{"legacy": 1}, {"legacy": 2}, {"item": "other"},
                       {"revision": "other"}, {"incarnation": "other"}]:
            with self.subTest(kwargs=kwargs):
                self.db.execute("DELETE FROM credential_bindings")
                self.binding(**kwargs)
                with self.assertRaises(ValueError):
                    credential_identity(self.db, HOST)

    def test_unpublished_wrong_owner_and_duplicate_operations_reject(self):
        self.tables()
        self.binding()
        for rows in [[], [(ITEM, "host", HOST, "intent")],
                     [(ITEM, "proxy", HOST, "published")],
                     [(ITEM, "host", REV, "published")],
                     [(ITEM, "host", HOST, "published")] * 2]:
            with self.subTest(rows=rows):
                self.db.execute("DELETE FROM credential_operations")
                self.db.executemany("INSERT INTO credential_operations VALUES (?,?,?,?)", rows)
                with self.assertRaises(ValueError):
                    credential_identity(self.db, HOST)

    def test_invalid_host_is_rejected_before_lookup(self):
        for host in ["../other", HOST.upper(), "tunnelde.credential.v1:" + ITEM]:
            with self.subTest(host=host), self.assertRaises(ValueError):
                credential_identity(self.db, host)


if __name__ == "__main__":
    unittest.main()
