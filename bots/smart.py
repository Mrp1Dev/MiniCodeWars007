# Plays safe when the opponent can hurt it, and remembers what the
# opponent usually does when it has ammo.
import random

def play(me, opp, turn, memory):
    if "shots" not in memory:
        memory["shots"] = 0      # times the opponent attacked while holding ammo
        memory["chances"] = 0    # times the opponent held ammo
        memory["last_opp_ammo"] = 0

    # Learn from last turn: did they attack when they had ammo?
    if turn > 1 and memory["last_opp_ammo"] >= 1:
        memory["chances"] += 1
        if opp.history[-1] in (SHOOT, SNIPE):
            memory["shots"] += 1
    memory["last_opp_ammo"] = opp.ammo

    # Free hit: an opponent with under 2 ammo can't stop a snipe.
    if me.ammo >= 2 and opp.ammo < 2:
        return SNIPE
    # The opponent can't hurt me at all: load up.
    if opp.ammo == 0:
        return RELOAD if me.ammo < 3 else SHOOT

    aggressive = memory["chances"] >= 3 and memory["shots"] / memory["chances"] > 0.6
    if opp.ammo >= 2:
        if me.ammo >= 2:
            return SNIPE         # snipes cancel, so match theirs
        if me.shields > 0:
            return SHIELD if random.random() < 0.5 else RELOAD
        return RELOAD
    # opponent has exactly 1 ammo
    if aggressive and me.ammo >= 1:
        return COUNTER
    if me.shields > 0 and random.random() < 0.7:
        return SHIELD
    return RELOAD if me.ammo < 3 else SHOOT
