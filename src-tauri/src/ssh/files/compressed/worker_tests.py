"""Exercise the actual ephemeral worker, including its filesystem boundaries."""
import io
import json
import os
import select
from pathlib import Path
import subprocess
import sys
import tempfile
import tarfile
import unittest
import zlib

WORKER = Path(sys.argv.pop(1)).resolve()
TEMP_ROOT = Path(sys.argv.pop(1)).resolve()
TEMP_ROOT.mkdir(parents=True, exist_ok=True)
MAGIC = b'TUNNELDE-COMPRESSED-1\n'


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='compressed-', dir=TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def run_worker(self, frames, home=None):
        process = subprocess.Popen(
            [sys.executable, '-I', '-S', '-u', str(WORKER), str(self.root) if home is None else home],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=self.root,
        )
        try:
            output, error = process.communicate(frames, timeout=10)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        return process.returncode, output, error

    def frame(self, request_id, op, payload=b'', **fields):
        fields.update(id=request_id, op=op, size=len(payload))
        return json.dumps(fields).encode() + b'\n' + payload

    def replies(self, frames):
        code, output, error = self.run_worker(frames)
        self.assertEqual(code, 0, error)
        output = io.BytesIO(output)
        self.assertEqual(output.readline(), MAGIC)
        replies = []
        while True:
            line = output.readline()
            if not line:
                return replies
            reply = json.loads(line)
            payload = output.read(reply['size'])
            self.assertEqual(len(payload), reply['size'])
            replies.append((reply, payload))

    def test_compressed_and_raw_ranges_keep_offsets_unicode_and_existing_content(self):
        path = self.root / "文件 ' name.bin"
        path.write_bytes(b'preserved' + bytes(300000))
        text = b'compressible block\n' * 14000
        frames = self.frame(1, 'open', path=str(path), write=True)
        frames += self.frame(2, 'write', zlib.compress(text), handle='1', offset=9, length=len(text), compressed=True)
        frames += self.frame(3, 'write', b'END', handle='1', offset=9 + len(text), length=3)
        frames += self.frame(4, 'close', handle='1')
        frames += self.frame(5, 'open', path=str(path), write=False)
        frames += self.frame(6, 'read', handle='2', offset=9, length=len(text))
        frames += self.frame(7, 'close', handle='2')
        replies = self.replies(frames)
        self.assertFalse(any('error' in reply for reply, _ in replies))
        self.assertTrue(replies[5][0]['compressed'])
        self.assertEqual(zlib.decompress(replies[5][1]), text)
        self.assertEqual(path.read_bytes()[:9 + len(text) + 3], b'preserved' + text + b'END')

    def archive(self, files, names=None, kinds=None):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for index, data in enumerate(files):
                info = tarfile.TarInfo(str(index) if names is None else names[index])
                info.size = len(data)
                if kinds is not None:
                    info.type = kinds[index]
                archive.addfile(info, io.BytesIO(data))
        return output.getvalue()

    def test_archives_roundtrip_empty_unicode_and_binary_without_extracting_paths(self):
        files = [b'', '中文\0 🐦'.encode(), bytes(range(256)) * 256]
        paths = [self.root / ('文件-%s.bin' % index) for index in range(len(files))]
        for path, data in zip(paths, files):
            path.write_bytes(data)
        entries = [dict(path=str(path), length=len(data)) for path, data in zip(paths, files)]
        reply, packed = self.replies(self.frame(1, 'archive_read', entries=entries, compression=True))[0]
        self.assertNotIn('error', reply)
        data = zlib.decompress(packed) if reply['compressed'] else packed
        self.assertEqual(len(data), reply['length'])
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            self.assertEqual([archive.extractfile(str(n)).read() for n in range(len(files))], files)
        destinations = [self.root / ('staging-%s' % index) for index in range(len(files))]
        for path in destinations:
            path.touch()
        target_entries = [dict(path=str(path), length=len(data)) for path, data in zip(destinations, files)]
        reply, _ = self.replies(self.frame(2, 'archive_write', packed, entries=target_entries,
            length=len(data), compressed=reply['compressed']))[0]
        self.assertNotIn('error', reply)
        self.assertEqual([path.read_bytes() for path in destinations], files)

    def test_archive_rejects_malicious_members_before_any_destination_write(self):
        first, second = self.root / 'stage1', self.root / 'stage2'
        first.touch()
        second.touch()
        entries = [dict(path=str(first), length=1), dict(path=str(second), length=1)]
        fixtures = [
            self.archive([b'x', b'y'], ['0', '../escape']),
            self.archive([b'x', b'y'], ['0', '/absolute']),
            self.archive([b'x', b'y'], ['0', '0']),
            self.archive([b'x', b'y'], kinds=[tarfile.REGTYPE, tarfile.SYMTYPE]),
            self.archive([b'x', b'y'], kinds=[tarfile.REGTYPE, tarfile.LNKTYPE]),
            self.archive([b'x', b'y'], kinds=[tarfile.REGTYPE, tarfile.FIFOTYPE]),
            self.archive([b'x', b'yy']),
            self.archive([b'x', b'y', b'z']),
            self.archive([b'x']),
        ]
        for payload in fixtures:
            reply, _ = self.replies(self.frame(1, 'archive_write', payload,
                entries=entries, length=len(payload)))[0]
            self.assertIn('error', reply)
            self.assertEqual(first.read_bytes(), b'')
            self.assertEqual(second.read_bytes(), b'')

    def test_archive_does_not_create_truncate_or_write_special_files(self):
        first, second = self.root / 'stage1', self.root / 'stage2'
        first.touch()
        second.write_bytes(b'preserved')
        archive = self.archive([b'x', b'y'])
        entries = [dict(path=str(first), length=1), dict(path=str(second), length=1)]
        reply, _ = self.replies(self.frame(1, 'archive_write', archive,
            entries=entries, length=len(archive)))[0]
        self.assertIn('error', reply)
        self.assertEqual(first.read_bytes(), b'')
        self.assertEqual(second.read_bytes(), b'preserved')
        second.unlink()
        reply, _ = self.replies(self.frame(2, 'archive_write', archive,
            entries=entries, length=len(archive)))[0]
        self.assertIn('error', reply)
        self.assertFalse(second.exists())
        os.symlink(first, second)
        reply, _ = self.replies(self.frame(3, 'archive_write', archive,
            entries=entries, length=len(archive)))[0]
        self.assertIn('error', reply)
        self.assertEqual(first.read_bytes(), b'')
        second.unlink()
        os.mkfifo(second)
        reply, _ = self.replies(self.frame(4, 'archive_read', entries=entries))[0]
        self.assertIn('error', reply)

    def test_delayed_archive_cannot_recreate_a_retired_generation(self):
        retired, resumed = self.root / 'retired.part', self.root / 'new-generation.part'
        retired.touch()
        payload = self.archive([b'old bytes'])
        frame = self.frame(1, 'archive_write', payload,
            entries=[dict(path=str(retired), length=9)], length=len(payload))
        split = frame.index(b'\n') + 2
        process = subprocess.Popen([sys.executable, '-I', '-S', '-u', str(WORKER), str(self.root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.root)
        try:
            self.assertEqual(process.stdout.readline(), MAGIC)
            process.stdin.write(frame[:split])
            process.stdin.flush()
            retired.unlink()
            resumed.write_bytes(b'new generation remains untouched')
            output, error = process.communicate(frame[split:], timeout=10)
            self.assertEqual(process.returncode, 0, error)
            self.assertIn('error', json.loads(output))
            self.assertFalse(retired.exists())
            self.assertEqual(resumed.read_bytes(), b'new generation remains untouched')
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_open_archive_descriptor_cannot_write_into_a_new_generation(self):
        retired, resumed = self.root / 'retired.part', self.root / 'new-generation.part'
        retired.touch()
        ready_read, ready_write = os.pipe()
        resume_read, resume_write = os.pipe()
        wrapper = '''
import os, sys
worker, home, ready, resume = sys.argv[1:]
original = os.pwrite
def delayed(fd, data, offset):
    os.write(int(ready), b'1')
    if os.read(int(resume), 1) != b'1':
        raise RuntimeError('test gate closed')
    return original(fd, data, offset)
os.pwrite = delayed
sys.argv = [worker, home]
with open(worker, encoding='utf-8') as script:
    exec(compile(script.read(), worker, 'exec'), {'__name__': '__main__'})
'''
        process = subprocess.Popen([sys.executable, '-I', '-S', '-u', '-c', wrapper,
            str(WORKER), str(self.root), str(ready_write), str(resume_read)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=self.root, pass_fds=(ready_write, resume_read))
        os.close(ready_write)
        os.close(resume_read)
        try:
            self.assertEqual(process.stdout.readline(), MAGIC)
            payload = self.archive([b'old bytes'])
            process.stdin.write(self.frame(1, 'archive_write', payload,
                entries=[dict(path=str(retired), length=9)], length=len(payload)))
            process.stdin.flush()
            self.assertTrue(select.select([ready_read], [], [], 5)[0], 'worker did not reach pwrite')
            self.assertEqual(os.read(ready_read, 1), b'1')
            retired.unlink()
            resumed.write_bytes(b'new generation remains untouched')
            os.write(resume_write, b'1')
            output, error = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, error)
            self.assertNotIn('error', json.loads(output))
            self.assertFalse(retired.exists())
            self.assertEqual(resumed.read_bytes(), b'new generation remains untouched')
        finally:
            os.close(ready_read)
            os.close(resume_write)
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_archive_rejects_invalid_manifests_and_compression_bombs(self):
        path = self.root / 'stage'
        path.touch()
        entry = dict(path=str(path), length=1)
        for entries in [[], [entry] * 2, [entry] * 9,
                [dict(path='relative', length=1)], [dict(path=str(path), length=65537)]]:
            reply, _ = self.replies(self.frame(1, 'archive_read', entries=entries))[0]
            self.assertIn('error', reply)
        archive = self.archive([b'x'])
        for packed in [zlib.compress(archive)[:-1], zlib.compress(archive) + b'trailing',
                zlib.compress(b'x' * 1048577)]:
            reply, _ = self.replies(self.frame(2, 'archive_write', packed,
                entries=[entry], length=len(archive), compressed=True))[0]
            self.assertIn('error', reply)
            self.assertEqual(path.read_bytes(), b'')

    def test_invalid_compressed_payloads_do_not_modify_existing_data(self):
        path = self.root / 'safe.bin'
        path.write_bytes(b'sentinel')
        packed = zlib.compress(b'a' * 10000)
        frames = self.frame(1, 'open', path=str(path), write=True)
        for index, payload in enumerate([packed[:-1], packed + b'extra', zlib.compress(b'a' * 1000000)]):
            frames += self.frame(index + 2, 'write', payload, handle='1', offset=0, length=10000, compressed=True)
        frames += self.frame(5, 'close', handle='1')
        replies = self.replies(frames)
        self.assertTrue(all('error' in reply for reply, _ in replies[1:4]))
        self.assertEqual(path.read_bytes(), b'sentinel')

    def test_read_only_handles_reject_write_and_out_of_range_values(self):
        path = self.root / 'safe.bin'
        path.write_bytes(b'sentinel')
        frames = self.frame(1, 'open', path=str(path), write=False)
        frames += self.frame(2, 'write', b'x', handle='1', offset=0, length=1)
        frames += self.frame(3, 'read', handle='1', offset=-1, length=1)
        frames += self.frame(4, 'read', handle='1', offset=True, length=1)
        frames += self.frame(5, 'read', handle='1', offset=0, length=1048577)
        frames += self.frame(6, 'read', handle='1', offset=0, length=8)
        replies = self.replies(frames)
        self.assertTrue(all('error' in reply for reply, _ in replies[1:5]))
        self.assertEqual(replies[-1][1], b'sentinel')

    def test_symlink_fifo_directory_missing_and_relative_paths_are_rejected(self):
        path = self.root / 'original'
        path.write_bytes(b'original')
        (self.root / 'link').symlink_to(path)
        os.mkfifo(self.root / 'fifo')
        frames = b''.join(self.frame(index + 1, 'open', path=str(name), write=False) for index, name in enumerate([
            self.root / 'link', self.root / 'fifo', self.root, self.root / 'missing', 'relative',
        ]))
        self.assertTrue(all('error' in reply for reply, _ in self.replies(frames)))
        self.assertEqual(path.read_bytes(), b'original')

    def test_bad_namespace_has_no_success_greeting(self):
        code, output, _ = self.run_worker(b'', home='/not-the-sftp-home')
        self.assertNotEqual(code, 0)
        self.assertFalse(output.startswith(MAGIC))

    def test_malformed_frames_and_short_bodies_terminate_instead_of_hanging(self):
        for frames in [b'x' * 16385, b'{bad json}\n', b'{"id":1,"size":1048577}\n', b'{"id":1,"size":3}\nx']:
            code, output, _ = self.run_worker(frames)
            self.assertNotEqual(code, 0)
            self.assertTrue(output.startswith(MAGIC))

    def test_handle_limit_and_close_allow_reuse_without_truncation(self):
        path = self.root / 'safe.bin'
        path.write_bytes(b'sentinel')
        frames = b''.join(self.frame(index + 1, 'open', path=str(path), write=False) for index in range(33))
        frames += self.frame(34, 'close', handle='1')
        frames += self.frame(35, 'open', path=str(path), write=False)
        replies = self.replies(frames)
        self.assertIn('error', replies[32][0])
        self.assertNotIn('error', replies[34][0])
        self.assertEqual(path.read_bytes(), b'sentinel')


if __name__ == '__main__':
    unittest.main()
