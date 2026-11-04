"""Exercise the actual ephemeral worker, including its filesystem boundaries."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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
