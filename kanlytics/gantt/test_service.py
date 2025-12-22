import time
import json
import requests
from pathlib import Path

from kanlytics.gantt.gantt_service import KanlyticsBackend


BASE_URL = "http://localhost:8080"
CSV_PATH = Path("/Users/jeremywurbs/Downloads/AI_Deployment_Master_Task_Checklist_Mindtrace_Adient(Project Task List).csv")
START_DATE = "2026-01-06"


def main():
    # ------------------------------------------------------------------
    # 1. Launch service
    # ------------------------------------------------------------------
    print("Launching KanlyticsBackend...")
    cm = KanlyticsBackend.launch(url=BASE_URL)
    print("Service is up.")

    # ------------------------------------------------------------------
    # 2. Load CSV
    # ------------------------------------------------------------------
    if not CSV_PATH.exists():
        raise FileNotFoundError(f"CSV not found: {CSV_PATH}")

    csv_text = CSV_PATH.read_text(encoding="utf-8")

    # ------------------------------------------------------------------
    # 3. Create plan
    # ------------------------------------------------------------------
    print("Creating plan...")
    resp = requests.post(
        f"{BASE_URL}/gantt.create_plan",
        json={"csv_text": csv_text},
        timeout=30,
    )
    resp.raise_for_status()
    create_data = resp.json()

    plan_id = create_data["plan_id"]
    task_count = create_data["task_count"]

    print(f"Plan created:")
    print(f"  plan_id   = {plan_id}")
    print(f"  task_count = {task_count}")

    assert task_count > 0, "No tasks loaded from CSV"

    # ------------------------------------------------------------------
    # 4. Schedule plan
    # ------------------------------------------------------------------
    print(f"Scheduling plan from start date {START_DATE}...")
    resp = requests.post(
        f"{BASE_URL}/gantt.schedule",
        json={
            "plan_id": plan_id,
            "start_date": START_DATE,
            # duration_mode defaults to "wall"
            # working_days defaults to False
        },
        timeout=30,
    )
    resp.raise_for_status()
    schedule_data = resp.json()

    layout = schedule_data["layout"]
    tasks = layout["tasks"]
    edges = layout["edges"]

    print(f"Schedule complete:")
    print(f"  tasks scheduled = {len(tasks)}")
    print(f"  dependency edges = {len(edges)}")

    # Basic sanity checks
    assert len(tasks) == task_count
    assert "meta" in layout
    assert layout["meta"]["duration_mode"] == "wall"

    # ------------------------------------------------------------------
    # 5. Fetch layout again (idempotency test)
    # ------------------------------------------------------------------
    print("Fetching layout again...")
    resp = requests.post(
        f"{BASE_URL}/gantt.layout",
        json={"plan_id": plan_id},
        timeout=30,
    )
    resp.raise_for_status()
    layout2 = resp.json()["layout"]

    assert layout2 == layout, "Fetched layout differs from scheduled layout"

    # ------------------------------------------------------------------
    # 6. Print a small preview
    # ------------------------------------------------------------------
    print("\nFirst 5 tasks:")
    for t in tasks[:5]:
        sched = t["schedule"]
        print(
            f"  [{t['id']}] {t['name']}"
            f" | start={sched['start']}"
            f" | end={sched['end']}"
            f" | row={sched['row']}"
            f" | x={sched['x']}"
            f" | w={sched['w']}"
        )

    print("\nTest completed successfully ✅")


if __name__ == "__main__":
    main()
