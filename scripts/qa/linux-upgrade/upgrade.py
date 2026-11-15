"""Application-initiated upgrade of an original public package on a disposable host."""
from dataclasses import dataclass
import hashlib
import json
import os
import subprocess
import time
from typing import Callable
from retention import Retention
from selection import require_selected_target, validate_pair


@dataclass
class NativeDriver:
    execute: Callable
    wait: Callable
    application: Callable
    find: Callable
    capture: Callable
    tree: Callable
    owned_pid: Callable


def run_upgrade(driver, binary, data, evidence, report):
    assert os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch'
    assert os.environ['GITHUB_REPOSITORY'] == 'TunneldeDev/Tunnelde'
    assert os.environ['OTA_UPGRADE_ACK'] == 'upgrade-test-only'
    import pyatspi
    target = os.environ['OTA_TARGET_VERSION']
    channel = validate_pair(report['version'], target)
    expected_digest = os.environ['OTA_TARGET_SHA256']
    pointer = data / 'automation.json'
    old_pid = report['ownedPid']
    report['upgrade'] = dict(target=target, automaticRestart=False,
                             sourcePid=old_pid, checks=[], normalQuit=False)
    upgrade = report['upgrade']

    def cli(*command):
        entry = dict(command=list(command[:2]))
        upgrade.setdefault('cliCalls', []).append(entry)
        try:
            output = driver.execute(
                [str(binary), 'cli', '--endpoint', str(pointer), *command], timeout=30)
        except subprocess.CalledProcessError as error:
            entry.update(exitCode=error.returncode, stderr=error.stderr)
            raise
        entry['exitCode'] = 0
        reply = json.loads(output.stdout)
        assert 'error' not in reply, reply
        return reply['result']

    changes = {
        'general': {'language': 'en-US', 'closeToTray': False},
        'appearance': {'theme': 'light'},
        'editor': {'tabSize': 8},
        'updates': {'autoCheck': False, 'channel': channel, 'source': 'github', 'sourceUrl': ''},
    }
    for attempt in range(3):
        before = cli('preferences', 'snapshot')
        request = dict(revision=before['revision'], changes=changes)
        try:
            seeded = cli('preferences', 'update', '--params', json.dumps(request))
            break
        except subprocess.CalledProcessError as error:
            # Startup's automatic check may commit last-check metadata. Only an
            # explicit CAS rejection proves no write occurred. Read a new token
            # for the same reviewed fixture values; never retry unknown writes.
            failure = json.loads(error.stderr)
            if failure.get('error', {}).get('code') != 'stale_revision' or attempt == 2:
                raise
    assert seeded['values']['editor']['tabSize'] == 8
    (evidence / 'preferences-before.json').write_text(json.dumps(seeded, indent=2))

    app = driver.application()
    assert app is not None and app.get_process_id() == old_pid
    windows = driver.execute(['xdotool', 'search', '--onlyvisible', '--pid', str(old_pid)]).stdout.split()
    assert windows
    driver.execute(['xdotool', 'windowactivate', '--sync', windows[0]])
    retention = Retention(driver, app, data, evidence, cli)
    records = retention.seed()
    upgrade['checks'].append('Native GUI saved a synthetic host and named settings profile')
    driver.execute(['xdotool', 'key', '--clearmodifiers', 'F1'])
    driver.execute(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'])
    driver.execute(['xdotool', 'type', '--clearmodifiers', '--delay', '15', '>Check for updates'])
    driver.wait(lambda: driver.find(app, 'list item', 'Check for updates'), 15)
    driver.capture('upgrade-command', 'list item', 'Check for updates', app)
    driver.execute(['xdotool', 'key', '--clearmodifiers', 'Return'])

    def install_button():
        (evidence / 'accessible-update.json').write_text(json.dumps(driver.tree(app), indent=2))
        button = driver.find(app, 'push button', 'Download and install')
        if button is not None:
            if button.getState().contains(pyatspi.STATE_ENABLED):
                return (button,)
        return None

    button = driver.wait(install_button, 90)[0]
    driver.capture('update-available', 'push button', 'Download and install', app, light_text=True)
    observed = driver.tree(app)
    (evidence / 'accessible-selected-target.json').write_text(json.dumps(observed, indent=2))
    upgrade['selectedTargetLabel'] = require_selected_target(observed, report['version'], target)
    upgrade['checks'].append('Exact source-to-target update selection verified before installation')
    rect = button.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    assert rect.x >= 0 and rect.y >= 0 and rect.width > 0 and rect.height > 0
    initial_stat = binary.stat()
    initial_identity = (initial_stat.st_dev, initial_stat.st_ino, initial_stat.st_size,
                        initial_stat.st_mtime_ns)
    driver.execute(['xdotool', 'mousemove', '--sync', str(rect.x + rect.width // 2),
                    str(rect.y + rect.height // 2), 'click', '1'])
    upgrade['installClickedAt'] = time.time()
    upgrade['checks'].append('Native pointer activated the original application Download and install button')

    checked_identity = None
    checked_digest = None

    def restarted():
        nonlocal checked_identity, checked_digest
        candidate = driver.application()
        if candidate is not None and candidate.get_process_id() != old_pid:
            upgrade['restartCandidatePid'] = candidate.get_process_id()
        if not binary.is_file() or binary.is_symlink():
            return False
        stat = binary.stat()
        identity = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if identity == initial_identity:
            return False
        if checked_identity != identity:
            checked_digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            checked_identity = identity
        if checked_digest != expected_digest:
            return False
        try:
            info = cli('app', 'info')
            return info if info.get('version') == target else None
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
            return None

    # No harness launch occurs here: only observe the package path and its live
    # public endpoint after the updater installs and restarts the application.
    info = driver.wait(restarted, 180)
    upgrade['installedSha256'] = hashlib.sha256(binary.read_bytes()).hexdigest()
    upgrade['liveInfo'] = info
    new_app = driver.wait(driver.application, 45)
    new_pid = new_app.get_process_id()
    assert new_pid != old_pid and driver.owned_pid(new_pid)
    upgrade['restartedPid'] = new_pid
    upgrade['automaticRestart'] = True
    upgrade['checks'].append('Installed bytes equal the exact target public AppImage; live target endpoint appeared without a harness launch')
    after = cli('preferences', 'snapshot')
    (evidence / 'preferences-after.json').write_text(json.dumps(after, indent=2))
    assert after['values'] == seeded['values'], 'Seeded public preferences changed during upgrade'
    retention.verify(new_app, records)
    upgrade['checks'].append('Synthetic public host and nonempty named settings profile retained unchanged')
    upgrade['checks'].append('All public preference values, including seeded language/theme/tab size/close behavior/update selection, retained')
    (evidence / 'accessible-after.json').write_text(json.dumps(driver.tree(new_app), indent=2))
    def restored_tab():
        for name in ('Settings', 'Welcome'):
            tab = driver.find(new_app, 'page tab', name)
            if tab is not None:
                return (tab,)
        return None
    tab = driver.wait(restored_tab, 30)[0]
    label = (tab.name or '').split(' Close tab')[0]
    assert label in ('Settings', 'Welcome')
    driver.capture('after-upgrade', 'page tab', label, new_app)
    new_windows = driver.execute(['xdotool', 'search', '--onlyvisible', '--pid', str(new_pid)]).stdout.split()
    assert new_windows
    driver.execute(['xdotool', 'windowactivate', '--sync', new_windows[0]])
    driver.execute(['xdotool', 'key', '--clearmodifiers', 'alt+F4'])
    driver.wait(lambda: not pointer.exists() and not driver.owned_pid(new_pid), 30)
    upgrade['normalQuit'] = True
    upgrade['checks'].append('Native close with closeToTray=false removed the endpoint and ended the owned target process')
    upgrade['limitations'] = [
        'No nonempty history/plugin/credential migration acceptance',
        'Xvfb native generated input, not physical Linux desktop input',
        'Normal close observed through endpoint and owned process disappearance; target is not a Python child with an exit status',
    ]
