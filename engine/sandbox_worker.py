"""Runs ONE bot in its own process. Started by engine/sandbox.py; speaks JSON lines.

  -> {"cmd": "load", "source": ..., "filename": ..., "print_limit": ...}
  <- {"error": str|null, "output": str}
  -> {"cmd": "act", "me": {...}, "opp": {...}, "turn": n, "seed": "..."}
  <- {"move": str|null, "output": str, "error": str|null}

"load" again resets the bot (fresh namespace and memory) for the next match.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from botapi import BotRunner  # noqa: E402


def main():
    proto_in, proto_out = sys.stdin, sys.stdout
    # Nothing the bot does can reach the protocol pipes.
    sys.stdin = None
    sys.stdout = sys.stderr = open(os.devnull, "w")
    runner = None
    for line in proto_in:
        msg = json.loads(line)
        if msg["cmd"] == "load":
            runner = BotRunner(msg["source"], msg["filename"], msg["print_limit"], safe=True)
            reply = {"error": runner.load_error, "output": runner.load_output}
        else:
            reply = runner.act(msg["me"], msg["opp"], msg["turn"], msg["seed"])
            if isinstance(reply["move"], str):
                reply["move"] = reply["move"][:40]
        proto_out.write(json.dumps(reply) + "\n")
        proto_out.flush()


if __name__ == "__main__":
    main()
