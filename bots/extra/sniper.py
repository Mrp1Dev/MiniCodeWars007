# Saves up for snipes, and snipes back if the opponent can snipe too.
def play(me, opp, turn, memory):
    if opp.ammo == 0 and me.ammo < 2:
        return RELOAD          # opponent can't hurt me right now
    if me.ammo >= 2:
        return SNIPE
    if opp.ammo >= 1 and me.shields > 0:
        return SHIELD
    return RELOAD
