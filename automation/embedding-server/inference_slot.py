"""Bound CPU inference to one active request per model process, without a queue."""
from contextlib import contextmanager
from threading import Lock


class InferenceBusy(RuntimeError):
    pass


class InferenceSlot:
    def __init__(self):
        self._lock = Lock()

    @property
    def busy(self):
        return self._lock.locked()

    @contextmanager
    def reserve(self):
        if not self._lock.acquire(blocking=False):
            raise InferenceBusy('An inference request is already running')
        try:
            yield
        finally:
            self._lock.release()
