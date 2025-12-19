# Kanlytics

Kanlytics is a local-first project planning tool that can **import/export** between:

- **CSV (V2)** project plans
- **GitHub Projects (ProjectV2)** + Issues (including round-trippable planning fields)

It includes a browser-based UI for editing/scheduling and a Python backend that talks to GitHub.

## Features

- **Gantt chart UI**: schedule tasks, view phases, critical path/slack, and export views (including PNG)
- **GitHub sync**: pull from / push to GitHub ProjectV2 boards and Issues
- **Multi-project support**: save/load projects and view multiple projects together
- **Local persistence**: projects are stored in a registry at `~/.cache/kanlytics/projects` (mounted as a volume in Docker)

## Authentication (GitHub PAT)

Kanlytics can read a GitHub token from several sources:

- **Environment variables**: `GITHUB_TOKEN`, `GITHUB_PAT`, `GITHUB_ACCESS_TOKEN`, `GH_TOKEN`
- **Config file** (dev-only; don’t ship secrets in images): `kanlytics/core/config.ini`

For Docker deployments, we recommend providing the token via a **Docker secret file**, mounted at:

- `/run/secrets/kanlytics_github_pat`

The container entrypoint reads that secret file and exports it as `GITHUB_TOKEN`.

## Option 1: Run from source (`git clone`)

### Requirements

- Python **3.12+**
- Node **20+**
- [`uv`](https://github.com/astral-sh/uv) (recommended)

### Backend (FastAPI via Mindtrace Service)

Start the backend on port `8080`:

```bash
uv run python -c "from kanlytics.gantt.gantt_service import GanttService; GanttService.launch(url='http://0.0.0.0:8080/', timeout=15)"
```

### Frontend (Vite)

In another terminal:

```bash
cd kanlytics/frontend
npm install
VITE_API_BASE=http://localhost:8080 npm run dev -- --port 5173
```

Then open: `http://localhost:5173/`

## Option 2: Run via Docker

Kanlytics currently runs **frontend + backend in a single container** (dev-style Vite server for now).

### 2a) Recommended: `docker compose` (with a PAT secret + persistent project storage)

1) Create a token file:

- Put your Github PAT in `secrets/github_pat.txt` (this folder is ignored by git)

2) Start:

```bash
docker compose up --build
```

3) Open: `http://localhost:5173/`

### 2b) `docker run` (mount a “secret file”)

```bash
docker build -f docker/Dockerfile -t kanlytics:local .
docker run --rm \
  -p 5173:5173 -p 8080:8080 \
  --mount type=bind,src="$PWD/secrets/github_pat.txt",dst=/run/secrets/kanlytics_github_pat,ro \
  kanlytics:local
```

Open: `http://localhost:5173/`

### Ports / configuration

You can override ports via env vars (and update your port mappings accordingly):

- `KANLYTICS_FRONTEND_PORT` (default `5173`)
- `KANLYTICS_BACKEND_PORT` (default `8080`)

If you use non-default ports, the container will also update backend CORS automatically via `KANLYTICS_CORS_ORIGINS`.

## Docker Hub (pre-built image)

If/when you’re using a pre-built Docker Hub image, you can:

- Replace `image: kanlytics:local` in `docker-compose.yml` with your published tag, and remove the `build:` section.

## License

See `LICENSE`.