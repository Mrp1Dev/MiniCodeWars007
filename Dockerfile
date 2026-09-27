# --- 1. build the website (site/ -> web/) ------------------------------------------------
FROM node:22-slim AS site
WORKDIR /app/site
COPY site/package.json site/package-lock.json ./
RUN npm ci
COPY site/ ./
RUN npm run build            # writes to /app/web (vite outDir is ../web)

# --- 2. the Python server ----------------------------------------------------------------
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY config.toml ./
COPY engine/ engine/
COPY server/ server/
COPY bots/ bots/
COPY starter/ starter/
COPY --from=site /app/web web/

# The Linux sandbox relies on RLIMIT_NPROC=0 to stop bots starting processes, and root
# ignores that limit, so the server must not run as root. data/ holds the SQLite DB and
# the generated admin key; mount a persistent volume there.
RUN useradd --create-home --uid 1000 mcw && mkdir -p data && chown mcw:mcw data
USER mcw

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/status', timeout=4)"

# One worker only: AI budget reservations, rate limits and the tournament runner live in memory.
# --proxy-headers because Coolify's Traefik terminates TLS in front of us.
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
