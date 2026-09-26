"""Runs untrusted bots in separate, resource-limited processes.

SandboxBot has the same act() interface as BotRunner, so run_match() doesn't care
which one it gets. Per bot process:
  - static check + restricted builtins (see botapi.check_source)
  - Windows: a Job Object caps memory, forbids child processes and kills the
    process if we go away. Linux: rlimits on memory, processes, file writes and CPU.
  - every move has a deadline; a bot that misses it is killed and restarted
    (losing its memory), up to max_timeouts_per_match times.
"""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading

from .config import Config

WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sandbox_worker.py")
# A venv's python.exe on Windows is a launcher that spawns the real interpreter as a
# child, which the job object forbids. The worker only needs the stdlib anyway.
PYTHON = getattr(sys, "_base_executable", None) or sys.executable
MAX_REPLY_BYTES = 64_000

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
    _k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
    _k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    _k32.CloseHandle.argtypes = (wintypes.HANDLE,)

    class _IoCounters(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD)]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimits), ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    _LIMIT_ACTIVE_PROCESS = 0x8
    _LIMIT_PROCESS_MEMORY = 0x100
    _LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400
    _LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    _JobObjectExtendedLimitInformation = 9

    def _confine(proc, memory_mb):
        job = _k32.CreateJobObjectW(None, None)
        if not job:
            raise OSError(ctypes.get_last_error(), "CreateJobObject failed")
        info = _ExtendedLimits()
        info.BasicLimitInformation.LimitFlags = (
            _LIMIT_ACTIVE_PROCESS | _LIMIT_PROCESS_MEMORY
            | _LIMIT_DIE_ON_UNHANDLED_EXCEPTION | _LIMIT_KILL_ON_JOB_CLOSE)
        info.BasicLimitInformation.ActiveProcessLimit = 1
        info.ProcessMemoryLimit = memory_mb * 1024 * 1024
        ok = _k32.SetInformationJobObject(job, _JobObjectExtendedLimitInformation,
                                          ctypes.byref(info), ctypes.sizeof(info))
        ok = ok and _k32.AssignProcessToJobObject(job, int(proc._handle))
        if not ok:
            err = ctypes.get_last_error()
            _k32.CloseHandle(job)
            raise OSError(err, "could not put the bot process in a job object")
        return job

    def _release(job):
        if job:
            _k32.CloseHandle(job)

    _POPEN_EXTRA = {"creationflags": subprocess.CREATE_NO_WINDOW}
else:
    # Linux (e.g. WSL). Limits are applied with prlimit() right after the process starts,
    # before any bot code is sent; preexec_fn isn't safe in a threaded server.
    # RLIMIT_NPROC=0 stops fork/threads, but root ignores it: don't run the server as root.
    import resource
    import warnings

    if hasattr(os, "geteuid") and os.geteuid() == 0:
        warnings.warn("running as root: bot processes can start other processes; use a normal user")

    def _confine(proc, memory_mb):
        if not hasattr(resource, "prlimit"):  # macOS: no prlimit, dev use only
            return None
        mem = memory_mb * 1024 * 1024
        for limit, value in ((resource.RLIMIT_AS, mem), (resource.RLIMIT_NPROC, 0),
                             (resource.RLIMIT_FSIZE, 0), (resource.RLIMIT_CPU, 600)):
            resource.prlimit(proc.pid, limit, (value, value))
        return None

    def _release(job):
        pass

    _POPEN_EXTRA = {"process_group": 0}


def _worker_env():
    env = {"PYTHONHASHSEED": "0"}
    if os.name == "nt":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")
    return env


class _Worker:
    """One bot process plus a thread that reads its replies."""

    def __init__(self, memory_mb):
        self.cwd = tempfile.mkdtemp(prefix="bot_")
        self.proc = subprocess.Popen(
            # No site packages, no script dir on sys.path, and an environment we fully control.
            # (Not -I: it would ignore PYTHONHASHSEED, and a fixed hash seed keeps set
            # iteration order, and so the bot's choices, the same on every run.)
            [PYTHON, "-s", "-S", "-P", "-X", "utf8", WORKER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=self.cwd, env=_worker_env(), bufsize=0, **_POPEN_EXTRA,
        )
        try:
            self.job = _confine(self.proc, memory_mb)
        except OSError:
            self.proc.kill()
            raise
        self.replies = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            if len(line) > MAX_REPLY_BYTES:
                break
            self.replies.put(line)
        self.replies.put(None)  # process ended

    def request(self, msg, timeout_s):
        """Returns the reply dict, "timeout", or "dead"."""
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode())
            self.proc.stdin.flush()
        except OSError:
            return "dead"
        try:
            line = self.replies.get(timeout=timeout_s)
        except queue.Empty:
            return "timeout"
        if line is None:
            return "dead"
        try:
            return json.loads(line)
        except ValueError:
            return "dead"

    def kill(self):
        try:
            self.proc.kill()
        except OSError:
            pass
        self.proc.wait()
        for pipe in (self.proc.stdin, self.proc.stdout):
            try:
                pipe.close()
            except OSError:
                pass
        _release(self.job)
        self.job = None
        try:
            os.rmdir(self.cwd)
        except OSError:
            pass


class SandboxBot:
    """A bot running in its own process. Use as a context manager, or call close()."""

    def __init__(self, source: str, cfg: Config, filename: str = "bot.py"):
        self.source = source
        self.filename = filename
        self.cfg = cfg
        self.worker = None
        self.load_error = None
        self.load_output = ""
        self.new_match()

    def new_match(self):
        """Fresh namespace and memory, reusing the process when possible."""
        self.timeouts = 0
        self.gave_up = None
        self._load()

    def _load(self):
        if self.worker is None:
            self.worker = _Worker(self.cfg.memory_limit_mb)
        reply = self.worker.request(
            {"cmd": "load", "source": self.source, "filename": self.filename,
             "print_limit": self.cfg.print_chars_per_turn},
            self.cfg.load_timeout_ms / 1000,
        )
        if isinstance(reply, dict):
            self.load_error, self.load_output = reply["error"], reply["output"]
        else:
            self._kill()
            self.load_error = ("your code took too long to start" if reply == "timeout"
                               else "your code crashed while starting (too much memory?)")

    def act(self, me, opp, turn, seed):
        if self.load_error:
            return {"move": None, "output": "", "error": self.load_error}
        if self.gave_up:
            return {"move": None, "output": "", "error": self.gave_up}
        if self.worker is None:  # restart after a timeout or crash
            self._load()
            if self.load_error:
                return {"move": None, "output": "", "error": self.load_error}

        reply = self.worker.request({"cmd": "act", "me": me, "opp": opp, "turn": turn, "seed": seed},
                                    self.cfg.move_timeout_ms / 1000)
        if isinstance(reply, dict):
            return reply

        self._kill()
        self.timeouts += 1
        if reply == "timeout":
            error = f"took longer than {self.cfg.move_timeout_ms} ms, so it was stopped (infinite loop?)"
        else:
            error = "your code crashed the bot process (too much memory?)"
        if self.timeouts >= self.cfg.max_timeouts_per_match:
            self.gave_up = f"stopped for the rest of the match after {self.timeouts} crashes/timeouts"
            error += f"; {self.gave_up}"
        else:
            error += "; restarted, so memory was reset"
        return {"move": None, "output": "", "error": error}

    def _kill(self):
        if self.worker:
            self.worker.kill()
            self.worker = None

    def close(self):
        self._kill()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
