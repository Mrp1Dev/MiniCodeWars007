"""The bot side of the engine: loads a participant's script and calls its play().

This module imports nothing from the rest of the engine, so it can be shipped on its
own into a sandbox process or into Pyodide in the browser.

A bot is a script that defines:

    def play(me, opp, turn, memory):
        return RELOAD   # or SHIELD, SHOOT, SNIPE, COUNTER

  me.hp, me.ammo, me.shields, me.history
  opp.hp, opp.ammo, opp.history        (opponent's shield charges are hidden)
  turn    1, 2, 3, ...
  memory  a dict that is kept between turns of the same match
"""
import ast
import builtins
import inspect
import io
import random
import traceback
import types

RELOAD, SHIELD, SHOOT, SNIPE, COUNTER = "RELOAD", "SHIELD", "SHOOT", "SNIPE", "COUNTER"
MOVES = (RELOAD, SHIELD, SHOOT, SNIPE, COUNTER)

# --- Safety rules for untrusted code -------------------------------------------------
# Layer 1 is a static check of the source; layer 2 is a restricted set of builtins at run
# time. Neither is a perfect Python sandbox on its own, which is why sandboxed bots also
# run in a separate, resource-limited process that gets killed on timeout.
# Don't add "statistics" here: it exposes the sys module as statistics.sys.

MAX_SOURCE_CHARS = 20_000
ALLOWED_MODULES = frozenset({"random", "math", "collections", "itertools", "functools"})
BANNED_NAMES = frozenset({
    "eval", "exec", "compile", "open", "input", "breakpoint", "globals", "locals", "vars",
    "getattr", "setattr", "delattr", "help", "exit", "quit", "memoryview", "__import__",
    "__builtins__", "__loader__", "__spec__", "__build_class__",
})
ALLOWED_DUNDERS = frozenset({"__init__", "__name__"})
# Frame and code internals reach other code's globals without any underscores.
BANNED_ATTRS = frozenset({
    "gi_frame", "gi_code", "gi_yieldfrom", "cr_frame", "cr_code", "cr_await",
    "ag_frame", "ag_code", "ag_await", "f_back", "f_globals", "f_locals", "f_builtins",
    "f_code", "tb_frame", "tb_next", "co_code",
})


def check_source(source: str):
    """Returns a list of problems as {"line", "message"}; empty means the code may run."""
    if len(source) > MAX_SOURCE_CHARS:
        return [{"line": None, "message": f"code is too long ({len(source)} characters, max {MAX_SOURCE_CHARS})"}]
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [{"line": e.lineno, "message": f"SyntaxError: {e.msg}"}]

    problems = []

    def bad(node, msg):
        problems.append({"line": getattr(node, "lineno", None), "message": msg})

    allowed = ", ".join(sorted(ALLOWED_MODULES))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_MODULES:
                    bad(node, f"can't import {alias.name!r} (allowed: {allowed})")
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "").split(".")[0] not in ALLOWED_MODULES:
                bad(node, f"can't import from {node.module!r} (allowed: {allowed})")
            for alias in node.names:
                if alias.name.startswith("_"):
                    bad(node, f"can't import {alias.name!r}")
        elif isinstance(node, ast.Name):
            if node.id in BANNED_NAMES:
                bad(node, f"{node.id!r} is not allowed")
            elif node.id.startswith("__") and node.id not in ALLOWED_DUNDERS:
                bad(node, f"{node.id!r} is not allowed")
        elif isinstance(node, ast.Attribute):
            if node.attr in BANNED_ATTRS or (node.attr.startswith("_") and node.attr not in ALLOWED_DUNDERS):
                bad(node, f"'.{node.attr}' is not allowed (names starting with _ are off limits)")
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                if name.startswith("__"):
                    bad(node, f"{name!r} is not allowed")

    if not problems and not any(isinstance(n, ast.FunctionDef) and n.name == "play" for n in tree.body):
        bad(tree, "your code needs a function named play(me, opp, turn, memory)")
    return problems


def safe_builtins():
    safe = {k: v for k, v in vars(builtins).items() if k not in BANNED_NAMES}
    safe["__build_class__"] = builtins.__build_class__  # `class` statements need it
    return safe


def _private_random(rng):
    """A stand-in for the random module whose functions all use the bot's own RNG."""
    mod = types.ModuleType("random")
    for name in random.__all__:
        setattr(mod, name, getattr(rng, name, getattr(random, name)))
    return mod


class View:
    """Read-only-ish player info. Supports both me.ammo and me["ammo"]."""

    def __init__(self, label, data):
        self.__dict__.update(data)
        object.__setattr__(self, "_label", label)

    def __getattr__(self, key):  # only called for missing attributes
        fields = ", ".join(k for k in self.__dict__ if k != "_label")
        raise AttributeError(f"{self._label} has no {key!r} (it has: {fields})")

    def __getitem__(self, key):
        return getattr(self, key)

    def __repr__(self):
        return "(" + ", ".join(f"{k}={v!r}" for k, v in self.__dict__.items() if k != "_label") + ")"


class BotError(Exception):
    pass


class _Capped(io.StringIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit

    def write(self, s):
        room = self.limit - self.tell()
        if room > 0:
            super().write(s[:room])
        return len(s)


def _explain(exc, filename):
    """One friendly line: which line of *their* code failed and why."""
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == filename]
    where = f"line {frames[-1].lineno}: " if frames else ""
    if isinstance(exc, SyntaxError) and exc.lineno:
        where = f"line {exc.lineno}: "
    return f"{where}{type(exc).__name__}: {exc}"


class BotRunner:
    """Holds one loaded bot for one match (memory lives here).

    Each bot gets its own builtins: print() writes to the bot's own buffer and
    `import random` gives a private, seeded RNG, so several bots can run in threads
    of one process without touching sys.stdout or the global random state.
    safe=True adds the static check, banned builtins and the import allowlist.
    """

    def __init__(self, source: str, filename: str = "bot.py", print_limit: int = 500, safe: bool = False):
        self.filename = filename
        self.print_limit = print_limit
        self.safe = safe
        self.memory = {}
        self.play = None
        self.load_error = None
        self.load_output = ""
        self.rng = random.Random()
        self.random_module = _private_random(self.rng)
        self._out = _Capped(print_limit)
        if safe:
            problems = check_source(source)
            if problems:
                p = problems[0]
                self.load_error = (f"line {p['line']}: " if p["line"] else "") + p["message"]
                return
        bot_builtins = safe_builtins() if safe else dict(vars(builtins))
        bot_builtins["__import__"] = self._import
        bot_builtins["print"] = self._print
        namespace = {"__name__": "bot", "__builtins__": bot_builtins, **{m: m for m in MOVES}, "MOVES": MOVES}
        try:
            code = compile(source, filename, "exec")
            exec(code, namespace)
            play = namespace.get("play")
            if not callable(play):
                raise BotError("your code has no play(me, opp, turn, memory) function")
            self.play = play
            self.nargs = self._count_args(play)
        except Exception as e:
            self.load_error = _explain(e, filename)
        self.load_output = self._out.getvalue()

    def _import(self, name, globals=None, locals=None, fromlist=(), level=0):
        if self.safe and (level or name.split(".")[0] not in ALLOWED_MODULES):
            raise ImportError(f"can't import {name!r} (allowed: {', '.join(sorted(ALLOWED_MODULES))})")
        if name == "random" and not level:
            return self.random_module
        return __import__(name, globals, locals, fromlist, level)

    def _print(self, *args, sep=" ", end="\n", file=None, flush=False):
        sep = " " if sep is None else sep
        self._out.write(sep.join(map(str, args)) + ("\n" if end is None else end))

    @staticmethod
    def _count_args(fn):
        # Lets bots written as play(me, opp) or play(me, opp, turn) still work.
        try:
            params = inspect.signature(fn).parameters.values()
        except (TypeError, ValueError):
            return 4
        if any(p.kind == p.VAR_POSITIONAL for p in params):
            return 4
        return min(4, sum(p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) for p in params))

    def act(self, me: dict, opp: dict, turn: int, seed: str):
        """Returns {"move", "output", "error"}. Never raises."""
        if self.load_error:
            return {"move": None, "output": "", "error": self.load_error}
        self.rng.seed(seed)
        args = (View("me", me), View("opp", opp), turn, self.memory)[: self.nargs]
        self._out = _Capped(self.print_limit)
        move, error = None, None
        try:
            move = self.play(*args)
        except Exception as e:
            error = _explain(e, self.filename)
        return {"move": move if isinstance(move, (str, type(None))) else repr(move),
                "output": self._out.getvalue(), "error": error}
