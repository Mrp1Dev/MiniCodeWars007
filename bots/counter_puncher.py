# Expects the opponent to shoot as soon as they have ammo, and counters it.
def play(me, opp, turn, memory):
    if opp.ammo == 0:
        if me.ammo >= 2:
            return SNIPE       # they can't snipe back, so this always hits
        return RELOAD
    if len(opp.history) > 0 and opp.history[-1] == RELOAD and me.ammo >= 1:
        return COUNTER         # they just loaded a bullet, they'll probably fire it
    if me.shields > 0:
        return SHIELD
    return RELOAD
