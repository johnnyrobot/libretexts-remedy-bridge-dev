"""Private Linux job owner. Never reap a child before signaling its identity.

Subreaper adoption is kernel provenance even after fork/setsid/parent exit.
Only ECHILD after termination certifies that this job has no descendants.
The parent channel is closed before worker exec; worker data cannot forge proof.
"""
import ctypes
import errno
import json
import os
import select
import signal
import socket
import sys
import time

MAX_FRAME = 32 * 1024 * 1024
cleanup_deadline = None
parent = socket.socket(fileno=int(os.environ['NODE_CHANNEL_FD']))
parent.settimeout(1)
worker_socket = None
worker = None
buffers = {}


def send(channel, value):
    data = json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode() + b'\n'
    if len(data) > MAX_FRAME:
        raise ValueError()
    channel.sendall(data)


def children():
    # This guardian has one thread and creates exactly one worker. It never
    # installs an automatic SIGCHLD reaper or creates unrelated children.
    with open('/proc/self/task/' + str(os.getpid()) + '/children') as handle:
        values = [int(value) for value in handle.read(65537).split()]
    if len(values) > 4096 or any(value <= 1 or value == os.getpid() for value in values):
        raise ValueError()
    return values


def terminate():
    global cleanup_deadline
    if cleanup_deadline is None:
        cleanup_deadline = time.monotonic() + 2
    deadline = cleanup_deadline
    reaped = 0
    while time.monotonic() < deadline:
        # Each PID is our direct/adopted child. With no concurrent wait/reaper,
        # exit leaves a zombie, so the PID cannot be recycled before signaling.
        current = children()
        for pid in current:
            os.kill(pid, signal.SIGSTOP)
        for pid in current:
            os.kill(pid, signal.SIGKILL)
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return reaped  # Kernel ECHILD, not an empty /proc guess.
            if pid == 0:
                break
            reaped += 1
        time.sleep(.005)
    raise TimeoutError()


def frames(channel):
    data = channel.recv(65536)
    if not data:
        return None
    buffer = buffers.get(channel, b'') + data
    limit = 16384 if channel is parent else 16 * 1024 * 1024 + 1
    if len(buffer) > limit:
        raise ValueError()
    lines = buffer.split(b'\n')
    buffers[channel] = lines.pop()
    return [json.loads(line) for line in lines if line]


verified = False
reason = 'bootstrap_failed'
try:
    lib = ctypes.CDLL(None, use_errno=True)
    flag = ctypes.c_int()
    if lib.prctl(38, 1, 0, 0, 0) != 0 or lib.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError()
    if lib.prctl(37, ctypes.byref(flag), 0, 0, 0) != 0 or flag.value != 1:
        raise OSError()
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    worker_socket, child_socket = socket.socketpair()
    worker = os.fork()
    if worker == 0:
        parent.close()
        worker_socket.close()
        os.set_inheritable(child_socket.fileno(), True)
        env = dict(os.environ, NODE_CHANNEL_FD=str(child_socket.fileno()), NODE_CHANNEL_SERIALIZATION_MODE='json')
        os.execve(sys.argv[1], [sys.argv[1], '--max-old-space-size=384', sys.argv[2]], env)
    child_socket.close()
    worker_socket.settimeout(1)
    reason = 'message_failed'
    cancelled = False
    job_deadline = time.monotonic() + max(0, min(120000, float(sys.argv[3]))) / 1000
    while not cancelled:
        if time.monotonic() >= job_deadline:
            cancelled = True
            break
        ready, _, _ = select.select([parent, worker_socket], [], [], .02)
        for channel in ready:
            values = frames(channel)
            if values is None:
                cancelled = True
                if channel is parent:
                    reason = 'parent_lost'
                break
            for value in values:
                if channel is worker_socket:
                    send(parent, {'kind': 'worker', 'value': value})
                elif value.get('op') == 'cancel':
                    cancelled = True
                    break
                elif value.get('op') == 'forward' and isinstance(value.get('value'), dict):
                    send(worker_socket, value['value'])
                else:
                    raise ValueError()
        # Observe death without reaping: keep its PID identity leased and allow
        # the kernel to adopt every surviving orphan before terminal proof.
        if os.waitid(os.P_PID, worker, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
            cancelled = True
    reason = 'reap_unproved'
    reaped = terminate()
    verified = True
    send(parent, {'kind': 'terminal', 'verified': True, 'reaped': reaped})
except BaseException:
    # Best effort cannot certify success after an earlier bootstrap/channel or
    # ownership error. The parent must retain the exact root and admission.
    try:
        terminate()
    except BaseException:
        pass
    try:
        send(parent, {'kind': 'terminal', 'verified': False, 'reason': reason})
    except BaseException:
        pass
finally:
    if worker_socket is not None:
        worker_socket.close()
    parent.close()
sys.exit(0 if verified else 1)
