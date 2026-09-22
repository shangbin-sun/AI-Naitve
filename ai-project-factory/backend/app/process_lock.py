"""Cross-platform non-blocking file locks used by one run scheduler."""
import contextlib
import os
from pathlib import Path


class NonBlockingFileLock:
    """An exclusive, non-blocking lock backed by the scheduler lock file."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.file = None

    def acquire(self):
        # Keep one byte available for msvcrt.locking, which locks a byte range.
        self.file = self.path.open('a+b')
        if os.name == 'nt':
            import msvcrt
            self.file.seek(0, os.SEEK_END)
            if self.file.tell() == 0:
                self.file.write(b'\0')
                self.file.flush()
            self.file.seek(0)
            try:
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                self.file.close()
                self.file = None
                raise BlockingIOError from exc
        else:
            import fcntl
            try:
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.file.close()
                self.file = None
                raise
        return self

    def close(self):
        if self.file is None:
            return
        try:
            if os.name == 'nt':
                import msvcrt
                self.file.seek(0)
                with contextlib.suppress(OSError):
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_UN)
        finally:
            self.file.close()
            self.file = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, exc_type, exc, tb):
        self.close()
