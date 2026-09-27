import argparse

import uvicorn

from .app import ADMIN_KEY, ADMIN_KEY_FILE

ap = argparse.ArgumentParser(prog="python -m server")
ap.add_argument("--host", default="0.0.0.0")
ap.add_argument("--port", type=int, default=8000)
args = ap.parse_args()

print(f"Admin key: {ADMIN_KEY}  (from MCW_ADMIN_KEY or {ADMIN_KEY_FILE})")
print(f"API docs:  http://localhost:{args.port}/docs")
uvicorn.run("server.app:app", host=args.host, port=args.port, reload=True)
