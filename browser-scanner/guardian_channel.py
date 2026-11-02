"""Bounded private IPC transport shared by the guardian and transport probes."""
import json


class Channel:
    def __init__(self, sock):
        self.socket = sock
        self.socket.settimeout(1)

    def fileno(self):
        return self.socket.fileno()

    def recv(self, size):
        return self.socket.recv(size)

    def close(self):
        self.socket.close()

    def send(self, value):
        data = json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode() + b'\n'
        if len(data) > 32 * 1024 * 1024:
            raise ValueError()
        try:
            self.socket.sendall(data)
        except BaseException:
            # A prefix may already be on the wire. Never append a second JSON
            # frame to an uncertain prefix; EOF makes missing proof fail closed.
            self.close()
            raise
