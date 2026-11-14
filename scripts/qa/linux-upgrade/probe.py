"""Observe only an owned original package on a disposable GitHub Linux runner."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import traceback


def main():
    # Repeat the boundary before importing desktop libraries or launching an App.
    assert sys.platform == 'linux'
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    root = Path(os.environ['OTA_PROBE_ROOT']).resolve(strict=True)
    assert root.parent == Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    assert root.name.startswith('tunnelde-linux-ota-')
    binary = Path(os.environ['OTA_PROBE_BINARY'])
    assert not binary.is_symlink() and binary.resolve(strict=True).parent == root
    version = os.environ['OTA_PROBE_VERSION']
    assert re.fullmatch(r'\d+\.\d+\.\d+(?:-beta\.[1-9])?', version)
    evidence = root / 'evidence'
    data = root / 'data'
    data.mkdir()
    assert not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN')
    report = dict(passed=False, packageChanged=False, version=version, actions=[])
    processes = []
    env = dict(os.environ, TUNNELDE_DATA_DIR=str(data), APPIMAGE_EXTRACT_AND_RUN='1',
               GTK_MODULES='atk-bridge', NO_AT_BRIDGE='0', LANG='en_US.UTF-8')
    original_digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    signal.signal(signal.SIGTERM, lambda _signal, _frame: sys.exit('Probe interrupted'))

    def execute(arguments, timeout=15):
        return subprocess.run(arguments, env=env, text=True, capture_output=True, timeout=timeout, check=True)

    def wait(predicate, timeout=45):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            value = predicate()
            if value:
                return value
            time.sleep(.2)
        raise TimeoutError('Probe condition did not become true')

    def owned_pid(pid):
        try:
            return ('TUNNELDE_DATA_DIR=' + str(data)).encode() in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
        except (OSError, ValueError):
            return False

    def tree(node, depth=0):
        nonlocal nodes
        if depth > 30 or nodes > 2500:
            return []
        nodes += 1
        result = [dict(role=node.getRoleName(), name=node.name or '', depth=depth)]
        for child in node:
            if child is not None:
                result.extend(tree(child, depth + 1))
        return result

    try:
        import pyatspi
        offline = json.loads(execute([str(binary), 'cli', '--version'], timeout=30).stdout)
        assert offline['version'] == version
        report['offlineVersion'] = offline
        with (evidence / 'openbox.log').open('w') as log:
            wm = subprocess.Popen(['openbox'], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(wm)
        with (evidence / 'application.log').open('w') as log:
            app = subprocess.Popen([str(binary)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(app)
        wait(lambda: (data / 'automation.json').is_file(), 75)
        reply = json.loads(execute([str(binary), 'cli', '--endpoint', str(data / 'automation.json'), 'app', 'info'], timeout=30).stdout)
        assert reply['result']['version'] == version
        report['liveInfo'] = reply['result']

        def application():
            for candidate in pyatspi.Registry.getDesktop(0):
                if candidate is not None and owned_pid(candidate.get_process_id()):
                    return candidate
            return None

        accessible = wait(application)
        report['ownedPid'] = accessible.get_process_id()
        nodes = 0
        before = tree(accessible)
        (evidence / 'accessible-before.json').write_text(json.dumps(before, indent=2))
        assert any(v['name'] == 'Welcome' for v in before), 'WebKit accessible content unavailable'
        # Select only windows belonging to this exact isolated process.
        windows = execute(['xdotool', 'search', '--onlyvisible', '--pid', str(report['ownedPid'])]).stdout.split()
        assert windows
        execute(['xdotool', 'windowactivate', '--sync', windows[0]])
        execute(['xdotool', 'key', '--clearmodifiers', 'F1'])
        report['actions'].append('Native generated F1 in the owned window')

        def palette():
            nonlocal nodes
            nodes = 0
            observed = tree(accessible)
            return observed if any(v['name'] == 'Check for updates' for v in observed) else None

        after = wait(palette, 15)
        (evidence / 'accessible-palette.json').write_text(json.dumps(after, indent=2))
        execute(['import', '-window', 'root', str(evidence / 'palette.png')])
        execute(['xdotool', 'key', '--clearmodifiers', 'Escape'])
        report['passed'] = True
    except Exception:
        report['failure'] = traceback.format_exc()
        try:
            execute(['import', '-window', 'root', str(evidence / 'failure.png')])
        except Exception as screenshot_error:
            report['screenshotFailure'] = str(screenshot_error)
        raise
    finally:
        # These are only new child process groups; never enumerate/kill desktop Apps.
        report['cleanup'] = []
        for process in reversed(processes):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=10)
                except ProcessLookupError:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)
            report['cleanup'].append(dict(pid=process.pid, exitCode=process.returncode))
        report['packageChanged'] = hashlib.sha256(binary.read_bytes()).hexdigest() != original_digest
        report['cleanupIsNormalQuit'] = False
        if (data / 'logs').is_dir():
            shutil.copytree(data / 'logs', evidence / 'logs')
        (evidence / 'gui-probe.json').write_text(json.dumps(report, indent=2))
        assert not report['packageChanged']


if __name__ == '__main__':
    main()
