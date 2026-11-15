"""Pure guards shared by the native Linux updater driver and its tests."""
import re


def version_key(version):
    match = re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]))?', version)
    assert match and len(version) < 63, 'Invalid public version'
    return tuple(int(part) for part in match.groups()[:3]) + (int(match[4] or 10),)


def validate_pair(source, target):
    assert version_key(source) >= version_key('1.2.1'), 'Source predates the supported CLI'
    assert version_key(target) > version_key(source), 'Target must be newer'
    return 'beta' if '-beta.' in target else 'stable'


def require_selected_target(observed, source, target):
    validate_pair(source, target)
    expected = f'Release notes · v{source} → v{target}'
    labels = [node['name'] for node in observed if node.get('name', '').startswith('Release notes · v')]
    assert labels == [expected], f'Unexpected update selection: {labels!r}; expected {expected!r}'
    return expected
