"""Read only the synthetic hosted profile; never accept a developer data path."""
import json
import hashlib
import os
from pathlib import Path
import pwd
import sqlite3
import sys
import uuid


def snapshot(host):
    home = Path("/", "Users", "runner")
    user = pwd.getpwuid(os.getuid())
    if not (sys.platform == "darwin" and user.pw_name == "runner" and user.pw_dir == str(home)
            and os.environ.get("HOME") == str(home)
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and os.environ.get("GITHUB_REPOSITORY") == "TunneldeDev/Tunnelde"
            and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and os.environ.get("MACOS_OTA_ACK") == "original-public-ota"):
        raise ValueError("Refusing a non-hosted native profile")
    if str(uuid.UUID(host)) != host:
        raise ValueError("Expected the synthetic host UUID")
    database = home / "Library/Application Support/dev.tunnelde.app/tunnelde.db"
    if database.resolve() != database or not database.is_file():
        raise ValueError("Unsafe database path")
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        connection.execute("BEGIN")
        profiles = connection.execute("SELECT value FROM settings WHERE key='settings.profiles.v1'").fetchone()
        security = connection.execute("SELECT value FROM settings WHERE key='plugin_security'").fetchone()
        history = connection.execute("SELECT command,executed_at FROM command_history WHERE host_id=? ORDER BY id", (host,)).fetchall()
        result = {"profiles": json.loads(profiles[0]) if profiles else [],
                "security": json.loads(security[0]) if security else None,
                "history": history, "readOnly": True}
        if os.environ.get("MACOS_OTA_MODE") == "retention":
            package = database.parent / "plugins/qa-macos-ota-retention"
            hashes = {}
            for name in ["tunnelde-plugin.json", "ui/main.mjs"]:
                path = package / name
                if path.resolve() != path or not path.is_file() or path.stat().st_size > 128 * 1024:
                    raise ValueError("Unsafe synthetic plugin path or size")
                hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
            result["pluginPackageSha256"] = hashes
        return result


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise ValueError("Expected synthetic host UUID")
    print(json.dumps(snapshot(sys.argv[1])))
