# Hides behind the shield whenever the opponent could shoot.
def play(me, opp, turn, memory):
    if me.ammo >= 2:
        return SNIPE
    if opp.ammo >= 1 and me.shields > 0:
        return SHIELD
    return RELOAD
