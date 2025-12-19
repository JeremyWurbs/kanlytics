FROM python:3.12-slim

# Install Node.js (for Vite dev server) + basic tooling
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY pyproject.toml /app/pyproject.toml
COPY README.md /app/README.md
COPY kanlytics /app/kanlytics
RUN python -m pip install --no-cache-dir -U pip uv \
  && uv pip install --system -e .

# Install frontend deps (no lockfile yet; using npm install)
WORKDIR /app/kanlytics/frontend
COPY kanlytics/frontend/package.json /app/kanlytics/frontend/package.json
RUN npm install

# Copy the rest of the frontend sources
COPY kanlytics/frontend /app/kanlytics/frontend

# Entrypoint
WORKDIR /app
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

# Defaults (can be overridden via env + docker run -p)
EXPOSE 8080
EXPOSE 5173

ENV KANLYTICS_BACKEND_PORT=8080
ENV KANLYTICS_FRONTEND_PORT=5173
ENV KANLYTICS_GITHUB_PAT_FILE=/run/secrets/kanlytics_github_pat

ENTRYPOINT ["/app/docker/entrypoint.sh"]
