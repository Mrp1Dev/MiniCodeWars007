"""Loads and validates the game rules from config.toml."""
import tomllib
from dataclasses import dataclass
from pathlib import Path

ACTIONS = ("RELOAD", "SHIELD", "SHOOT", "SNIPE", "COUNTER")
DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config.toml"

_GAME_KEYS = {"start_hp", "start_ammo", "max_ammo", "max_rounds", "shield_charges"}
_ACTION_KEYS = {"cost", "damage", "ammo_gain", "blocked_by", "reflected_by"}
_LIMIT_DEFAULTS = {
    "move_timeout_ms": 100,
    "load_timeout_ms": 3000,
    "memory_limit_mb": 256,
    "max_timeouts_per_match": 3,
    "print_chars_per_turn": 500,
}
_LIMIT_KEYS = set(_LIMIT_DEFAULTS)


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ActionSpec:
    name: str
    cost: int = 0
    damage: int = 0
    ammo_gain: int = 0
    blocked_by: frozenset = frozenset()
    reflected_by: frozenset = frozenset()


@dataclass(frozen=True)
class Config:
    start_hp: int
    start_ammo: int
    max_ammo: int
    max_rounds: int
    shield_charges: int
    actions: dict  # name -> ActionSpec
    move_timeout_ms: int
    load_timeout_ms: int
    memory_limit_mb: int
    max_timeouts_per_match: int
    print_chars_per_turn: int
    raw: dict  # the parsed file, copied into every replay


def _check_keys(section, data, allowed):
    unknown = set(data) - allowed
    if unknown:
        raise ConfigError(f"[{section}] has unknown keys: {sorted(unknown)} (allowed: {sorted(allowed)})")


def config_from_dict(raw: dict) -> Config:
    game = raw.get("game", {})
    actions = raw.get("actions", {})
    limits = raw.get("limits", {})
    _check_keys("game", game, _GAME_KEYS)
    _check_keys("limits", limits, _LIMIT_KEYS)
    missing = _GAME_KEYS - set(game)
    if missing:
        raise ConfigError(f"[game] is missing: {sorted(missing)}")

    specs = {}
    for name in ACTIONS:
        if name not in actions:
            raise ConfigError(f"[actions.{name}] is missing")
        data = actions[name]
        _check_keys(f"actions.{name}", data, _ACTION_KEYS)
        for key in ("blocked_by", "reflected_by"):
            bad = set(data.get(key, [])) - set(ACTIONS)
            if bad:
                raise ConfigError(f"[actions.{name}].{key} names unknown actions: {sorted(bad)}")
        specs[name] = ActionSpec(
            name=name,
            cost=data.get("cost", 0),
            damage=data.get("damage", 0),
            ammo_gain=data.get("ammo_gain", 0),
            blocked_by=frozenset(data.get("blocked_by", [])),
            reflected_by=frozenset(data.get("reflected_by", [])),
        )
    extra = set(actions) - set(ACTIONS)
    if extra:
        raise ConfigError(f"unknown actions {sorted(extra)}; the engine only knows {list(ACTIONS)}")

    return Config(
        **{k: game[k] for k in _GAME_KEYS},
        actions=specs,
        **{k: limits.get(k, v) for k, v in _LIMIT_DEFAULTS.items()},
        raw=raw,
    )


def load_config(path=None) -> Config:
    path = Path(path) if path else DEFAULT_PATH
    with open(path, "rb") as f:
        return config_from_dict(tomllib.load(f))


def parse_config(text: str) -> Config:
    """For environments without a filesystem (e.g. Pyodide in the browser)."""
    return config_from_dict(tomllib.loads(text))
