# gantt_service.py

from __future__ import annotations

from typing import Any, Dict, Optional, Type
from uuid import uuid4
import threading
import tempfile
import os

from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

from mindtrace.services import Service
from mindtrace.core.types.task_schema import TaskSchema

from .gantt import Gantt


# ----------------------------
# Pydantic Schemas
# ----------------------------

class CreatePlanInput(BaseModel):
    """
    Create a new in-memory plan from CSV content.

    Notes:
      - We accept CSV as text so the frontend can upload directly.
      - The server parses/validates dependencies and stores the plan.
    """
    csv_text: str = Field(
        ...,
        description="Full CSV file contents as UTF-8 text (V2 single-header template format).",
    )


class CreatePlanOutput(BaseModel):
    plan_id: str
    task_count: int
    normalized_csv_text: str = Field(
        ...,
        description="Normalized V2 CSV text with generated UUID Task IDs and UUID Dependencies (safe to save back to disk).",
    )


class ScheduleInput(BaseModel):
    """
    Schedule a previously created plan.
    """
    plan_id: str
    start_date: str = Field(..., description="Project start date in ISO format YYYY-MM-DD.")
    duration_mode: str = Field("wall", description="Duration mode: 'wall' (default) or 'billable'.")
    working_days: bool = Field(False, description="If True, interpret durations as working days (Mon-Fri).")


class ScheduleOutput(BaseModel):
    plan_id: str
    layout: Dict[str, Any]


class LayoutInput(BaseModel):
    plan_id: str


class LayoutOutput(BaseModel):
    plan_id: str
    layout: Dict[str, Any]


# ----------------------------
# TaskSchema Definitions
# ----------------------------

create_plan_task = TaskSchema(
    name="gantt.create_plan",
    input_schema=CreatePlanInput,
    output_schema=CreatePlanOutput,
)

schedule_task = TaskSchema(
    name="gantt.schedule",
    input_schema=ScheduleInput,
    output_schema=ScheduleOutput,
)

layout_task = TaskSchema(
    name="gantt.layout",
    input_schema=LayoutInput,
    output_schema=LayoutOutput,
)


# ----------------------------
# Service
# ----------------------------

class GanttService(Service):
    """
    Mindtrace Service wrapper for Gantt backend.

    Endpoints:
      - gantt.create_plan
      - gantt.schedule
      - gantt.layout
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)

        self._lock = threading.RLock()
        self._plans: Dict[str, Gantt] = {}
        self._layouts: Dict[str, Dict[str, Any]] = {}

        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=[
                "http://localhost:5173",  # Vite dev server
                "http://127.0.0.1:5173",
            ],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        self.add_endpoint("gantt.create_plan", self.create_plan, schema=create_plan_task)
        self.add_endpoint("gantt.schedule", self.schedule, schema=schedule_task)
        self.add_endpoint("gantt.layout", self.get_layout, schema=layout_task)

    # -------------
    # Endpoints
    # -------------

    def create_plan(self, payload: CreatePlanInput) -> CreatePlanOutput:
        """
        Parse CSV text into a Gantt plan and store it server-side.
        """
        gantt = self._gantt_from_csv_text(payload.csv_text)

        plan_id = str(uuid4())
        with self._lock:
            self._plans[plan_id] = gantt
            # clear any old layout under same id (shouldn't happen, but safe)
            self._layouts.pop(plan_id, None)

        return CreatePlanOutput(
            plan_id=plan_id,
            task_count=len(gantt.tasks),
            normalized_csv_text=gantt.export_csv_v2(),
        )

    def schedule(self, payload: ScheduleInput) -> ScheduleOutput:
        """
        Schedule an existing plan and return the computed layout immediately.
        Default behavior uses 'wall' days, per your requirement.
        """
        with self._lock:
            gantt = self._plans.get(payload.plan_id)

        if gantt is None:
            raise ValueError(f"Unknown plan_id: {payload.plan_id}")

        gantt.schedule(
            start_date=payload.start_date,
            duration_mode=payload.duration_mode,
            working_days=payload.working_days,
        )
        layout = gantt.export_layout()

        with self._lock:
            self._layouts[payload.plan_id] = layout

        return ScheduleOutput(plan_id=payload.plan_id, layout=layout)

    def get_layout(self, payload: LayoutInput) -> LayoutOutput:
        """
        Fetch the last computed layout for a plan.
        """
        with self._lock:
            layout = self._layouts.get(payload.plan_id)

        if layout is None:
            raise ValueError(
                f"No layout found for plan_id={payload.plan_id}. "
                f"Did you call gantt.schedule first?"
            )

        return LayoutOutput(plan_id=payload.plan_id, layout=layout)

    # -------------
    # Helpers
    # -------------

    @staticmethod
    def _gantt_from_csv_text(csv_text: str) -> Gantt:
        """
        The backend `Gantt.from_csv(...)` currently expects a file path,
        so we write to a temporary file and load it.

        If you later add `Gantt.from_csv_text(...)`, we can remove this.
        """
        fd, path = tempfile.mkstemp(suffix=".csv", text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(csv_text)
            return Gantt.from_csv(path)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
