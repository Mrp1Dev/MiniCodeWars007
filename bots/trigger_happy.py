# Shoots whenever it has a bullet, otherwise reloads.
def play(me, opp, turn, memory):
    if me.ammo >= 1:
        return SHOOT
    return RELOAD
