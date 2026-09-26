# Starter bot: picks a completely random move every turn.
# Some of those moves will FUMBLE (like SHOOT with no ammo). You can do better!
import random


def play(me, opp, turn, memory):
    return random.choice([RELOAD, SHIELD, SHOOT, SNIPE, COUNTER])
