import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Dict, Optional, Union


# États d'une tâche encore susceptible de toucher à ses fichiers de travail.
ACTIVE_STATES = ("pending", "running")


class TaskAlreadyRunning(Exception):
    """Levée par submit(exclusive=True) quand une tâche du même type est déjà active."""

    def __init__(self, status: "TaskStatus"):
        super().__init__(f"Une tâche '{status.type}' est déjà en cours")
        self.status = status


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

    def __init__(self, max_workers: int = 2, task_ttl_seconds: int = 900):
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.tasks: Dict[str, TaskStatus] = {}
        self.last_by_type: Dict[str, str] = {}
        self._lock = threading.Lock()
        self.task_ttl_seconds = task_ttl_seconds  # 15 minutes par défaut

    def submit(self, task_type: str, fn, *args, exclusive: bool = False, **kwargs) -> TaskStatus:
        """Soumet une tâche de fond.

        `exclusive=True` refuse la soumission (TaskAlreadyRunning) si une tâche du
        même type est encore active. Le contrôle est fait sous le verrou, en même
        temps que l'enregistrement : deux requêtes simultanées ne peuvent pas
        passer toutes les deux le test avant que l'une ne s'enregistre.
        Note : `exclusive` est réservé (keyword-only) et n'est pas transmis à `fn`.
        """
        status = TaskStatus(task_type)
        with self._lock:
            if exclusive:
                running = self._active_locked(task_type)
                if running is not None:
                    raise TaskAlreadyRunning(running)
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
        
        # Purger les anciennes tâches après chaque soumission
        self.purge_old_tasks()
        
        return status

    def get(self, task_id: str) -> Optional[TaskStatus]:
        return self.tasks.get(task_id)

    def get_last(self, task_type: str) -> Optional[TaskStatus]:
        with self._lock:
            last_id = self.last_by_type.get(task_type)
        if last_id:
            return self.tasks.get(last_id)
        return None

    def _active_locked(self, task_type: str) -> Optional[TaskStatus]:
        """Tâche active de ce type, ou None. À appeler avec self._lock déjà tenu."""
        last_id = self.last_by_type.get(task_type)
        status = self.tasks.get(last_id) if last_id else None
        if status is not None and status.state in ACTIVE_STATES:
            return status
        return None

    def get_active(self, task_type: str) -> Optional[TaskStatus]:
        """Tâche de ce type encore en attente ou en cours d'exécution, sinon None.

        Sert aux routes qui doivent refuser une opération conflictuelle (ex. vider
        `captured/` pendant qu'un assemblage y lit les images).
        """
        with self._lock:
            return self._active_locked(task_type)

    def active_tasks(self) -> list:
        """Toutes les tâches encore en attente ou en cours (tous types confondus).

        Le lanceur s'en sert pour avertir avant de quitter pendant un import ou
        un encodage vidéo.
        """
        with self._lock:
            return [s for s in self.tasks.values() if s.state in ACTIVE_STATES]

    def purge_old_tasks(self) -> int:
        """Supprime les tâches terminées/échouées au-delà du TTL. Retourne le nombre de tâches purgées."""
        now = datetime.utcnow()
        purged = 0
        with self._lock:
            to_remove = []
            for task_id, status in self.tasks.items():
                if status.state in ("finished", "failed") and status.finished_at:
                    age_seconds = (now - status.finished_at).total_seconds()
                    if age_seconds > self.task_ttl_seconds:
                        to_remove.append(task_id)
            
            for task_id in to_remove:
                del self.tasks[task_id]
                purged += 1
                # Nettoyer last_by_type si nécessaire
                for task_type, last_id in list(self.last_by_type.items()):
                    if last_id == task_id:
                        del self.last_by_type[task_type]
        
        if purged > 0:
            print(f"[TASK_MANAGER] Purged {purged} old task(s)")
        return purged


# Global manager instance
task_manager = TaskManager()
