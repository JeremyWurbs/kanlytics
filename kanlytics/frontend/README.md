# Gantt Frontend (React + Vite)

A minimal React frontend that talks to your Mindtrace-backed `KanlyticsBackend`.

## Prereqs
- Node.js 18+ recommended
- Your backend service running on `http://localhost:8080`

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Open the dev server URL (usually `http://localhost:5173`).

## Configure API Base
Edit `.env`:

```
VITE_API_BASE=http://localhost:8080
```

## What it does
1. Upload CSV
2. Create plan (`POST /gantt.create_plan`)
3. Schedule (`POST /gantt.schedule`)
4. Render an SVG Gantt chart with optional dependency lines

## Notes
- Your backend may return tasks with `schedule.w = 0` (milestones). The chart renders those as small pills.
- If you later add richer layout (phase headers, packed rows), the frontend will automatically render whatever `schedule.row/x/w` you return.
