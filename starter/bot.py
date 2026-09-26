# Write your bot in Python, or describe it in plain English and press "Clean with AI".
#
# play() is called once every turn and must return one move:
#     RELOAD   +1 ammo
#     SHIELD   blocks SHOOT (3 uses in a row, then it needs a rest)
#     SHOOT    1 ammo: 1 damage
#     SNIPE    2 ammo: 1 damage, goes through SHIELD
#     COUNTER  1 ammo: sends a SHOOT back at the shooter
#
#   me.hp, me.ammo, me.shields, me.history    you
#   opp.hp, opp.ammo, opp.history             the opponent (their shields are hidden)
#   turn     1, 2, 3, ...
#   memory   a dict to remember things between turns
#   history  a list of past moves, e.g. opp.history[-1] is their last move

def play(me, opp, turn, memory):
    return RELOAD
