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
    nodes = 0
    env = dict(os.environ, TUNNELDE_DATA_DIR=str(data), APPIMAGE_EXTRACT_AND_RUN='1',
               GTK_MODULES='atk-bridge', NO_AT_BRIDGE='0', LANG='en_US.UTF-8')
    original_digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    signal.signal(signal.SIGTERM, lambda _signal, _frame: sys.exit('Probe interrupted'))

    def execute(arguments, timeout=15):
        return subprocess.run(arguments, env=env, text=True, capture_output=True, timeout=timeout, check=True)

    def wait(predicate, timeout=45):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            from gi.repository import GLib
            context = GLib.MainContext.default()
            while context.pending():
                context.iteration(False)
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

    def find_element(node, role, prefix, depth=0):
        if depth > 30:
            return None
        if node.getRoleName() == role and (node.name or '').startswith(prefix):
            return node
        for child in node:
            if child is not None:
                found = find_element(child, role, prefix, depth + 1)
                if found is not None:
                    return found
        return None

    def capture(label, role, prefix):
        path = evidence / (label + '.png')
        control = evidence / (label + '-control.png')
        samples = report.setdefault('captureColorCounts', {}).setdefault(label, [])
        matching_frames = 0

        def painted():
            nonlocal matching_frames
            target = find_element(accessible, role, prefix)
            if target is None:
                return False
            rect = target.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
            if rect.x < 0 or rect.y < 0 or rect.width <= 0 or rect.height <= 0:
                return False
            execute(['import', '-window', 'root', str(path)])
            crop = f'{rect.width}x{rect.height}+{rect.x}+{rect.y}'
            execute(['convert', str(path), '-crop', crop, '+repage', str(control)])
            colors = int(execute(['identify', '-format', '%k', str(control)]).stdout)
            text = execute(['tesseract', str(control), 'stdout', '--psm', '6']).stdout
            expected_visible = prefix.lower() in ' '.join(text.lower().split())
            samples.append(dict(colors=colors, bounds=crop, text=text,
                                expectedVisible=expected_visible))
            # Accessibility and paint can advance at different times. Colors from
            # an older list are insufficient: require the expected control's text
            # in two actual captures. Screenshots still require human review.
            matching_frames = matching_frames + 1 if expected_visible and colors > 32 else 0
            return matching_frames >= 2

        time.sleep(.5)  # AT-SPI state can precede the corresponding painted frame.
        wait(painted, 12)

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

        def welcome():
            nonlocal nodes
            nodes = 0
            observed = tree(accessible)
            (evidence / 'accessible-before.json').write_text(json.dumps(observed, indent=2))
            return observed if any(v['role'] == 'page tab' and v['name'].startswith('Welcome') for v in observed) else None

        wait(welcome)  # The CLI endpoint is published before frontend/window readiness.
        capture('before', 'page tab', 'Welcome')
        # Select only windows belonging to this exact isolated process.
        windows = execute(['xdotool', 'search', '--onlyvisible', '--pid', str(report['ownedPid'])]).stdout.split()
        assert windows
        execute(['xdotool', 'windowactivate', '--sync', windows[0]])
        execute(['xdotool', 'key', '--clearmodifiers', 'F1'])
        execute(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'])
        execute(['xdotool', 'type', '--clearmodifiers', '--delay', '15', '>Check for updates'])
        report['actions'].append('Native generated F1 in the owned window')

        def palette():
            nonlocal nodes
            nodes = 0
            observed = tree(accessible)
            (evidence / 'accessible-palette.json').write_text(json.dumps(observed, indent=2))
            return observed if any(v['role'] == 'list item' or v['role'] == 'option' for v in observed if v['name'].startswith('Check for updates')) else None

        after = wait(palette, 15)
        (evidence / 'accessible-palette.json').write_text(json.dumps(after, indent=2))
        capture('palette', 'list item', 'Check for updates')
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
