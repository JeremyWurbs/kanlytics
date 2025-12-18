# gantt_service.py

from __future__ import annotations

from typing import Any, Dict, Optional, Type, Literal
from uuid import uuid4
import threading
import tempfile
import os
import time
from pathlib import Path

from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

from mindtrace.services import Service
from mindtrace.core.types.task_schema import TaskSchema
from mindtrace.registry import Registry

from .gantt import Gantt
from kanlytics.core.github_issue import GitHubIssue
from kanlytics.core.github_project_v2 import GitHubProjectV2, new_uuid

STATUS_OPTIONS = ["Backlog", "Planned", "In Progress", "In Review", "Done"]


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
    project_name: Optional[str] = Field(
        default=None,
        description="Optional project name to stamp into tasks/CSV for future multi-project support.",
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


class LoadCsvPathInput(BaseModel):
    csv_path: str = Field(
        ...,
        description="Local filesystem path to a V2 CSV file. This path is read by the backend (for local dev).",
    )


class LoadCsvPathOutput(BaseModel):
    csv_text: str = Field(..., description="Full CSV file contents as UTF-8 text.")
    file_name: Optional[str] = Field(default=None, description="Best-effort file name derived from the path.")


class SaveCsvPathInput(BaseModel):
    csv_path: str = Field(..., description="Local filesystem path to write the CSV to.")
    csv_text: str = Field(..., description="CSV contents as UTF-8 text.")


class SaveCsvPathOutput(BaseModel):
    csv_path: str
    bytes_written: int


class SaveProjectInput(BaseModel):
    project_name: str = Field(..., description="Project display name used as the Registry key.")
    csv_text: str = Field(..., description="Project CSV contents to persist.")


class SaveProjectOutput(BaseModel):
    project_name: str
    registry_name: str


class LoadProjectInput(BaseModel):
    project_name: str = Field(..., description="Project display name (or registry key).")
    output_path: Optional[str] = Field(
        default=None,
        description="Optional output path to place the CSV file (passed through to Registry.load output_dir).",
    )


class LoadProjectOutput(BaseModel):
    project_name: str
    registry_name: str
    csv_text: str
    csv_path: str


class ListProjectsOutput(BaseModel):
    project_names: list[str]


class ListProjectsInput(BaseModel):
    pass


class ConnectProjectInput(BaseModel):
    project_url: str = Field(..., description="GitHub ProjectV2 board URL (e.g. https://github.com/orgs/<org>/projects/<n>).")


class ConnectProjectOutput(BaseModel):
    task_count: int
    csv_text: str = Field(..., description="V2 CSV representing the project board items (Task IDs populated).")
    project_start_date: Optional[str] = Field(
        default=None,
        description="Best-effort earliest Start Date across items (YYYY-MM-DD).",
    )


class ExportProjectInput(BaseModel):
    plan_id: str
    project_url: str = Field(..., description="GitHub ProjectV2 board URL (e.g. https://github.com/orgs/<org>/projects/<n>).")
    issue_repo: Optional[str] = Field(
        default=None,
        description="Optional target repo ('owner/repo' or https://github.com/owner/repo) for creating missing issues.",
    )
    project_name: Optional[str] = Field(
        default=None,
        description="Optional project name to write to a ProjectV2 text field for each item.",
    )


class ExportProjectOutput(BaseModel):
    updated_issues: int = 0
    updated_draft_issues: int = 0
    created_draft_issues: int = 0
    added_existing_issues: int = 0
    errors: list[str] = Field(default_factory=list)


class StartJobOutput(BaseModel):
    job_id: str


class JobStatusInput(BaseModel):
    job_id: str


class JobStatusOutput(BaseModel):
    job_id: str
    state: Literal["queued", "running", "completed", "failed"]
    progress: int = Field(0, ge=0, le=100)
    message: str = ""
    # result payload varies by job type:
    # - connect: {"task_count": int, "csv_text": str}
    # - export: counts + errors (same as ExportProjectOutput)
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


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

load_csv_path_task = TaskSchema(
    name="csv.load_path",
    input_schema=LoadCsvPathInput,
    output_schema=LoadCsvPathOutput,
)

save_csv_path_task = TaskSchema(
    name="csv.save_path",
    input_schema=SaveCsvPathInput,
    output_schema=SaveCsvPathOutput,
)

save_project_task = TaskSchema(
    name="projects.save",
    input_schema=SaveProjectInput,
    output_schema=SaveProjectOutput,
)

load_project_task = TaskSchema(
    name="projects.load",
    input_schema=LoadProjectInput,
    output_schema=LoadProjectOutput,
)

list_projects_task = TaskSchema(
    name="projects.list",
    input_schema=ListProjectsInput,
    output_schema=ListProjectsOutput,
)

class CriticalPathInput(BaseModel):
    plan_id: str


class CriticalPathOutput(BaseModel):
    plan_id: str
    critical_path: list[str] = Field(..., description="Ordered list of task IDs on the critical path.")


critical_path_task = TaskSchema(
    name="gantt.critical_path",
    input_schema=CriticalPathInput,
    output_schema=CriticalPathOutput,
)

connect_project_task = TaskSchema(
    name="github.connect_project",
    input_schema=ConnectProjectInput,
    output_schema=ConnectProjectOutput,
)

export_project_task = TaskSchema(
    name="github.export_project",
    input_schema=ExportProjectInput,
    output_schema=ExportProjectOutput,
)

connect_project_start_task = TaskSchema(
    name="github.connect_project_start",
    input_schema=ConnectProjectInput,
    output_schema=StartJobOutput,
)

export_project_start_task = TaskSchema(
    name="github.export_project_start",
    input_schema=ExportProjectInput,
    output_schema=StartJobOutput,
)

job_status_task = TaskSchema(
    name="github.job_status",
    input_schema=JobStatusInput,
    output_schema=JobStatusOutput,
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
        self._jobs: Dict[str, JobStatusOutput] = {}
        self._project_registry = Registry("~/.cache/kanlytics/projects")

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
        self.add_endpoint("csv.load_path", self.load_csv_path, schema=load_csv_path_task)
        self.add_endpoint("csv.save_path", self.save_csv_path, schema=save_csv_path_task)
        self.add_endpoint("projects.save", self.save_project, schema=save_project_task)
        self.add_endpoint("projects.load", self.load_project, schema=load_project_task)
        self.add_endpoint("projects.list", self.list_projects, schema=list_projects_task)
        self.add_endpoint("gantt.schedule", self.schedule, schema=schedule_task)
        self.add_endpoint("gantt.layout", self.get_layout, schema=layout_task)
        self.add_endpoint("gantt.critical_path", self.get_critical_path, schema=critical_path_task)
        self.add_endpoint("github.connect_project", self.connect_project, schema=connect_project_task)
        self.add_endpoint("github.export_project", self.export_project, schema=export_project_task)
        self.add_endpoint("github.connect_project_start", self.connect_project_start, schema=connect_project_start_task)
        self.add_endpoint("github.export_project_start", self.export_project_start, schema=export_project_start_task)
        self.add_endpoint("github.job_status", self.job_status, schema=job_status_task)

    # -------------
    # Endpoints
    # -------------

    @staticmethod
    def _registry_key_from_display_name(display_name: str) -> str:
        # Registry disallows '_' and '@'. It recommends ':' for namespacing.
        name = (display_name or "").strip()
        name = name.replace("_", ":").replace("@", ":")
        return name

    def _resolve_registry_name(self, project_name: str) -> str:
        # First try normalized key directly.
        key = self._registry_key_from_display_name(project_name)
        if self._project_registry.has_object(key):
            return key

        # Otherwise, try matching stored metadata display_name.
        for obj_name in self._project_registry.list_objects():
            try:
                info = self._project_registry.info(obj_name) or {}
                # info is dict[version -> metadata]
                for v_meta in info.values():
                    md = (v_meta or {}).get("metadata") or {}
                    if md.get("display_name") == project_name:
                        return obj_name
            except Exception:
                continue
        raise ValueError(f"Project not found in registry: {project_name}")

    def load_csv_path(self, payload: LoadCsvPathInput) -> LoadCsvPathOutput:
        raw = (payload.csv_path or "").strip()
        if not raw:
            raise ValueError("csv_path is required.")

        # Expand "~" and environment variables, then normalize.
        path = os.path.abspath(os.path.expanduser(os.path.expandvars(raw)))
        if not os.path.exists(path):
            raise ValueError(f"CSV path does not exist: {path}")
        if not os.path.isfile(path):
            raise ValueError(f"CSV path is not a file: {path}")
        if not path.lower().endswith(".csv"):
            raise ValueError("Only .csv files are supported.")

        # Basic safety: avoid accidentally loading giant files.
        size = os.path.getsize(path)
        if size > 10 * 1024 * 1024:
            raise ValueError("CSV file is too large (>10MB).")

        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            text = f.read()

        return LoadCsvPathOutput(csv_text=text, file_name=os.path.basename(path))

    def save_csv_path(self, payload: SaveCsvPathInput) -> SaveCsvPathOutput:
        raw = (payload.csv_path or "").strip()
        if not raw:
            raise ValueError("csv_path is required.")
        path = os.path.abspath(os.path.expanduser(os.path.expandvars(raw)))
        if not path.lower().endswith(".csv"):
            raise ValueError("Only .csv files are supported.")

        parent = os.path.dirname(path) or "."
        if not os.path.exists(parent):
            raise ValueError(f"Parent directory does not exist: {parent}")
        if not os.path.isdir(parent):
            raise ValueError(f"Parent path is not a directory: {parent}")

        text = payload.csv_text or ""
        data = text.encode("utf-8")
        with open(path, "wb") as f:
            f.write(data)

        return SaveCsvPathOutput(csv_path=path, bytes_written=len(data))

    def save_project(self, payload: SaveProjectInput) -> SaveProjectOutput:
        display_name = (payload.project_name or "").strip()
        if not display_name:
            raise ValueError("project_name is required.")

        registry_name = self._registry_key_from_display_name(display_name)
        if not registry_name:
            raise ValueError("project_name is invalid after normalization.")

        # Write CSV to a temp file then save the file path into the registry.
        fd, tmp_path = tempfile.mkstemp(prefix="kanlytics-project-", suffix=".csv")
        os.close(fd)
        try:
            Path(tmp_path).write_text(payload.csv_text or "", encoding="utf-8")
            self._project_registry.save(registry_name, Path(tmp_path), metadata={"display_name": display_name})
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

        return SaveProjectOutput(project_name=display_name, registry_name=registry_name)

    def load_project(self, payload: LoadProjectInput) -> LoadProjectOutput:
        display_name = (payload.project_name or "").strip()
        if not display_name:
            raise ValueError("project_name is required.")

        registry_name = self._resolve_registry_name(display_name)
        loaded_path = self._project_registry.load(registry_name, output_dir=payload.output_path)
        path_str = str(loaded_path)
        text = Path(path_str).read_text(encoding="utf-8-sig")
        return LoadProjectOutput(project_name=display_name, registry_name=registry_name, csv_text=text, csv_path=path_str)

    def list_projects(self, payload: ListProjectsInput) -> ListProjectsOutput:
        names: list[str] = []
        for obj_name in self._project_registry.list_objects():
            display = obj_name
            try:
                info = self._project_registry.info(obj_name) or {}
                # Prefer latest version metadata
                if info:
                    # versions are strings; try numeric max
                    versions = sorted(info.keys(), key=lambda s: int(s) if str(s).isdigit() else -1)
                    latest = info.get(versions[-1]) if versions else None
                    md = (latest or {}).get("metadata") or {}
                    display = md.get("display_name") or obj_name
            except Exception:
                display = obj_name
            names.append(str(display))
        # Stable display order
        names = sorted(set(names), key=lambda s: s.lower())
        return ListProjectsOutput(project_names=names)

    def create_plan(self, payload: CreatePlanInput) -> CreatePlanOutput:
        """
        Parse CSV text into a Gantt plan and store it server-side.
        """
        gantt = self._gantt_from_csv_text(payload.csv_text)
        if payload.project_name:
            pn = payload.project_name.strip()
            if pn:
                for t in gantt.tasks:
                    if not getattr(t, "project_name", None):
                        t.project_name = pn

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

    def get_critical_path(self, payload: CriticalPathInput) -> CriticalPathOutput:
        with self._lock:
            layout = self._layouts.get(payload.plan_id)

        if layout is None:
            raise ValueError(
                f"No layout found for plan_id={payload.plan_id}. "
                f"Did you call gantt.schedule first?"
            )

        critical_path = list((layout.get("meta") or {}).get("critical_path") or [])
        return CriticalPathOutput(plan_id=payload.plan_id, critical_path=critical_path)

    def connect_project(self, payload: ConnectProjectInput) -> ConnectProjectOutput:
        """
        Download ProjectV2 items (issues + draft issues), ensure each item has a stable
        "Task ID" (UUID) field, and return a V2 CSV representation suitable for loading
        into the Gantt planner.
        """
        client = GitHubProjectV2(payload.project_url)
        client.ensure_status_columns(options=STATUS_OPTIONS, default="Backlog")
        task_id_field_id = client.ensure_text_field("Task ID")

        tasks: list[GitHubIssue] = []
        for item in client.iter_items():
            item_id = item.get("id")
            content = item.get("content") or {}
            typename = content.get("__typename")
            if typename not in ("Issue", "DraftIssue"):
                continue
            if not item_id:
                continue

            task_id = client._get_text_field_value(item, "Task ID")
            if not task_id:
                task_id = new_uuid()
                client.set_text_field(item_id=item_id, field_id=task_id_field_id, text=task_id)

            status = client._get_single_select_value(item, "Status") or ""
            phase = client._get_text_field_value(item, "Phase") or ""
            deps_raw = client._get_text_field_value(item, "Dependencies") or ""
            display_id = client._get_text_field_value(item, "Display Task ID")
            wall_days_raw = client._get_text_field_value(item, "Wall Days") or ""
            billable_days_raw = client._get_text_field_value(item, "Billable Days") or ""
            project_name = client._get_text_field_value(item, "Project Name")
            start_date = client._get_date_field_value(item, "Start Date")
            end_date = client._get_date_field_value(item, "End Date")

            def _to_float(s: str, default: float) -> float:
                try:
                    return float(str(s).strip())
                except Exception:
                    return default

            deps = [d.strip() for d in deps_raw.split(",") if d.strip()]

            if typename == "Issue":
                labels = [n.get("name") for n in (content.get("labels") or {}).get("nodes", []) if (n or {}).get("name")]
                assignees = [n.get("login") for n in (content.get("assignees") or {}).get("nodes", []) if (n or {}).get("login")]
                number = content.get("number")
                issue = GitHubIssue(
                    task_id=task_id,
                    id=task_id,
                    display_task_id=(display_id or (str(number) if isinstance(number, int) else None)),
                    number=number if isinstance(number, int) else None,
                    title=content.get("title") or "",
                    body=content.get("body") or "",
                    state=(content.get("state") or "").lower() if content.get("state") else None,
                    created_at=content.get("createdAt"),
                    updated_at=content.get("updatedAt"),
                    closed_at=content.get("closedAt"),
                    url=content.get("url"),
                    labels=[l for l in labels if l],
                    assignees=[a for a in assignees if a],
                    phase=phase,
                    status=(status or "Backlog"),
                    Dependencies=",".join(deps),
                    wall_days=_to_float(wall_days_raw, 1.0),
                    billable_days=_to_float(billable_days_raw, 1.0),
                    project_name=project_name,
                    start_date=start_date,
                    end_date=end_date,
                )
            else:
                issue = GitHubIssue(
                    task_id=task_id,
                    id=task_id,
                    title=content.get("title") or "",
                    body=content.get("body") or "",
                    state="open",
                    created_at=content.get("createdAt"),
                    updated_at=content.get("updatedAt"),
                    phase=phase,
                    status=(status or "Backlog"),
                    Dependencies=",".join(deps),
                    wall_days=_to_float(wall_days_raw, 1.0),
                    billable_days=_to_float(billable_days_raw, 1.0),
                    project_name=project_name,
                    start_date=start_date,
                    end_date=end_date,
                )

            tasks.append(issue)

        gantt = Gantt(tasks)
        earliest = None
        for t in tasks:
            if getattr(t, "start_date", None) is None:
                continue
            sd = t.start_date
            earliest = sd if earliest is None else min(earliest, sd)
        return ConnectProjectOutput(
            task_count=len(tasks),
            csv_text=gantt.export_csv_v2(),
            project_start_date=None if earliest is None else earliest.isoformat(),
        )

    def connect_project_start(self, payload: ConnectProjectInput) -> StartJobOutput:
        """
        Start an async ProjectV2 connect job (for UI progress reporting).
        """
        job_id = str(uuid4())
        status = JobStatusOutput(job_id=job_id, state="queued", progress=0, message="Queued…")
        with self._lock:
            self._jobs[job_id] = status

        def run() -> None:
            try:
                self._job_update(job_id, state="running", progress=1, message="Connecting to project…")
                client = GitHubProjectV2(payload.project_url)
                self._job_update(job_id, progress=3, message="Normalizing Status columns…")
                client.ensure_status_columns(options=STATUS_OPTIONS, default="Backlog")
                self._job_update(job_id, progress=5, message="Ensuring Task ID field…")
                task_id_field_id = client.ensure_text_field("Task ID")

                self._job_update(job_id, progress=10, message="Downloading project items…")
                items = list(client.iter_items())

                tasks: list[GitHubIssue] = []
                total = max(1, len(items))
                for idx, item in enumerate(items):
                    # 10..90
                    pct = 10 + int((idx / total) * 80)
                    self._job_update(job_id, progress=pct, message=f"Importing items… ({idx+1}/{total})")

                    item_id = item.get("id")
                    content = item.get("content") or {}
                    typename = content.get("__typename")
                    if typename not in ("Issue", "DraftIssue") or not item_id:
                        continue

                    task_id = client._get_text_field_value(item, "Task ID")
                    if not task_id:
                        task_id = new_uuid()
                        client.set_text_field(item_id=item_id, field_id=task_id_field_id, text=task_id)

                    status_val = client._get_single_select_value(item, "Status") or ""
                    phase = client._get_text_field_value(item, "Phase") or ""
                    deps_raw = client._get_text_field_value(item, "Dependencies") or ""
                    display_id = client._get_text_field_value(item, "Display Task ID")
                    wall_days_raw = client._get_text_field_value(item, "Wall Days") or ""
                    billable_days_raw = client._get_text_field_value(item, "Billable Days") or ""
                    project_name = client._get_text_field_value(item, "Project Name")
                    start_date = client._get_date_field_value(item, "Start Date")
                    end_date = client._get_date_field_value(item, "End Date")

                    def _to_float(s: str, default: float) -> float:
                        try:
                            return float(str(s).strip())
                        except Exception:
                            return default

                    deps = [d.strip() for d in deps_raw.split(",") if d.strip()]

                    if typename == "Issue":
                        labels = [n.get("name") for n in (content.get("labels") or {}).get("nodes", []) if (n or {}).get("name")]
                        assignees = [n.get("login") for n in (content.get("assignees") or {}).get("nodes", []) if (n or {}).get("login")]
                        number = content.get("number")
                        issue = GitHubIssue(
                            task_id=task_id,
                            id=task_id,
                            display_task_id=(display_id or (str(number) if isinstance(number, int) else None)),
                            number=number if isinstance(number, int) else None,
                            title=content.get("title") or "",
                            body=content.get("body") or "",
                            state=(content.get("state") or "").lower() if content.get("state") else None,
                            created_at=content.get("createdAt"),
                            updated_at=content.get("updatedAt"),
                            closed_at=content.get("closedAt"),
                            url=content.get("url"),
                            labels=[l for l in labels if l],
                            assignees=[a for a in assignees if a],
                            phase=phase,
                            status=(status_val or "Backlog"),
                            Dependencies=",".join(deps),
                            wall_days=_to_float(wall_days_raw, 1.0),
                            billable_days=_to_float(billable_days_raw, 1.0),
                            project_name=project_name,
                            start_date=start_date,
                            end_date=end_date,
                        )
                    else:
                        issue = GitHubIssue(
                            task_id=task_id,
                            id=task_id,
                            title=content.get("title") or "",
                            body=content.get("body") or "",
                            state="open",
                            created_at=content.get("createdAt"),
                            updated_at=content.get("updatedAt"),
                            phase=phase,
                            status=(status_val or "Backlog"),
                            Dependencies=",".join(deps),
                            wall_days=_to_float(wall_days_raw, 1.0),
                            billable_days=_to_float(billable_days_raw, 1.0),
                            project_name=project_name,
                            start_date=start_date,
                            end_date=end_date,
                        )

                    tasks.append(issue)

                self._job_update(job_id, progress=92, message="Generating CSV…")
                gantt = Gantt(tasks)
                csv_text = gantt.export_csv_v2()
                earliest = None
                for t in tasks:
                    if getattr(t, "start_date", None) is None:
                        continue
                    sd = t.start_date
                    earliest = sd if earliest is None else min(earliest, sd)
                self._job_update(
                    job_id,
                    state="completed",
                    progress=100,
                    message="Done.",
                    result={
                        "task_count": len(tasks),
                        "csv_text": csv_text,
                        "project_start_date": None if earliest is None else earliest.isoformat(),
                    },
                )
            except Exception as e:
                self._job_update(job_id, state="failed", progress=100, message="Failed.", error=str(e))

        threading.Thread(target=run, daemon=True).start()
        return StartJobOutput(job_id=job_id)

    def export_project(self, payload: ExportProjectInput) -> ExportProjectOutput:
        """
        Export the currently-loaded plan to a GitHub ProjectV2 board.

        Behavior:
          - If a task matches an existing project item via "Task ID", we update it
            (Issue: PATCH via REST; DraftIssue: updateProjectV2DraftIssue).
          - If a task doesn't exist remotely:
              - If it has a GitHub `url`, add that issue to the project and update it.
              - Otherwise, create a ProjectV2 draft issue.
          - Always ensure the ProjectV2 item has the "Task ID" field populated.
        """
        with self._lock:
            gantt = self._plans.get(payload.plan_id)
            layout = self._layouts.get(payload.plan_id)

        if gantt is None:
            raise ValueError(f"Unknown plan_id: {payload.plan_id}")
        if layout is None:
            raise ValueError(f"No layout found for plan_id={payload.plan_id}. Did you call gantt.schedule first?")

        schedule_by_id: dict[str, dict[str, str]] = {}
        for t in (layout.get("tasks") or []):
            tid = t.get("id")
            sch = t.get("schedule") or {}
            if tid and sch.get("start") and sch.get("end"):
                schedule_by_id[tid] = {"start": sch["start"], "end": sch["end"]}

        client = GitHubProjectV2(payload.project_url)
        status_field_id, status_option_ids = client.ensure_status_columns(options=STATUS_OPTIONS, default="Backlog")
        task_id_field_id = client.ensure_text_field("Task ID")
        display_id_field_id = client.ensure_text_field("Display Task ID")
        phase_field_id = client.ensure_text_field("Phase")
        deps_field_id = client.ensure_text_field("Dependencies")
        wall_days_field_id = client.ensure_text_field("Wall Days")
        billable_days_field_id = client.ensure_text_field("Billable Days")
        start_date_field_id = client.ensure_date_field("Start Date")
        end_date_field_id = client.ensure_date_field("End Date")
        project_name_field_id = client.ensure_text_field("Project Name")

        by_task_id: dict[str, dict[str, Any]] = {}
        by_issue_url: dict[str, dict[str, Any]] = {}

        for item in client.iter_items():
            item_id = item.get("id")
            content = item.get("content") or {}
            typename = content.get("__typename")
            if typename not in ("Issue", "DraftIssue") or not item_id:
                continue

            record = {
                "item_id": item_id,
                "type": typename,
                "issue_url": content.get("url") if typename == "Issue" else None,
                "issue_node_id": content.get("id") if typename == "Issue" else None,
                "draft_issue_id": content.get("id") if typename == "DraftIssue" else None,
            }

            task_id = client._get_text_field_value(item, "Task ID")
            if task_id:
                by_task_id[task_id] = record
            if record.get("issue_url"):
                by_issue_url[record["issue_url"]] = record

        out = ExportProjectOutput()

        issue_repo = (payload.issue_repo or "").strip() or None

        for t in gantt.tasks:
            task_id = (t.task_id or t.id or "").strip()
            if not task_id:
                task_id = new_uuid()

            title = (t.title or t.name or "").strip()
            body = (t.body or t.details or "").strip()
            labels = list(t.labels or [])
            assignees = list(t.assignees or [])

            rec = by_task_id.get(task_id) or (by_issue_url.get(t.url) if t.url else None)

            try:
                desired_status = (getattr(t, "status", None) or "").strip() or "Backlog"
                if desired_status not in status_option_ids:
                    desired_status = "Backlog"
                sch = schedule_by_id.get(t.id) or {}
                sch_start = sch.get("start")
                sch_end = sch.get("end")
                project_name_value = (payload.project_name or getattr(t, "project_name", None) or "").strip()
                if rec:
                    # Ensure field is set (idempotent).
                    client.set_text_field(item_id=rec["item_id"], field_id=task_id_field_id, text=task_id)
                    if project_name_field_id:
                        if project_name_value:
                            client.set_text_field(item_id=rec["item_id"], field_id=project_name_field_id, text=project_name_value)
                    if getattr(t, "display_task_id", None):
                        client.set_text_field(item_id=rec["item_id"], field_id=display_id_field_id, text=str(t.display_task_id))
                    client.set_text_field(item_id=rec["item_id"], field_id=phase_field_id, text=(t.phase or ""))
                    client.set_text_field(item_id=rec["item_id"], field_id=deps_field_id, text=",".join(t.dependencies or []))
                    client.set_text_field(item_id=rec["item_id"], field_id=wall_days_field_id, text=str(t.wall_days or 0))
                    client.set_text_field(item_id=rec["item_id"], field_id=billable_days_field_id, text=str(t.billable_days or 0))
                    client.set_single_select_field(item_id=rec["item_id"], field_id=status_field_id, option_id=status_option_ids[desired_status])
                    if sch_start:
                        client.set_date_field(item_id=rec["item_id"], field_id=start_date_field_id, date=sch_start)
                    if sch_end:
                        client.set_date_field(item_id=rec["item_id"], field_id=end_date_field_id, date=sch_end)

                    if rec["type"] == "Issue":
                        issue_url = t.url or rec.get("issue_url")
                        if issue_url:
                            owner, repo, _ = client.parse_issue_url(issue_url)
                            labels_safe = client.ensure_labels_exist(repo=f"{owner}/{repo}", labels=labels)
                            client.update_issue_rest(
                                issue_url=issue_url,
                                title=title or "(untitled)",
                                body=body,
                                labels=labels_safe,
                                assignees=assignees,
                            )
                            out.updated_issues += 1
                    else:
                        draft_id = rec.get("draft_issue_id")
                        if draft_id:
                            client.update_draft_issue(draft_issue_id=draft_id, title=title or "(untitled)", body=body)
                            out.updated_draft_issues += 1
                else:
                    # New item: add issue (if URL) or create draft issue.
                    if t.url:
                        owner, repo, number = client.parse_issue_url(t.url)
                        issue_node_id = client.resolve_issue_node_id(owner=owner, repo=repo, number=number)
                        item_id = client.add_issue_item(issue_node_id=issue_node_id)
                        client.set_text_field(item_id=item_id, field_id=task_id_field_id, text=task_id)
                        if project_name_field_id:
                            if project_name_value:
                                client.set_text_field(item_id=item_id, field_id=project_name_field_id, text=project_name_value)
                        if getattr(t, "display_task_id", None):
                            client.set_text_field(item_id=item_id, field_id=display_id_field_id, text=str(t.display_task_id))
                        client.set_text_field(item_id=item_id, field_id=phase_field_id, text=(t.phase or ""))
                        client.set_text_field(item_id=item_id, field_id=deps_field_id, text=",".join(t.dependencies or []))
                        client.set_text_field(item_id=item_id, field_id=wall_days_field_id, text=str(t.wall_days or 0))
                        client.set_text_field(item_id=item_id, field_id=billable_days_field_id, text=str(t.billable_days or 0))
                        client.set_single_select_field(item_id=item_id, field_id=status_field_id, option_id=status_option_ids[desired_status])
                        if sch_start:
                            client.set_date_field(item_id=item_id, field_id=start_date_field_id, date=sch_start)
                        if sch_end:
                            client.set_date_field(item_id=item_id, field_id=end_date_field_id, date=sch_end)
                        out.added_existing_issues += 1
                        # best-effort update to match local fields
                        labels_safe = client.ensure_labels_exist(repo=f"{owner}/{repo}", labels=labels)
                        client.update_issue_rest(
                            issue_url=t.url,
                            title=title or "(untitled)",
                            body=body,
                            labels=labels_safe,
                            assignees=assignees,
                        )
                        out.updated_issues += 1
                    elif issue_repo:
                        # Create a real repo issue, add to project, then update fields.
                        labels_safe = client.ensure_labels_exist(repo=issue_repo, labels=labels)
                        created_url = client.create_issue_rest(
                            repo=issue_repo,
                            title=title or "(untitled)",
                            body=body,
                            labels=labels_safe,
                            assignees=assignees,
                        )
                        owner, repo, number = client.parse_issue_url(created_url)
                        issue_node_id = client.resolve_issue_node_id(owner=owner, repo=repo, number=number)
                        item_id = client.add_issue_item(issue_node_id=issue_node_id)
                        client.set_text_field(item_id=item_id, field_id=task_id_field_id, text=task_id)
                        if project_name_field_id:
                            if project_name_value:
                                client.set_text_field(item_id=item_id, field_id=project_name_field_id, text=project_name_value)
                        if getattr(t, "display_task_id", None):
                            client.set_text_field(item_id=item_id, field_id=display_id_field_id, text=str(t.display_task_id))
                        client.set_text_field(item_id=item_id, field_id=phase_field_id, text=(t.phase or ""))
                        client.set_text_field(item_id=item_id, field_id=deps_field_id, text=",".join(t.dependencies or []))
                        client.set_text_field(item_id=item_id, field_id=wall_days_field_id, text=str(t.wall_days or 0))
                        client.set_text_field(item_id=item_id, field_id=billable_days_field_id, text=str(t.billable_days or 0))
                        client.set_single_select_field(item_id=item_id, field_id=status_field_id, option_id=status_option_ids[desired_status])
                        if sch_start:
                            client.set_date_field(item_id=item_id, field_id=start_date_field_id, date=sch_start)
                        if sch_end:
                            client.set_date_field(item_id=item_id, field_id=end_date_field_id, date=sch_end)
                        out.added_existing_issues += 1
                        out.updated_issues += 1
                    else:
                        item_id = client.add_draft_issue(title=title or "(untitled)", body=body)
                        client.set_text_field(item_id=item_id, field_id=task_id_field_id, text=task_id)
                        if project_name_field_id:
                            if project_name_value:
                                client.set_text_field(item_id=item_id, field_id=project_name_field_id, text=project_name_value)
                        if getattr(t, "display_task_id", None):
                            client.set_text_field(item_id=item_id, field_id=display_id_field_id, text=str(t.display_task_id))
                        client.set_text_field(item_id=item_id, field_id=phase_field_id, text=(t.phase or ""))
                        client.set_text_field(item_id=item_id, field_id=deps_field_id, text=",".join(t.dependencies or []))
                        client.set_text_field(item_id=item_id, field_id=wall_days_field_id, text=str(t.wall_days or 0))
                        client.set_text_field(item_id=item_id, field_id=billable_days_field_id, text=str(t.billable_days or 0))
                        client.set_single_select_field(item_id=item_id, field_id=status_field_id, option_id=status_option_ids[desired_status])
                        if sch_start:
                            client.set_date_field(item_id=item_id, field_id=start_date_field_id, date=sch_start)
                        if sch_end:
                            client.set_date_field(item_id=item_id, field_id=end_date_field_id, date=sch_end)
                        out.created_draft_issues += 1
            except Exception as e:
                out.errors.append(f"{task_id}: {e}")

        return out

    def export_project_start(self, payload: ExportProjectInput) -> StartJobOutput:
        """
        Start an async ProjectV2 export job (for UI progress reporting).
        """
        job_id = str(uuid4())
        status = JobStatusOutput(job_id=job_id, state="queued", progress=0, message="Queued…")
        with self._lock:
            self._jobs[job_id] = status

        def run() -> None:
            try:
                self._job_update(job_id, state="running", progress=1, message="Preparing export…")

                with self._lock:
                    gantt = self._plans.get(payload.plan_id)
                    layout = self._layouts.get(payload.plan_id)
                if gantt is None:
                    raise ValueError(f"Unknown plan_id: {payload.plan_id}")
                if layout is None:
                    raise ValueError(f"No layout found for plan_id={payload.plan_id}. Did you call gantt.schedule first?")

                schedule_by_id: dict[str, dict[str, str]] = {}
                for t in (layout.get("tasks") or []):
                    tid = t.get("id")
                    sch = t.get("schedule") or {}
                    if tid and sch.get("start") and sch.get("end"):
                        schedule_by_id[tid] = {"start": sch["start"], "end": sch["end"]}

                client = GitHubProjectV2(payload.project_url)
                issue_repo = (payload.issue_repo or "").strip() or None
                self._job_update(job_id, progress=3, message="Normalizing Status columns…")
                status_field_id, status_option_ids = client.ensure_status_columns(options=STATUS_OPTIONS, default="Backlog")
                self._job_update(job_id, progress=5, message="Ensuring Task ID field…")
                task_id_field_id = client.ensure_text_field("Task ID")
                start_date_field_id = client.ensure_date_field("Start Date")
                end_date_field_id = client.ensure_date_field("End Date")
                display_id_field_id = client.ensure_text_field("Display Task ID")
                phase_field_id = client.ensure_text_field("Phase")
                deps_field_id = client.ensure_text_field("Dependencies")
                wall_days_field_id = client.ensure_text_field("Wall Days")
                billable_days_field_id = client.ensure_text_field("Billable Days")
                project_name_field_id = client.ensure_text_field("Project Name")

                self._job_update(job_id, progress=12, message="Loading existing project items…")
                items = list(client.iter_items())

                by_task_id: dict[str, dict[str, Any]] = {}
                by_issue_url: dict[str, dict[str, Any]] = {}
                for item in items:
                    item_id = item.get("id")
                    content = item.get("content") or {}
                    typename = content.get("__typename")
                    if typename not in ("Issue", "DraftIssue") or not item_id:
                        continue

                    record = {
                        "item_id": item_id,
                        "type": typename,
                        "issue_url": content.get("url") if typename == "Issue" else None,
                        "issue_node_id": content.get("id") if typename == "Issue" else None,
                        "draft_issue_id": content.get("id") if typename == "DraftIssue" else None,
                    }

                    task_id = client._get_text_field_value(item, "Task ID")
                    if task_id:
                        by_task_id[task_id] = record
                    if record.get("issue_url"):
                        by_issue_url[record["issue_url"]] = record

                out = ExportProjectOutput()
                total = max(1, len(gantt.tasks))
                for idx, t in enumerate(gantt.tasks):
                    pct = 15 + int((idx / total) * 80)  # 15..95
                    self._job_update(job_id, progress=pct, message=f"Exporting tasks… ({idx+1}/{total})")

                    task_id = (t.task_id or t.id or "").strip()
                    if not task_id:
                        task_id = new_uuid()

                    title = (t.title or t.name or "").strip()
                    body = (t.body or t.details or "").strip()
                    labels = list(t.labels or [])
                    assignees = list(t.assignees or [])

                    rec = by_task_id.get(task_id) or (by_issue_url.get(t.url) if t.url else None)

                    try:
                        desired_status = (getattr(t, "status", None) or "").strip() or "Backlog"
                        if desired_status not in status_option_ids:
                            desired_status = "Backlog"
                        sch = schedule_by_id.get(t.id) or {}
                        sch_start = sch.get("start")
                        sch_end = sch.get("end")
                        project_name_value = (payload.project_name or getattr(t, "project_name", None) or "").strip()
                        if rec:
                            client.set_text_field(item_id=rec["item_id"], field_id=task_id_field_id, text=task_id)
                            if project_name_field_id:
                                if project_name_value:
                                    client.set_text_field(item_id=rec["item_id"], field_id=project_name_field_id, text=project_name_value)
                            if getattr(t, "display_task_id", None):
                                client.set_text_field(item_id=rec["item_id"], field_id=display_id_field_id, text=str(t.display_task_id))
                            client.set_text_field(item_id=rec["item_id"], field_id=phase_field_id, text=(t.phase or ""))
                            client.set_text_field(item_id=rec["item_id"], field_id=deps_field_id, text=",".join(t.dependencies or []))
                            client.set_text_field(item_id=rec["item_id"], field_id=wall_days_field_id, text=str(t.wall_days or 0))
                            client.set_text_field(item_id=rec["item_id"], field_id=billable_days_field_id, text=str(t.billable_days or 0))
                            client.set_single_select_field(item_id=rec["item_id"], field_id=status_field_id, option_id=status_option_ids[desired_status])
                            if sch_start:
                                client.set_date_field(item_id=rec["item_id"], field_id=start_date_field_id, date=sch_start)
                            if sch_end:
                                client.set_date_field(item_id=rec["item_id"], field_id=end_date_field_id, date=sch_end)

                            if rec["type"] == "Issue":
                                issue_url = t.url or rec.get("issue_url")
                                if issue_url:
                                    owner, repo, _ = client.parse_issue_url(issue_url)
                                    labels_safe = client.ensure_labels_exist(repo=f"{owner}/{repo}", labels=labels)
                                    client.update_issue_rest(
                                        issue_url=issue_url,
                                        title=title or "(untitled)",
                                        body=body,
                                        labels=labels_safe,
                                        assignees=assignees,
                                    )
                                    out.updated_issues += 1
                            else:
                                draft_id = rec.get("draft_issue_id")
                                if draft_id:
                                    client.update_draft_issue(draft_issue_id=draft_id, title=title or "(untitled)", body=body)
                                    out.updated_draft_issues += 1
                        else:
                            if t.url:
                                owner, repo, number = client.parse_issue_url(t.url)
                                issue_node_id = client.resolve_issue_node_id(owner=owner, repo=repo, number=number)
                                item_id = client.add_issue_item(issue_node_id=issue_node_id)
                                client.set_text_field(item_id=item_id, field_id=task_id_field_id, text=task_id)
                                if project_name_field_id and project_name_value:
                                    client.set_text_field(item_id=item_id, field_id=project_name_field_id, text=project_name_value)
                                if getattr(t, "display_task_id", None):
                                    client.set_text_field(item_id=item_id, field_id=display_id_field_id, text=str(t.display_task_id))
                                client.set_text_field(item_id=item_id, field_id=phase_field_id, text=(t.phase or ""))
                                client.set_text_field(item_id=item_id, field_id=deps_field_id, text=",".join(t.dependencies or []))
                                client.set_text_field(item_id=item_id, field_id=wall_days_field_id, text=str(t.wall_days or 0))
                                client.set_text_field(item_id=item_id, field_id=billable_days_field_id, text=str(t.billable_days or 0))
                                client.set_single_select_field(item_id=item_id, field_id=status_field_id, option_id=status_option_ids[desired_status])
                                if sch_start:
                                    client.set_date_field(item_id=item_id, field_id=start_date_field_id, date=sch_start)
                                if sch_end:
                                    client.set_date_field(item_id=item_id, field_id=end_date_field_id, date=sch_end)
                                out.added_existing_issues += 1
                                labels_safe = client.ensure_labels_exist(repo=f"{owner}/{repo}", labels=labels)
                                client.update_issue_rest(
                                    issue_url=t.url,
                                    title=title or "(untitled)",
                                    body=body,
                                    labels=labels_safe,
                                    assignees=assignees,
                                )
                                out.updated_issues += 1
                            else:
                                if issue_repo:
                                    labels_safe = client.ensure_labels_exist(repo=issue_repo, labels=labels)
                                    created_url = client.create_issue_rest(
                                        repo=issue_repo,
                                        title=title or "(untitled)",
                                        body=body,
                                        labels=labels_safe,
                                        assignees=assignees,
                                    )
                                    owner, repo, number = client.parse_issue_url(created_url)
                                    issue_node_id = client.resolve_issue_node_id(owner=owner, repo=repo, number=number)
                                    item_id = client.add_issue_item(issue_node_id=issue_node_id)
                                    client.set_text_field(item_id=item_id, field_id=task_id_field_id, text=task_id)
                                    if project_name_field_id and project_name_value:
                                        client.set_text_field(item_id=item_id, field_id=project_name_field_id, text=project_name_value)
                                    if getattr(t, "display_task_id", None):
                                        client.set_text_field(item_id=item_id, field_id=display_id_field_id, text=str(t.display_task_id))
                                    client.set_text_field(item_id=item_id, field_id=phase_field_id, text=(t.phase or ""))
                                    client.set_text_field(item_id=item_id, field_id=deps_field_id, text=",".join(t.dependencies or []))
                                    client.set_text_field(item_id=item_id, field_id=wall_days_field_id, text=str(t.wall_days or 0))
                                    client.set_text_field(item_id=item_id, field_id=billable_days_field_id, text=str(t.billable_days or 0))
                                    client.set_single_select_field(item_id=item_id, field_id=status_field_id, option_id=status_option_ids[desired_status])
                                    if sch_start:
                                        client.set_date_field(item_id=item_id, field_id=start_date_field_id, date=sch_start)
                                    if sch_end:
                                        client.set_date_field(item_id=item_id, field_id=end_date_field_id, date=sch_end)
                                    out.added_existing_issues += 1
                                    out.updated_issues += 1
                                else:
                                    item_id = client.add_draft_issue(title=title or "(untitled)", body=body)
                                    client.set_text_field(item_id=item_id, field_id=task_id_field_id, text=task_id)
                                    if project_name_field_id and project_name_value:
                                        client.set_text_field(item_id=item_id, field_id=project_name_field_id, text=project_name_value)
                                    if getattr(t, "display_task_id", None):
                                        client.set_text_field(item_id=item_id, field_id=display_id_field_id, text=str(t.display_task_id))
                                    client.set_text_field(item_id=item_id, field_id=phase_field_id, text=(t.phase or ""))
                                    client.set_text_field(item_id=item_id, field_id=deps_field_id, text=",".join(t.dependencies or []))
                                    client.set_text_field(item_id=item_id, field_id=wall_days_field_id, text=str(t.wall_days or 0))
                                    client.set_text_field(item_id=item_id, field_id=billable_days_field_id, text=str(t.billable_days or 0))
                                    client.set_single_select_field(item_id=item_id, field_id=status_field_id, option_id=status_option_ids[desired_status])
                                    if sch_start:
                                        client.set_date_field(item_id=item_id, field_id=start_date_field_id, date=sch_start)
                                    if sch_end:
                                        client.set_date_field(item_id=item_id, field_id=end_date_field_id, date=sch_end)
                                    out.created_draft_issues += 1
                    except Exception as e:
                        out.errors.append(f"{task_id}: {e}")

                self._job_update(job_id, progress=98, message="Finalizing…")
                # tiny delay so UI can show "finalizing" state
                time.sleep(0.1)
                self._job_update(
                    job_id,
                    state="completed",
                    progress=100,
                    message="Done.",
                    result={
                        "updated_issues": out.updated_issues,
                        "updated_draft_issues": out.updated_draft_issues,
                        "created_draft_issues": out.created_draft_issues,
                        "added_existing_issues": out.added_existing_issues,
                        "errors": out.errors,
                    },
                )
            except Exception as e:
                self._job_update(job_id, state="failed", progress=100, message="Failed.", error=str(e))

        threading.Thread(target=run, daemon=True).start()
        return StartJobOutput(job_id=job_id)

    def job_status(self, payload: JobStatusInput) -> JobStatusOutput:
        with self._lock:
            st = self._jobs.get(payload.job_id)
        if st is None:
            raise ValueError(f"Unknown job_id: {payload.job_id}")
        return st

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

    def _job_update(
        self,
        job_id: str,
        *,
        state: Optional[Literal["queued", "running", "completed", "failed"]] = None,
        progress: Optional[int] = None,
        message: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        with self._lock:
            cur = self._jobs.get(job_id)
            if cur is None:
                return
            data = cur.model_dump()
            if state is not None:
                data["state"] = state
            if progress is not None:
                data["progress"] = int(progress)
            if message is not None:
                data["message"] = message
            if result is not None:
                data["result"] = result
            if error is not None:
                data["error"] = error
            self._jobs[job_id] = JobStatusOutput(**data)
