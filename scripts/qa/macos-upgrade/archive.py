"""Extract a verified public app archive after validating every member."""
from pathlib import Path, PurePosixPath
import sys
import tarfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def extract(archive, destination):
    destination = Path(destination)
    require(destination.is_absolute() and destination.is_dir(), "Expected an absolute directory")
    require(destination.resolve() == destination, "Symlink or noncanonical extraction directory")
    require(not any(destination.iterdir()), "Extraction directory must be empty")
    with tarfile.open(archive, 'r:gz') as bundle:
        entries, names, size = [], set(), 0
        for entry in bundle:
            name = PurePosixPath(entry.name)
            require(name.parts and name.parts[0] == 'Tunnelde.app', "Unexpected bundle root")
            require(not name.is_absolute() and '..' not in entry.name.split('/'), "Unsafe path")
            require('\\' not in entry.name, "Backslashes are forbidden")
            require(entry.isfile() or entry.isdir(), "Links and special entries are forbidden")
            require(entry.mode & 0o6000 == 0, "Set-id modes are forbidden")
            require(name not in names, "Duplicate archive entry")
            require(entry.size >= 0, "Negative member size")
            names.add(name)
            entries.append(entry)
            size += entry.size
            require(len(entries) <= 100_000 and size <= 1024 * 1024 * 1024, "Archive too large")
        require(entries, "Empty archive")
        # Every member was checked before any extraction; no symlink/hardlink can
        # redirect a later file outside the initially empty owned directory.
        bundle.extractall(destination, members=entries)


if __name__ == '__main__':
    require(len(sys.argv) == 3, "Expected archive and destination")
    extract(sys.argv[1], sys.argv[2])
