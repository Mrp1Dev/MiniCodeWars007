# Picks a random move it can afford.
import random

def play(me, opp, turn, memory):
    options = [RELOAD]
    if me.shields > 0:
        options.append(SHIELD)
    if me.ammo >= 1:
        options.append(SHOOT)
        options.append(COUNTER)
    if me.ammo >= 2:
        options.append(SNIPE)
    return random.choice(options)
