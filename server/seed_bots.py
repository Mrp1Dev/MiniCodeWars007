"""Mock participant and bot generator for MiniCodeWars 007 testing.

Generates realistic 007-themed participants with diverse working strategies:
- Snipers, Counter-punchers, Turtles, Aggressors, Smart predictors, Balanced agents
- Submits valid code to the database so you can immediately test the entire tournament flow
  with 32, 64, 128, 256, or 400+ bots!
"""
import argparse
import json
import random
import time
from typing import List, Tuple

from . import db, settings

FIRST_NAMES = [
    "Aarav", "Aditi", "Advait", "Akash", "Ananya", "Aniket", "Anushka", "Arjun",
    "Aryan", "Ayush", "Bhavya", "Chirag", "Dev", "Dhruv", "Diya", "Gaurav",
    "Harsh", "Isha", "Ishaan", "Karan", "Kavya", "Khushi", "Krishna", "Madhav",
    "Manish", "Meera", "Mihir", "Neha", "Nikhil", "Nisha", "Parth", "Pooja",
    "Pranav", "Priya", "Rahul", "Rhea", "Rishi", "Rohan", "Saanvi", "Samarth",
    "Sameer", "Sanya", "Shaurya", "Shivam", "Shreya", "Siddharth", "Sneha",
    "Tanvi", "Utkarsh", "Varun", "Vedant", "Vidhi", "Vihan", "Vikram", "Yash"
]

LAST_NAMES = [
    "Agarwal", "Bansal", "Bhatia", "Chakraborty", "Chauhan", "Deshmukh", "Dubey",
    "Garg", "Gupta", "Iyer", "Jain", "Joshi", "Kapoor", "Khan", "Kumar", "Malhotra",
    "Mehta", "Mishra", "Mukherjee", "Nair", "Pandey", "Patel", "Prasad", "Rao",
    "Reddy", "Roy", "Saxena", "Sen", "Shah", "Sharma", "Shukla", "Singh", "Sinha",
    "Tiwari", "Tripathi", "Varma", "Verma", "Yadav"
]

CODENAMES = [
    "Skyfall", "Spectre", "GoldenEye", "Vesper", "Goldfinger", "DrNo", "Oddjob",
    "Moneypenny", "Octopussy", "Moonraker", "CasinoRoyale", "Thunderball", "Fireball",
    "Scaramanga", "Blofeld", "Jinx", "DoubleOSeven", "ShadowSniper", "Quantum",
    "Solace", "Silva", "Severine", "QBranch", "FelixLeiter", "MayDay", "Zukovsky",
    "Renard", "Elektra", "Gideon", "Nightfire", "AgentX", "Phantom", "Viper",
    "Razor", "Ghost", "Hawkeye", "Apex", "Ronin", "Eclipse", "Titan", "Zero",
    "Cobalt", "Falcon", "Mirage", "Nemesis", "Cipher", "Bulletproof", "Vanguard",
    "Overwatch", "Ironclad", "Stealth", "Specter007", "Blackwatch", "Stormbringer"
]

# Diverse bot logic templates
BOT_TEMPLATES = [
    # 1. Counter Puncher
    """# Counter Puncher archetype
def play(me, opp, turn, seed):
    # React to opponent state
    if opp.ammo == 0:
        if me.ammo >= 2:
            return 'SNIPE'
        if me.ammo >= 1:
            return 'SHOOT'
        return 'RELOAD'
    if opp.ammo >= 1 and me.ammo >= 1 and (turn % 2 == 1 or len(opp.history) > 0 and opp.history[-1] == 'RELOAD'):
        return 'COUNTER'
    if me.shields > 0 and opp.ammo >= 1:
        return 'SHIELD'
    if me.ammo >= 2:
        return 'SNIPE'
    return 'RELOAD'
""",
    # 2. Aggressive Sniper
    """# Aggressive Sniper archetype
def play(me, opp, turn, seed):
    if me.ammo >= 2:
        return 'SNIPE'
    if me.ammo >= 1 and opp.ammo == 0:
        return 'SHOOT'
    if opp.ammo >= 2 and me.shields > 0:
        return 'SHIELD'
    if opp.ammo == 1 and me.ammo >= 1 and turn % 3 == 0:
        return 'COUNTER'
    return 'RELOAD'
""",
    # 3. Smart Predictor
    """# Smart Predictor archetype
def play(me, opp, turn, seed):
    if turn == 1:
        return 'RELOAD'
    if opp.ammo >= 2:
        return 'SHIELD' if me.shields > 0 else ('COUNTER' if me.ammo >= 1 else 'RELOAD')
    if opp.ammo == 1:
        if me.ammo >= 1 and (turn % 2 == 1):
            return 'COUNTER'
        if me.shields > 0 and turn % 3 == 0:
            return 'SHIELD'
    if me.ammo >= 2:
        return 'SNIPE'
    if me.ammo >= 1 and opp.ammo == 0:
        return 'SHOOT'
    return 'RELOAD'
""",
    # 4. Gunslinger / Fast Blaster
    """# Fast Blaster archetype
def play(me, opp, turn, seed):
    if me.ammo >= 1 and (opp.ammo == 0 or (len(opp.history) > 0 and opp.history[-1] == 'RELOAD')):
        return 'SHOOT'
    if me.ammo >= 2 and opp.ammo < 2:
        return 'SNIPE'
    if me.ammo >= 1 and opp.ammo == 0:
        return 'SHOOT'
    if opp.ammo >= 1 and me.ammo >= 1 and turn % 2 == 0:
        return 'COUNTER'
    if opp.ammo >= 1 and me.shields > 0:
        return 'SHIELD'
    return 'RELOAD'
""",
    # 5. Trigger Happy
    """# Trigger Happy archetype
def play(me, opp, turn, seed):
    if me.ammo >= 2 and turn % 2 == 1:
        return 'SNIPE'
    if me.ammo > 0:
        return 'SHOOT'
    return 'RELOAD'
""",
    # 6. Balanced Agent 007
    """# Balanced Agent 007 archetype
def play(me, opp, turn, seed):
    if opp.ammo == 0:
        if me.ammo >= 2:
            return 'SNIPE'
        if me.ammo >= 1:
            return 'SHOOT'
        return 'RELOAD'
    if opp.ammo >= 1:
        if me.ammo >= 1 and turn % 3 == 1:
            return 'COUNTER'
        if me.shields > 0 and turn % 2 == 0:
            return 'SHIELD'
    if me.ammo >= 2:
        return 'SNIPE'
    if me.ammo >= 1:
        return 'SHOOT'
    return 'RELOAD'
""",
    # 7. Ambush Specialist
    """# Ambush Specialist archetype
def play(me, opp, turn, seed):
    if me.ammo == 0:
        return 'RELOAD'
    if me.ammo >= 2 and opp.ammo <= 1:
        return 'SNIPE'
    if opp.ammo >= 1 and me.ammo >= 1:
        return 'COUNTER' if (turn % 2 == 1) else ('SHIELD' if me.shields > 0 else 'SHOOT')
    return 'SHOOT' if me.ammo >= 1 else 'RELOAD'
"""
]


def generate_mock_participants(count: int = 64) -> List[dict]:
    """Generates mock participants and returns their records."""
    participants = []
    used_rolls = set()
    used_bot_names = set()

    for i in range(1, count + 1):
        # Unique mock roll number: MOCK_0001, MOCK_0002...
        roll = f"MOCK_{i:04d}"
        used_rolls.add(roll)

        # Real name
        fname = random.choice(FIRST_NAMES)
        lname = random.choice(LAST_NAMES)
        name = f"{fname} {lname}"

        # Unique 007 Bot Name
        base_code = random.choice(CODENAMES)
        bot_name = f"Agent_{base_code}" if i <= len(CODENAMES) else f"Agent_{base_code}_{i}"
        while bot_name in used_bot_names:
            bot_name = f"{random.choice(CODENAMES)}_{random.randint(10, 999)}"
        used_bot_names.add(bot_name)

        # Assigned strategy code
        code = random.choice(BOT_TEMPLATES)

        participants.append({
            "roll": roll,
            "name": name,
            "bot_name": bot_name,
            "code": code,
        })

    return participants


def seed_database(count: int = 64) -> int:
    """Inserts mock participants and submissions into the database."""
    items = generate_mock_participants(count)
    inserted = 0
    now = time.time()

    with db.connect() as c:
        for p in items:
            # Insert or replace participant
            c.execute("""
                INSERT INTO participants(roll, name, bot_name, token_hash, created_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(roll) DO UPDATE SET name = excluded.name, bot_name = excluded.bot_name
            """, (p["roll"], p["name"], p["bot_name"], p["roll"], now))

            part = c.execute("SELECT id FROM participants WHERE roll = ?", (p["roll"],)).fetchone()
            if part:
                pid = part["id"]
                # Insert submission with 'ok' status
                c.execute("""
                    INSERT INTO submissions(participant_id, code, pseudocode, status, report, created_at)
                    VALUES(?, ?, ?, 'ok', '{}', ?)
                """, (pid, p["code"], "# Auto-generated mock bot", now))
                inserted += 1

    return inserted


def clear_mock_participants():
    """Removes all mock participants (roll numbers starting with MOCK_) and resets tournament."""
    with db.connect() as c:
        c.execute("DELETE FROM submissions WHERE participant_id IN (SELECT id FROM participants WHERE roll LIKE 'MOCK_%')")
        c.execute("DELETE FROM tournament_standings WHERE participant_id IN (SELECT id FROM participants WHERE roll LIKE 'MOCK_%')")
        c.execute("DELETE FROM participants WHERE roll LIKE 'MOCK_%'")

        # Clear active tournament matches and state
        c.execute("DELETE FROM tournament_matches")
        c.execute("DELETE FROM tournament_rounds")
        c.execute("DELETE FROM tournament_standings")
        c.execute("DELETE FROM tournament_state")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed mock bots for MiniCodeWars 007")
    parser.add_argument("--count", type=int, default=64, help="Number of bots to generate (e.g. 32, 64, 128, 400)")
    parser.add_argument("--clear", action="store_true", help="Clear all generated mock bots")
    args = parser.parse_args()

    if args.clear:
        clear_mock_participants()
        print("All mock bots and tournament records cleared!")
    else:
        num = seed_database(args.count)
        print(f"Successfully generated and seeded {num} mock bots into the database!")
