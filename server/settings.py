"""Settings from environment variables, with a .env file in the project root as fallback."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key, value)  # real environment variables win


_load_dotenv(ROOT / ".env")


def get(name, default=None):
    value = os.environ.get(name, "")
    return value if value != "" else default


DB_PATH = Path(get("MCW_DB", ROOT / "data" / "minicodewars.db"))
ADMIN_KEY = get("MCW_ADMIN_KEY")
CONFIG_PATH = get("MCW_CONFIG")
CORS_ORIGINS = get("MCW_CORS_ORIGINS", "*").split(",")
MAX_PARALLEL_MATCHES = int(get("MCW_MAX_PARALLEL_MATCHES", max(2, (os.cpu_count() or 4) - 2)))

AI_BASE_URL = get("MCW_AI_BASE_URL", "https://api.featherless.ai/v1")
AI_API_KEY = get("MCW_AI_API_KEY")
# Optional second key, used when a call with the main key fails (see ai.py). Same base URL and model.
AI_API_KEY_BACKUP = get("MCW_AI_API_KEY_BACKUP")
AI_MODEL = get("MCW_AI_MODEL", "deepseek-ai/DeepSeek-V4-Flash-0731")
AI_MAX_TOKENS = int(get("MCW_AI_MAX_TOKENS", 6000))  # thinking counts too; too low = empty answers
AI_TIMEOUT_S = float(get("MCW_AI_TIMEOUT_S", 120))
AI_CONCURRENCY = int(get("MCW_AI_CONCURRENCY", 10))
AI_PER_MINUTE = int(get("MCW_AI_PER_MINUTE", 4))
AI_MAX_PER_PARTICIPANT = int(get("MCW_AI_MAX_PER_PARTICIPANT", 60))
# Budgets in output-equivalent tokens (output + input/2). The whole event, and each participant.
AI_TOKEN_BUDGET = int(get("MCW_AI_TOKEN_BUDGET", 70_000_000))
AI_TOKENS_PER_PARTICIPANT = int(get("MCW_AI_TOKENS_PER_PARTICIPANT", 100_000))
