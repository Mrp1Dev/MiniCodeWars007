"""Pure turn resolution: no bot code, no I/O, no randomness.

Turn order:
  1. Each requested move is checked. Unknown moves, moves you can't afford and
     SHIELD with no charges left become FUMBLE (vulnerable, nothing happens).
  2. Ammo costs are paid.
  3. Attacks resolve simultaneously. For each attack, look at what the defender did:
       in the attack's blocked_by   -> nothing happens
       in the attack's reflected_by -> the attacker takes the damage
       anything else                -> the defender takes the damage
  4. RELOAD adds ammo (capped at max_ammo).
  5. SHIELD uses a charge; any other action except FUMBLE refills the charges.
"""
from dataclasses import dataclass, field

from .config import ACTIONS, Config

FUMBLE = "FUMBLE"


@dataclass
class Player:
    hp: int
    ammo: int
    shields: int
    history: list = field(default_factory=list)  # resolved actions, FUMBLE included
    damage_dealt: int = 0

    @classmethod
    def new(cls, cfg: Config):
        return cls(hp=cfg.start_hp, ammo=cfg.start_ammo, shields=cfg.shield_charges)

    def snapshot(self):
        return {"hp": self.hp, "ammo": self.ammo, "shields": self.shields}


def check_move(move, player: Player, cfg: Config):
    """Returns (action, fumble_reason). fumble_reason is None for a legal move."""
    if move is None:
        return FUMBLE, "play() returned nothing (missing return?)"
    if not isinstance(move, str):
        return FUMBLE, f"play() returned {move!r}, which is not a move"
    name = move.strip().upper()
    if name not in ACTIONS:
        return FUMBLE, f"unknown move {move!r}"
    cost = cfg.actions[name].cost
    if player.ammo < cost:
        return FUMBLE, f"{name} needs {cost} ammo, you have {player.ammo}"
    if name == "SHIELD" and player.shields <= 0:
        return FUMBLE, "shield has no charges left"
    return name, None


def resolve_turn(players, moves, cfg: Config):
    """Applies one turn to both players (mutating them). Returns what happened."""
    checked = [check_move(m, p, cfg) for m, p in zip(moves, players)]
    actions = [a for a, _ in checked]
    events = []

    for p, a in zip(players, actions):
        if a != FUMBLE:
            p.ammo -= cfg.actions[a].cost

    damage = [0, 0]
    for att in (0, 1):
        dfd = 1 - att
        spec = cfg.actions.get(actions[att])
        if spec is None or spec.damage <= 0:
            continue
        if actions[dfd] in spec.blocked_by:
            events.append({"type": "blocked", "by": att, "action": spec.name, "with": actions[dfd]})
        elif actions[dfd] in spec.reflected_by:
            damage[att] += spec.damage
            players[dfd].damage_dealt += spec.damage
            events.append({"type": "reflected", "by": att, "action": spec.name,
                           "with": actions[dfd], "damage": spec.damage})
        else:
            damage[dfd] += spec.damage
            players[att].damage_dealt += spec.damage
            events.append({"type": "hit", "by": att, "action": spec.name, "damage": spec.damage})

    for p, a, d in zip(players, actions, damage):
        p.hp = max(0, p.hp - d)
        if a != FUMBLE:
            p.ammo = min(cfg.max_ammo, p.ammo + cfg.actions[a].ammo_gain)
        if a == "SHIELD":
            p.shields -= 1
        elif a != FUMBLE:
            p.shields = cfg.shield_charges
        p.history.append(a)

    return {"actions": actions, "fumbles": [r for _, r in checked], "damage": damage, "events": events}


def decide_winner(players):
    """Returns (winner_index or None for a draw, reason)."""
    for key, label in (("hp", "more HP"), ("ammo", "more ammo"), ("damage_dealt", "more damage dealt")):
        a, b = getattr(players[0], key), getattr(players[1], key)
        if a != b:
            return (0 if a > b else 1), label
    return None, "identical HP, ammo and damage dealt"
