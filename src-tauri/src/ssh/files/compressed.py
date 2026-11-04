# Ephemeral SSH stdio worker. No files are installed and no service is started.
import json
import os
import stat
import sys
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
            if op == 'open':
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
        except (OSError, ValueError, KeyError, TypeError, zlib.error) as error:
            reply(request_id, error=str(error)[:512])
finally:
    for fd, writing in handles.values():
        os.close(fd)
