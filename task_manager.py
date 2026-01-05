import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Dict, Optional, Union


class TaskStatus:
    """Thread-safe container used to track background task progress."""

    def __init__(self, task_type: str):
        self.id = str(uuid.uuid4())
        self.type = task_type
        self.state = "pending"  # pending | running | finished | failed
        self.progress = 0
        self.message = ""
        self.result = None
        self.error = None
        self.started_at = datetime.utcnow()
        self.finished_at = None
        self._lock = threading.Lock()

    def set_state(self, state: str, message: Optional[str] = None):
        with self._lock:
            self.state = state
            if message is not None:
                self.message = message
            if state in ("finished", "failed"):
                self.finished_at = datetime.utcnow()

    def set_progress(self, progress: float, message: Optional[str] = None):
        with self._lock:
            # Clamp progress between 0 and 100
            self.progress = max(0, min(100, float(progress)))
            if message is not None:
                self.message = message

    def set_result(self, result):
        with self._lock:
            self.result = result

    def fail(self, error: Union[Exception, str]):
        with self._lock:
            self.state = "failed"
            self.error = str(error)
            self.finished_at = datetime.utcnow()

    def to_dict(self, include_result: bool = False):
        data = {
            "task_id": self.id,
            "type": self.type,
            "state": self.state,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
        }
        if include_result and self.result is not None:
            data["result"] = self.result
        return data


class TaskManager:
    """Simple background task manager backed by a thread pool."""

    def __init__(self, max_workers: int = 2):
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.tasks: Dict[str, TaskStatus] = {}
        self.last_by_type: Dict[str, str] = {}
        self._lock = threading.Lock()

    def submit(self, task_type: str, fn, *args, **kwargs) -> TaskStatus:
        status = TaskStatus(task_type)
        with self._lock:
            self.tasks[status.id] = status
            self.last_by_type[task_type] = status.id

        def _runner():
            try:
                status.set_state("running")
                fn(status, *args, **kwargs)
                if status.state != "failed":
                    status.set_progress(100)
                    status.set_state("finished")
            except Exception as exc:  # noqa: BLE001
                status.fail(exc)

        self.executor.submit(_runner)
        return status

    def get(self, task_id: str) -> Optional[TaskStatus]:
        return self.tasks.get(task_id)

    def get_last(self, task_type: str) -> Optional[TaskStatus]:
        with self._lock:
            last_id = self.last_by_type.get(task_type)
        if last_id:
            return self.tasks.get(last_id)
        return None


# Global manager instance
task_manager = TaskManager()
