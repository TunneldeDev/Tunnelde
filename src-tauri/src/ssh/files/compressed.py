# Ephemeral SSH stdio worker. No files are installed and no service is started.
import io
import json
import os
import stat
import sys
import tarfile
import zlib

LIMIT = 1024 * 1024
source = sys.stdin.buffer
target = sys.stdout.buffer
handles = {}
next_handle = 1
if not all(hasattr(os, name) for name in ('pread', 'pwrite', 'O_NOFOLLOW', 'O_NONBLOCK')):
    raise SystemExit('unsupported file operations')
if len(sys.argv) != 2 or os.path.realpath(os.getcwd()) != sys.argv[1]:
    raise SystemExit('SFTP and exec filesystem views differ')

def exact(length):
    data = bytearray()
    while len(data) < length:
        chunk = source.read(length - len(data))
        if not chunk:
            raise EOFError()
        data.extend(chunk)
    return bytes(data)

def packed(data):
    if len(data) < 4096:
        return data, False
    sample = data[:16384]
    if len(zlib.compress(sample, 1)) * 10 >= len(sample) * 9:
        return data, False
    compressed = zlib.compress(data, 1)
    return (compressed, True) if len(compressed) * 10 < len(data) * 9 else (data, False)

def reply(request_id, payload=b'', **fields):
    fields.update(id=request_id, size=len(payload))
    target.write(json.dumps(fields, separators=(',', ':')).encode() + b'\n')
    target.write(payload)
    target.flush()

def archive_entries(request):
    entries = request['entries']
    if not isinstance(entries, list) or not 1 <= len(entries) <= 8:
        raise ValueError('invalid archive entries')
    paths = set()
    for entry in entries:
        name, length = entry['path'], entry['length']
        if (not isinstance(name, str) or not os.path.isabs(name) or '\0' in name
                or name in paths or type(length) is not int or not 0 <= length <= 65536):
            raise ValueError('invalid archive entry')
        paths.add(name)
    return entries

def unpack(payload, length, compressed):
    if type(length) is not int or not 0 < length <= LIMIT:
        raise ValueError('invalid archive size')
    if compressed:
        decoder = zlib.decompressobj()
        payload = decoder.decompress(payload, length + 1)
        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise ValueError('invalid compressed archive')
    if len(payload) != length:
        raise ValueError('invalid archive length')
    return payload

def archive_read(request):
    entries = archive_entries(request)
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for index, entry in enumerate(entries):
            fd = os.open(entry['path'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_size != entry['length']:
                    raise ValueError('source changed')
                data = bytearray()
                while len(data) < before.st_size:
                    chunk = os.pread(fd, before.st_size - len(data), len(data))
                    if not chunk:
                        raise ValueError('source changed')
                    data.extend(chunk)
                after = os.fstat(fd)
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise ValueError('source changed')
            finally:
                os.close(fd)
            info = tarfile.TarInfo(str(index))
            info.size = len(data)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(data))
    data = output.getvalue()
    if len(data) > LIMIT:
        raise ValueError('archive too large')
    payload, compressed = packed(data) if request.get('compression') is True else (data, False)
    return payload, len(data), compressed

def archive_write(request, payload):
    entries = archive_entries(request)
    payload = unpack(payload, request['length'], request.get('compressed') is True)
    files = []
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
        for index, entry in enumerate(entries):
            info = archive.next()
            if (info is None or not info.isfile() or info.name != str(index)
                    or info.size != entry['length'] or info.pax_headers):
                raise ValueError('invalid archive member')
            data = archive.extractfile(info).read(65537)
            if len(data) != entry['length']:
                raise ValueError('invalid archive member length')
            files.append(data)
        if archive.next() is not None:
            raise ValueError('unexpected archive member')
    opened = []
    try:
        # Every target must be an existing, empty regular staging object.
        # Validate all of them before writing any data. No mkdir, create,
        # truncate, final rename or filesystem extraction is permitted here.
        for entry in entries:
            fd = os.open(entry['path'], os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            opened.append(fd)
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != 0 or metadata.st_nlink != 1:
                raise ValueError('invalid staging file')
        for fd, data in zip(opened, files):
            written = 0
            while written < len(data):
                count = os.pwrite(fd, data[written:], written)
                if count <= 0:
                    raise OSError('short archive write')
                written += count
    finally:
        for fd in opened:
            os.close(fd)

target.write(b'TUNNELDE-COMPRESSED-1\n')
target.flush()
try:
    while True:
        line = source.readline(16385)
        if not line:
            break
        if len(line) > 16384 or not line.endswith(b'\n'):
            raise ValueError('invalid control frame')
        request = json.loads(line)
        request_id = request['id']
        if type(request_id) is not int or not 0 < request_id < 2**64:
            raise ValueError('invalid request id')
        size = request.get('size', 0)
        if type(size) is not int or not 0 <= size <= LIMIT:
            raise ValueError('invalid payload size')
        payload = exact(size)
        try:
            op = request['op']
            if op == 'archive_read':
                if size:
                    raise ValueError('unexpected archive read payload')
                payload, length, compressed = archive_read(request)
                reply(request_id, payload, length=length, compressed=compressed)
            elif op == 'archive_write':
                archive_write(request, payload)
                reply(request_id)
            elif op == 'mkdir_private':
                name = request['path']
                if size or not isinstance(name, str) or not os.path.isabs(name):
                    raise ValueError('invalid private directory')
                # Do not adopt existing paths or chmod them. The host validates
                # mode/type/emptiness before acknowledging its durable journal.
                os.mkdir(name, 0o700)
                reply(request_id)
            elif op == 'open':
                if size:
                    raise ValueError('unexpected open payload')
                name = request['path']
                if not isinstance(name, str) or not os.path.isabs(name) or len(handles) >= 32:
                    raise ValueError('invalid open')
                writing = request.get('write') is True
                flags = os.O_WRONLY if writing else os.O_RDONLY
                flags |= os.O_NOFOLLOW | os.O_NONBLOCK
                fd = os.open(name, flags)
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    os.close(fd)
                    raise ValueError('not a regular file')
                handle = str(next_handle)
                next_handle += 1
                handles[handle] = (fd, writing)
                reply(request_id, handle=handle)
            elif op == 'close':
                if size:
                    raise ValueError('unexpected close payload')
                fd, writing = handles.pop(request['handle'])
                os.close(fd)
                reply(request_id)
            else:
                fd, writing = handles[request['handle']]
                offset = request['offset']
                length = request['length']
                if type(offset) is not int or not 0 <= offset <= 2**63 - LIMIT or type(length) is not int or not 0 < length <= LIMIT:
                    raise ValueError('invalid range')
                if op == 'read' and not writing and size == 0:
                    data = os.pread(fd, length, offset)
                    payload, compressed = packed(data)
                    reply(request_id, payload, length=len(data), compressed=compressed)
                elif op == 'write' and writing:
                    if request.get('compressed') is True:
                        decoder = zlib.decompressobj()
                        data = decoder.decompress(payload, length + 1)
                        if len(data) != length or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                            raise ValueError('invalid compressed payload')
                    else:
                        data = payload
                    if len(data) != length:
                        raise ValueError('invalid write length')
                    written = 0
                    while written < length:
                        count = os.pwrite(fd, data[written:], offset + written)
                        if count <= 0:
                            raise OSError('short write')
                        written += count
                    reply(request_id)
                else:
                    raise ValueError('invalid operation')
        except (OSError, ValueError, KeyError, TypeError, zlib.error, tarfile.TarError) as error:
            reply(request_id, error=str(error)[:512])
finally:
    for fd, writing in handles.values():
        os.close(fd)
