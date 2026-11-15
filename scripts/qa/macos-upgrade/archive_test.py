"""Security regressions for public-app extraction, using only temporary files."""
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import tarfile
import unittest

from archive import extract


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.archive = self.root / "app.tar.gz"
        self.destination = self.root / "install"
        self.destination.mkdir()

    def write(self, entries):
        with tarfile.open(self.archive, "w:gz") as bundle:
            for name, kind in entries:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
                entry.linkname = "../../escaped"
                entry.size = 5 if kind == tarfile.REGTYPE else 0
                bundle.addfile(entry, BytesIO(b"hello") if entry.isfile() else None)

    def test_regular_bundle(self):
        self.write([("Tunnelde.app", tarfile.DIRTYPE),
                    ("Tunnelde.app/Contents/MacOS/tunnelde", tarfile.REGTYPE)])
        extract(self.archive, self.destination)
        self.assertEqual((self.destination / "Tunnelde.app/Contents/MacOS/tunnelde").read_bytes(), b"hello")

    def test_reject_before_writing_any_member(self):
        for name, kind in [
            ("/Tunnelde.app/out", tarfile.REGTYPE),
            ("Tunnelde.app/../escaped", tarfile.REGTYPE),
            ("Other.app/out", tarfile.REGTYPE),
            ("Tunnelde.app/link", tarfile.SYMTYPE),
            ("Tunnelde.app/link", tarfile.LNKTYPE),
            ("Tunnelde.app/pipe", tarfile.FIFOTYPE),
            ("Tunnelde.app/device", tarfile.CHRTYPE),
            ("Tunnelde.app/back\\slash", tarfile.REGTYPE),
            ("Tunnelde.app/ok", tarfile.REGTYPE),
        ]:
            with self.subTest(name=name, kind=kind):
                self.write([("Tunnelde.app/ok", tarfile.REGTYPE), (name, kind)])
                with self.assertRaises(ValueError):
                    extract(self.archive, self.destination)
                self.assertEqual(list(self.destination.iterdir()), [])

    def test_nonempty_and_symlink_destinations(self):
        self.write([("Tunnelde.app/ok", tarfile.REGTYPE)])
        existing = self.destination / "keep"
        existing.write_bytes(b"keep")
        with self.assertRaises(ValueError):
            extract(self.archive, self.destination)
        self.assertEqual(existing.read_bytes(), b"keep")
        alias = self.root / "alias"
        try:
            alias.symlink_to(self.destination, target_is_directory=True)
        except OSError:
            return  # Windows may forbid creating symlinks without developer mode.
        with self.assertRaises(ValueError):
            extract(self.archive, alias)
        nested = self.destination / "nested"
        nested.mkdir()
        with self.assertRaises(ValueError):
            extract(self.archive, alias / "nested")

    def test_empty_archive(self):
        self.write([])
        with self.assertRaises(ValueError):
            extract(self.archive, self.destination)


if __name__ == "__main__":
    unittest.main()
