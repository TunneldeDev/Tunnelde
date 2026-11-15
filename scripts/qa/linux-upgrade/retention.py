"""Synthetic GUI records and read-only snapshots of the owned upgrade database."""
import json
import sqlite3

HOST_NAME = 'OTA retained Linux host'
PROFILE_NAME = 'OTA retained Linux profile'
INPUT_ROLES = ('text', 'entry', 'embedded')


class Retention:
    def __init__(self, driver, app, data, evidence, cli):
        import pyatspi
        self.atspi, self.driver, self.app = pyatspi, driver, app
        self.data, self.evidence, self.cli = data, evidence, cli

    def matches(self, role, name):
        assert self.driver.owned_pid(self.app.get_process_id())
        result, count = [], 0

        def visit(node, depth):
            nonlocal count
            count += 1
            assert depth <= 30 and count <= 2500, 'Incomplete accessibility traversal'
            state = node.getState()
            roles = (role,) if isinstance(role, str) else role
            if (node.getRoleName() in roles and node.name == name
                    and state.contains(self.atspi.STATE_SHOWING)
                    and state.contains(self.atspi.STATE_ENABLED)):
                result.append(node)
            for child in node:
                if child is not None:
                    visit(child, depth + 1)
        visit(self.app, 0)
        return result

    def click(self, role, name):
        def ready():
            (self.evidence / 'retention-accessibility.json').write_text(
                json.dumps(self.driver.tree(self.app), indent=2), encoding='utf-8')
            found = self.matches(role, name)
            assert len(found) <= 1, f'Ambiguous {role}: {name}'
            return (found[0],) if found else None
        element = self.driver.wait(ready, 20)[0]
        rect = element.queryComponent().getExtents(self.atspi.DESKTOP_COORDS)
        assert rect.x >= 0 and rect.y >= 0 and rect.width > 0 and rect.height > 0
        self.driver.execute(['xdotool', 'mousemove', '--sync',
                             str(rect.x + rect.width // 2), str(rect.y + rect.height // 2), 'click', '1'])

    def fill(self, name, value):
        # ASCII fixture typing does not establish physical Unicode/IME behavior.
        assert value.isascii() and '\n' not in value
        self.click(INPUT_ROLES, name)
        self.driver.execute(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'])
        self.driver.execute(['xdotool', 'type', '--clearmodifiers', '--delay', '15', value])

    def snapshot(self):
        assert self.driver.owned_pid(self.app.get_process_id())
        database = self.data / 'tunnelde.db'
        assert database.resolve(strict=True) == database
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
            connection.execute('BEGIN')
            row = connection.execute("SELECT value FROM settings WHERE key='settings.profiles.v1'").fetchone()
            assert row is not None
            profiles = json.loads(row[0])
        return dict(hosts=self.cli('hosts', 'list')['hosts'], profiles=profiles)

    def seed(self):
        self.driver.execute(['xdotool', 'key', '--clearmodifiers', 'ctrl+comma'])
        self.click('push button', 'Save as profile…')
        self.fill('Profile name', PROFILE_NAME)
        self.click('push button', 'Save')
        self.driver.wait(lambda: not self.matches(INPUT_ROLES, 'Profile name'), 20)
        self.driver.execute(['xdotool', 'key', '--clearmodifiers', 'ctrl+n'])
        for label, value in [('Name', HOST_NAME), ('Host', '127.0.0.1'), ('Port', '2209'), ('User', 'qa')]:
            self.fill(label, value)
        # No credential: keyring/real authentication retention is still separate.
        self.click('push button', 'Save')
        self.driver.wait(lambda: not self.matches(INPUT_ROLES, 'Name'), 20)
        before = self.snapshot()
        host, = (v for v in before['hosts'] if v['name'] == HOST_NAME)
        assert (host['address'], host['port'], host['username']) == ('127.0.0.1', 2209, 'qa')
        profile, = (v for v in before['profiles'] if v['name'] == PROFILE_NAME)
        assert profile['settings']['editorTabSize'] == 8
        (self.evidence / 'records-before.json').write_text(json.dumps(before, indent=2), encoding='utf-8')
        self.driver.capture('retained-records', 'heading', HOST_NAME, self.app)
        return before

    def verify(self, app, before):
        self.app = app
        after = self.snapshot()
        (self.evidence / 'records-after.json').write_text(json.dumps(after, indent=2), encoding='utf-8')
        assert after == before, 'Host or named settings profile changed during update'
