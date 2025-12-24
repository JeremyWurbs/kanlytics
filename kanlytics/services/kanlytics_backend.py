# kanlytics_backend.py

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
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

from kanlytics.gantt import Gantt
from kanlytics.core.github_issue import GitHubIssue
from kanlytics.core.github_project_v2 import GitHubProjectV2, new_uuid

STATUS_OPTIONS = ["Backlog", "Planned", "In Progress", "In Review", "Done"]
PHASE_META_MARKER = "<!-- kanlytics:phase-meta -->"

# CSV Metadata header marker - indicates end of metadata and start of CSV data
CSV_METADATA_END_MARKER = "# ---"

# Reserved metadata field keys
METADATA_FIELDS = [
    "Project Name",
    "Project Hash",
    "Project Manager",
    "Tech Lead",
    "Client",
]


# ----------------------------
# CSV Metadata Helpers
# ----------------------------

def parse_csv_metadata(csv_text: str) -> tuple[dict[str, str], str]:
    """
    Parse metadata headers from CSV text.
    
    Metadata lines start with '# ' followed by 'Key: Value'.
    The marker '# ---' indicates end of metadata section.
    
    Returns:
        (metadata_dict, csv_body) - metadata as dict and remaining CSV text
    """
    metadata: dict[str, str] = {}
    lines = csv_text.split("\n")
    csv_start_idx = 0
    
    for i, line in enumerate(lines):
        stripped = line.strip()
        
        # End of metadata marker
        if stripped == CSV_METADATA_END_MARKER.strip():
            csv_start_idx = i + 1
            break
        
        # Metadata line: "# Key: Value"
        if stripped.startswith("# ") and ":" in stripped:
            content = stripped[2:]  # Remove "# " prefix
            colon_idx = content.index(":")
            key = content[:colon_idx].strip()
            value = content[colon_idx + 1:].strip()
            if key in METADATA_FIELDS:
                metadata[key] = value
            continue
        
        # Non-metadata line (could be empty or start of CSV)
        # If we hit a non-comment, non-empty line, that's where CSV starts
        if stripped and not stripped.startswith("#"):
            csv_start_idx = i
            break
        
        # Empty line or other comment - keep looking
        if not stripped:
            continue
    
    csv_body = "\n".join(lines[csv_start_idx:])
    return metadata, csv_body


def write_csv_with_metadata(metadata: dict[str, str], csv_body: str) -> str:
    """
    Write CSV text with metadata headers prepended.
    
    Args:
        metadata: Dict of metadata key-value pairs
        csv_body: The CSV content (without metadata headers)
    
    Returns:
        Complete CSV text with metadata headers
    """
    lines: list[str] = []
    
    # Write metadata in defined order
    for key in METADATA_FIELDS:
        value = metadata.get(key, "")
        if value:
            lines.append(f"# {key}: {value}")
    
    # Add end marker if we have any metadata
    if lines:
        lines.append(CSV_METADATA_END_MARKER)
    
    # Add CSV body
    if csv_body.strip():
        lines.append(csv_body.strip())
    
    return "\n".join(lines) + "\n" if lines else ""


def ensure_project_hash(metadata: dict[str, str]) -> dict[str, str]:
    """Ensure metadata has a Project Hash, generating one if missing."""
    if not metadata.get("Project Hash"):
        metadata["Project Hash"] = str(uuid4())
    return metadata


# ----------------------------
# Pydantic Schemas
# ----------------------------

class ProjectMetadata(BaseModel):
    """Project-level metadata stored in CSV headers."""
    project_name: Optional[str] = Field(default=None, alias="Project Name")
    project_hash: Optional[str] = Field(default=None, alias="Project Hash")
    project_manager: Optional[str] = Field(default=None, alias="Project Manager")
    tech_lead: Optional[str] = Field(default=None, alias="Tech Lead")
    client: Optional[str] = Field(default=None, alias="Client")
    
    class Config:
        populate_by_name = True
    
    @classmethod
    def from_dict(cls, d: dict[str, str]) -> "ProjectMetadata":
        return cls(
            project_name=d.get("Project Name"),
            project_hash=d.get("Project Hash"),
            project_manager=d.get("Project Manager"),
            tech_lead=d.get("Tech Lead"),
            client=d.get("Client"),
        )
    
    def to_dict(self) -> dict[str, str]:
        result: dict[str, str] = {}
        if self.project_name:
            result["Project Name"] = self.project_name
        if self.project_hash:
            result["Project Hash"] = self.project_hash
        if self.project_manager:
            result["Project Manager"] = self.project_manager
        if self.tech_lead:
            result["Tech Lead"] = self.tech_lead
        if self.client:
            result["Client"] = self.client
        return result

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
    metadata: Optional[ProjectMetadata] = Field(
        default=None,
        description="Project metadata extracted from CSV headers.",
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


class AppendTaskInput(BaseModel):
    csv_text: str = Field(..., description="Current project CSV text (V2).")
    project_name: Optional[str] = Field(default=None, description="Optional project name to stamp into the new task row.")
    phase: str = Field(..., description="Phase name for the new task.")
    title: str = Field(..., description="Task title.")
    body: Optional[str] = Field(default=None, description="Task description/body (markdown).")
    acceptance_criteria: Optional[str] = Field(default=None, description="Acceptance criteria (markdown).")
    dependencies: list[str] = Field(default_factory=list, description="List of dependency Task IDs (UUID strings).")
    wall_days: float = Field(default=1.0, ge=0.0, description="Wall days duration.")
    billable_days: float = Field(default=1.0, ge=0.0, description="Billable days duration.")
    status: Optional[str] = Field(default=None, description="Status column value (Backlog/Planned/In Progress/In Review/Done).")
    repo: Optional[str] = Field(default=None, description="Repo for this issue (owner/repo). Defaults to project default repo.")
    phase_major: Optional[int] = Field(default=None, ge=0, description="Optional major number for phase display IDs (e.g. 6 for 6.1).")


class AppendTaskOutput(BaseModel):
    csv_text: str = Field(..., description="Updated project CSV text with the new task appended.")
    task_id: str = Field(..., description="Generated Task ID (UUID) for the new task.")

class UpdateTaskInput(BaseModel):
    csv_text: str = Field(..., description="Current project CSV text (V2).")
    task_id: str = Field(..., description="Task ID (UUID) to update.")
    title: Optional[str] = None
    body: Optional[str] = None
    acceptance_criteria: Optional[str] = None
    dependencies: Optional[list[str]] = None
    wall_days: Optional[float] = Field(default=None, ge=0.0)
    billable_days: Optional[float] = Field(default=None, ge=0.0)
    status: Optional[str] = None
    repo: Optional[str] = None


class UpdateTaskOutput(BaseModel):
    csv_text: str


class DeleteTaskInput(BaseModel):
    csv_text: str = Field(..., description="Current project CSV text (V2).")
    task_id: str = Field(..., description="Task ID (UUID) to delete.")


class DeleteTaskOutput(BaseModel):
    csv_text: str
    removed_task_ids: list[str] = Field(default_factory=list, description="List of removed Task IDs (always includes requested id).")


class UpdateMetadataInput(BaseModel):
    """Update project metadata in CSV text."""
    csv_text: str = Field(..., description="Current project CSV text (may or may not have metadata headers).")
    project_name: Optional[str] = Field(default=None, description="Project name.")
    project_hash: Optional[str] = Field(default=None, description="Project UUID hash (auto-generated if not provided).")
    project_manager: Optional[str] = Field(default=None, description="Project manager name.")
    tech_lead: Optional[str] = Field(default=None, description="Tech lead name.")
    client: Optional[str] = Field(default=None, description="Client name.")


class UpdateMetadataOutput(BaseModel):
    csv_text: str = Field(..., description="Updated CSV text with metadata headers.")
    metadata: ProjectMetadata = Field(..., description="The updated metadata.")


class GetMetadataInput(BaseModel):
    """Extract project metadata from CSV text."""
    csv_text: str = Field(..., description="Project CSV text (may or may not have metadata headers).")


class GetMetadataOutput(BaseModel):
    metadata: ProjectMetadata = Field(..., description="Extracted metadata (empty fields if not present).")
    csv_body: str = Field(..., description="CSV text without metadata headers.")


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

class GetPhaseMetaInput(BaseModel):
    project_url: str = Field(..., description="GitHub ProjectV2 board URL.")
    phase: str = Field(..., description="Phase name to fetch the meta issue for.")
    issue_repo: Optional[str] = Field(
        default=None,
        description="Optional target repo ('owner/repo' or URL) for creating the phase meta issue if missing.",
    )


class GetPhaseMetaOutput(BaseModel):
    phase: str
    task_id: str
    item_id: str
    type: str
    issue_url: Optional[str] = None
    title: str
    description: str
    body: str


class UpdatePhaseMetaInput(BaseModel):
    project_url: str = Field(..., description="GitHub ProjectV2 board URL.")
    phase: str = Field(..., description="Phase name whose meta issue to update.")
    description: str = Field(default="", description="Editable phase description/notes (markdown). Task list is auto-generated.")
    issue_repo: Optional[str] = Field(
        default=None,
        description="Optional target repo ('owner/repo' or URL) for creating the phase meta issue if missing.",
    )


class UpdatePhaseMetaOutput(GetPhaseMetaOutput):
    pass


class GetPhaseMetaCsvInput(BaseModel):
    repo: str = Field(..., description="Default repo for the project (owner/repo).")
    project_name: str = Field(..., description="Project name (used to scope deterministic phase meta IDs).")
    csv_text: str = Field(..., description="Current project CSV text (V2).")
    phase: str = Field(..., description="Phase name to fetch the meta issue for.")


class GetPhaseMetaCsvOutput(GetPhaseMetaOutput):
    pass


class UpdatePhaseMetaCsvInput(BaseModel):
    repo: str = Field(..., description="Default repo for the project (owner/repo).")
    project_name: str = Field(..., description="Project name (used to scope deterministic phase meta IDs).")
    csv_text: str = Field(..., description="Current project CSV text (V2).")
    phase: str = Field(..., description="Phase name to update.")
    description: str = Field(default="", description="Editable phase description/notes (markdown). Task list is auto-generated.")


class UpdatePhaseMetaCsvOutput(GetPhaseMetaOutput):
    pass

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

append_task_task = TaskSchema(
    name="gantt.append_task",
    input_schema=AppendTaskInput,
    output_schema=AppendTaskOutput,
)

update_task_task = TaskSchema(
    name="gantt.update_task",
    input_schema=UpdateTaskInput,
    output_schema=UpdateTaskOutput,
)

delete_task_task = TaskSchema(
    name="gantt.delete_task",
    input_schema=DeleteTaskInput,
    output_schema=DeleteTaskOutput,
)

get_metadata_task = TaskSchema(
    name="gantt.get_metadata",
    input_schema=GetMetadataInput,
    output_schema=GetMetadataOutput,
)

update_metadata_task = TaskSchema(
    name="gantt.update_metadata",
    input_schema=UpdateMetadataInput,
    output_schema=UpdateMetadataOutput,
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


class TimelineStatusInput(BaseModel):
    plan_id: str
    current_date: Optional[str] = Field(
        default=None,
        description="Current date in ISO format YYYY-MM-DD. Defaults to today if not provided.",
    )


class TaskTimelineStatus(BaseModel):
    task_id: str
    display_task_id: Optional[str] = None
    name: str
    phase: Optional[str] = None
    status: str = Field(..., description="Original task status (Backlog, Planned, In Progress, In Review, Done).")
    timeline_status: Literal["Scheduled", "In Development", "Delayed", "Critically Delayed", "Complete"] = Field(
        ...,
        description="Computed timeline status based on schedule vs actual progress.",
    )
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    slack_days: Optional[float] = None
    is_critical: bool = False
    deadline: Optional[str] = Field(
        default=None,
        description="Effective deadline (end_date + slack_days) for non-critical tasks.",
    )


class TimelineStatusOutput(BaseModel):
    plan_id: str
    current_date: str
    tasks: list[TaskTimelineStatus] = Field(default_factory=list)


timeline_status_task = TaskSchema(
    name="gantt.timeline_status",
    input_schema=TimelineStatusInput,
    output_schema=TimelineStatusOutput,
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

get_phase_meta_task = TaskSchema(
    name="github.get_phase_meta",
    input_schema=GetPhaseMetaInput,
    output_schema=GetPhaseMetaOutput,
)

update_phase_meta_task = TaskSchema(
    name="github.update_phase_meta",
    input_schema=UpdatePhaseMetaInput,
    output_schema=UpdatePhaseMetaOutput,
)

get_phase_meta_csv_task = TaskSchema(
    name="github.get_phase_meta_csv",
    input_schema=GetPhaseMetaCsvInput,
    output_schema=GetPhaseMetaCsvOutput,
)

update_phase_meta_csv_task = TaskSchema(
    name="github.update_phase_meta_csv",
    input_schema=UpdatePhaseMetaCsvInput,
    output_schema=UpdatePhaseMetaCsvOutput,
)

job_status_task = TaskSchema(
    name="github.job_status",
    input_schema=JobStatusInput,
    output_schema=JobStatusOutput,
)


# ----------------------------
# Service
# ----------------------------

class KanlyticsBackend(Service):
    """
    Mindtrace Service wrapper for the Kanlytics backend.

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

        cors_origins_env = os.getenv("KANLYTICS_CORS_ORIGINS", "").strip()
        if cors_origins_env:
            cors_origins = [o.strip() for o in cors_origins_env.split(",") if o.strip()]
        else:
            cors_origins = [
                "http://localhost:5173",  # Vite dev server (default)
                "http://127.0.0.1:5173",
            ]

        allow_credentials = True
        if "*" in cors_origins:
            cors_origins = ["*"]
            # With wildcard origin, credentials cannot be allowed by browsers.
            allow_credentials = False

        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=allow_credentials,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        self.add_endpoint("gantt.create_plan", self.create_plan, schema=create_plan_task)
        self.add_endpoint("gantt.append_task", self.append_task, schema=append_task_task)
        self.add_endpoint("gantt.update_task", self.update_task, schema=update_task_task)
        self.add_endpoint("gantt.delete_task", self.delete_task, schema=delete_task_task)
        self.add_endpoint("gantt.get_metadata", self.get_metadata, schema=get_metadata_task)
        self.add_endpoint("gantt.update_metadata", self.update_metadata, schema=update_metadata_task)
        self.add_endpoint("csv.load_path", self.load_csv_path, schema=load_csv_path_task)
        self.add_endpoint("csv.save_path", self.save_csv_path, schema=save_csv_path_task)
        self.add_endpoint("projects.save", self.save_project, schema=save_project_task)
        self.add_endpoint("projects.load", self.load_project, schema=load_project_task)
        self.add_endpoint("projects.list", self.list_projects, schema=list_projects_task)
        self.add_endpoint("gantt.schedule", self.schedule, schema=schedule_task)
        self.add_endpoint("gantt.layout", self.get_layout, schema=layout_task)
        self.add_endpoint("gantt.critical_path", self.get_critical_path, schema=critical_path_task)
        self.add_endpoint("gantt.timeline_status", self.get_timeline_status, schema=timeline_status_task)
        self.add_endpoint("github.connect_project", self.connect_project, schema=connect_project_task)
        self.add_endpoint("github.export_project", self.export_project, schema=export_project_task)
        self.add_endpoint("github.connect_project_start", self.connect_project_start, schema=connect_project_start_task)
        self.add_endpoint("github.export_project_start", self.export_project_start, schema=export_project_start_task)
        self.add_endpoint("github.get_phase_meta", self.get_phase_meta, schema=get_phase_meta_task)
        self.add_endpoint("github.update_phase_meta", self.update_phase_meta, schema=update_phase_meta_task)
        self.add_endpoint("github.get_phase_meta_csv", self.get_phase_meta_csv, schema=get_phase_meta_csv_task)
        self.add_endpoint("github.update_phase_meta_csv", self.update_phase_meta_csv, schema=update_phase_meta_csv_task)
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

    def append_task(self, payload: AppendTaskInput) -> AppendTaskOutput:
        """
        Append a new task row to a V2 CSV (single header row) and return the updated CSV.
        """
        import io
        import csv as _csv

        # Canonical V2 columns (match gantt.export_csv_v2)
        fieldnames = [
            "Display Task ID",
            "Task ID",
            "url",
            "repo",
            "number",
            "state",
            "project_name",
            "phase",
            "title",
            "body",
            "milestone_or_output",
            "acceptance_criteria",
            "Dependencies",
            "start_date",
            "end_date",
            "wall_days",
            "billable_days",
            "Labels",
            "Assignees",
            "notes",
            "status",
        ]

        text = payload.csv_text or ""
        # Extract metadata headers and CSV body
        original_metadata, csv_body = parse_csv_metadata(text)
        buf_in = io.StringIO(csv_body)
        reader = _csv.DictReader(buf_in)
        rows: list[dict[str, str]] = []
        # If the CSV has a header, DictReader.fieldnames will be set; otherwise None.
        if reader.fieldnames:
            for r in reader:
                # Keep blank rows out
                if r is None:
                    continue
                if all(((v or "").strip() == "" for v in r.values())):
                    continue
                rows.append({k: (v or "") for k, v in r.items()})

        task_id = str(uuid4())
        phase = (payload.phase or "").strip()
        title = (payload.title or "").strip()
        if not phase:
            raise ValueError("phase is required.")
        if not title:
            raise ValueError("title is required.")

        def parse_display_major_minor(s: str) -> Optional[tuple[int, int]]:
            s = (s or "").strip()
            m = __import__("re").match(r"^(\d+)\.(\d+)$", s)
            if not m:
                return None
            return int(m.group(1)), int(m.group(2))

        # Determine the major number for this phase.
        major = payload.phase_major
        if major is None:
            # Best-effort infer from existing rows in same phase.
            majors: list[int] = []
            for r in rows:
                if (r.get("phase") or "").strip() != phase:
                    continue
                parsed = parse_display_major_minor(r.get("Display Task ID") or "")
                if parsed:
                    majors.append(parsed[0])
            if majors:
                major = max(majors)
            else:
                # Fallback: pick next major across the whole file.
                all_majors: list[int] = []
                for r in rows:
                    parsed = parse_display_major_minor(r.get("Display Task ID") or "")
                    if parsed:
                        all_majors.append(parsed[0])
                major = (max(all_majors) + 1) if all_majors else 1

        # Determine the next minor number within the phase+major.
        max_minor = 0
        for r in rows:
            if (r.get("phase") or "").strip() != phase:
                continue
            parsed = parse_display_major_minor(r.get("Display Task ID") or "")
            if not parsed:
                continue
            mj, mn = parsed
            if mj == major:
                max_minor = max(max_minor, mn)
        display_task_id = f"{major}.{max_minor + 1}"

        status = (payload.status or "").strip() or "Backlog"
        if status not in STATUS_OPTIONS:
            status = "Backlog"

        new_row = {
            "Display Task ID": display_task_id,
            "Task ID": task_id,
            "url": "",
            "repo": (payload.repo or "").strip(),
            "number": "",
            "state": "open",
            "project_name": (payload.project_name or "").strip(),
            "phase": phase,
            "title": title,
            "body": (payload.body or "").strip(),
            "milestone_or_output": "",
            "acceptance_criteria": (payload.acceptance_criteria or "").strip(),
            "Dependencies": ",".join([d.strip() for d in (payload.dependencies or []) if d.strip()]),
            "start_date": "",
            "end_date": "",
            "wall_days": "" if (payload.wall_days or 0.0) == 0.0 else str(payload.wall_days),
            "billable_days": "" if (payload.billable_days or 0.0) == 0.0 else str(payload.billable_days),
            "Labels": "",
            "Assignees": "",
            "notes": "",
            "status": status,
        }

        rows.append(new_row)

        buf_out = io.StringIO()
        w = _csv.DictWriter(buf_out, fieldnames=fieldnames, lineterminator="\n")
        w.writeheader()
        for r in rows:
            # Only write known columns; fill missing with blanks.
            out_r = {k: (r.get(k) or "") for k in fieldnames}
            w.writerow(out_r)
        
        # Preserve metadata headers in output
        output_csv = write_csv_with_metadata(original_metadata, buf_out.getvalue())
        return AppendTaskOutput(csv_text=output_csv, task_id=task_id)

    def update_task(self, payload: UpdateTaskInput) -> UpdateTaskOutput:
        import io
        import csv as _csv

        fieldnames = [
            "Display Task ID",
            "Task ID",
            "url",
            "repo",
            "number",
            "state",
            "project_name",
            "phase",
            "title",
            "body",
            "milestone_or_output",
            "acceptance_criteria",
            "Dependencies",
            "start_date",
            "end_date",
            "wall_days",
            "billable_days",
            "Labels",
            "Assignees",
            "notes",
            "status",
        ]

        target_id = (payload.task_id or "").strip()
        if not target_id:
            raise ValueError("task_id is required.")

        # Extract metadata headers and CSV body
        original_metadata, csv_body = parse_csv_metadata(payload.csv_text or "")
        buf_in = io.StringIO(csv_body)
        reader = _csv.DictReader(buf_in)
        rows: list[dict[str, str]] = []
        if reader.fieldnames:
            for r in reader:
                if r is None:
                    continue
                if all(((v or "").strip() == "" for v in r.values())):
                    continue
                rows.append({k: (v or "") for k, v in r.items()})

        found = False
        for r in rows:
            if (r.get("Task ID") or "").strip() != target_id:
                continue
            found = True

            if payload.title is not None:
                r["title"] = (payload.title or "").strip()
            if payload.body is not None:
                r["body"] = (payload.body or "").strip()
            if payload.acceptance_criteria is not None:
                r["acceptance_criteria"] = (payload.acceptance_criteria or "").strip()
            if payload.dependencies is not None:
                r["Dependencies"] = ",".join([d.strip() for d in (payload.dependencies or []) if d.strip()])
            if payload.wall_days is not None:
                r["wall_days"] = "" if (payload.wall_days or 0.0) == 0.0 else str(payload.wall_days)
            if payload.billable_days is not None:
                r["billable_days"] = "" if (payload.billable_days or 0.0) == 0.0 else str(payload.billable_days)
            if payload.status is not None:
                status = (payload.status or "").strip() or "Backlog"
                if status not in STATUS_OPTIONS:
                    status = "Backlog"
                r["status"] = status
            if payload.repo is not None:
                r["repo"] = (payload.repo or "").strip()

            break

        if not found:
            raise ValueError(f"Task ID not found: {target_id}")

        buf_out = io.StringIO()
        w = _csv.DictWriter(buf_out, fieldnames=fieldnames, lineterminator="\n")
        w.writeheader()
        for r in rows:
            out_r = {k: (r.get(k) or "") for k in fieldnames}
            w.writerow(out_r)
        
        # Preserve metadata headers in output
        output_csv = write_csv_with_metadata(original_metadata, buf_out.getvalue())
        return UpdateTaskOutput(csv_text=output_csv)

    def delete_task(self, payload: DeleteTaskInput) -> DeleteTaskOutput:
        """
        Delete a task row and remove dependency references to it from other tasks.
        """
        import io
        import csv as _csv

        fieldnames = [
            "Display Task ID",
            "Task ID",
            "url",
            "repo",
            "number",
            "state",
            "project_name",
            "phase",
            "title",
            "body",
            "milestone_or_output",
            "acceptance_criteria",
            "Dependencies",
            "start_date",
            "end_date",
            "wall_days",
            "billable_days",
            "Labels",
            "Assignees",
            "notes",
            "status",
        ]

        target_id = (payload.task_id or "").strip()
        if not target_id:
            raise ValueError("task_id is required.")

        # Extract metadata headers and CSV body
        original_metadata, csv_body = parse_csv_metadata(payload.csv_text or "")
        buf_in = io.StringIO(csv_body)
        reader = _csv.DictReader(buf_in)
        rows: list[dict[str, str]] = []
        if reader.fieldnames:
            for r in reader:
                if r is None:
                    continue
                if all(((v or "").strip() == "" for v in r.values())):
                    continue
                rows.append({k: (v or "") for k, v in r.items()})

        kept: list[dict[str, str]] = []
        removed: list[str] = []
        for r in rows:
            rid = (r.get("Task ID") or "").strip()
            if rid == target_id:
                removed.append(rid)
                continue
            kept.append(r)

        if not removed:
            raise ValueError(f"Task ID not found: {target_id}")

        # Remove dependency references to the deleted task.
        for r in kept:
            deps = [d.strip() for d in (r.get("Dependencies") or "").split(",") if d.strip()]
            if target_id in deps:
                deps = [d for d in deps if d != target_id]
                r["Dependencies"] = ",".join(deps)

        buf_out = io.StringIO()
        w = _csv.DictWriter(buf_out, fieldnames=fieldnames, lineterminator="\n")
        w.writeheader()
        for r in kept:
            out_r = {k: (r.get(k) or "") for k in fieldnames}
            w.writerow(out_r)
        
        # Preserve metadata headers in output
        original_metadata, _ = parse_csv_metadata(payload.csv_text)
        output_csv = write_csv_with_metadata(original_metadata, buf_out.getvalue())
        return DeleteTaskOutput(csv_text=output_csv, removed_task_ids=removed)

    def get_metadata(self, payload: GetMetadataInput) -> GetMetadataOutput:
        """
        Extract project metadata from CSV text.
        """
        metadata_dict, csv_body = parse_csv_metadata(payload.csv_text)
        return GetMetadataOutput(
            metadata=ProjectMetadata.from_dict(metadata_dict),
            csv_body=csv_body,
        )

    def update_metadata(self, payload: UpdateMetadataInput) -> UpdateMetadataOutput:
        """
        Update project metadata in CSV text.
        Preserves existing metadata fields not specified in the update.
        """
        # Parse existing metadata
        existing_metadata, csv_body = parse_csv_metadata(payload.csv_text)
        
        # Update with new values (only if provided)
        if payload.project_name is not None:
            existing_metadata["Project Name"] = payload.project_name
        if payload.project_hash is not None:
            existing_metadata["Project Hash"] = payload.project_hash
        if payload.project_manager is not None:
            existing_metadata["Project Manager"] = payload.project_manager
        if payload.tech_lead is not None:
            existing_metadata["Tech Lead"] = payload.tech_lead
        if payload.client is not None:
            existing_metadata["Client"] = payload.client
        
        # Ensure project has a hash
        existing_metadata = ensure_project_hash(existing_metadata)
        
        # Write updated CSV
        output_csv = write_csv_with_metadata(existing_metadata, csv_body)
        
        return UpdateMetadataOutput(
            csv_text=output_csv,
            metadata=ProjectMetadata.from_dict(existing_metadata),
        )

    def create_plan(self, payload: CreatePlanInput) -> CreatePlanOutput:
        """
        Parse CSV text into a Gantt plan and store it server-side.
        Extracts and preserves project metadata from CSV headers.
        """
        # Extract metadata from CSV
        metadata_dict, _ = parse_csv_metadata(payload.csv_text)
        
        # Ensure project has a unique hash
        metadata_dict = ensure_project_hash(metadata_dict)
        
        # If project_name provided in payload, use it (overrides CSV header)
        if payload.project_name:
            pn = payload.project_name.strip()
            if pn:
                metadata_dict["Project Name"] = pn
        
        gantt = self._gantt_from_csv_text(payload.csv_text)
        if metadata_dict.get("Project Name"):
            for t in gantt.tasks:
                if not getattr(t, "project_name", None):
                    t.project_name = metadata_dict["Project Name"]

        plan_id = str(uuid4())
        with self._lock:
            self._plans[plan_id] = gantt
            # clear any old layout under same id (shouldn't happen, but safe)
            self._layouts.pop(plan_id, None)

        # Build normalized CSV with metadata headers
        normalized_csv_body = gantt.export_csv_v2()
        normalized_csv_text = write_csv_with_metadata(metadata_dict, normalized_csv_body)
        
        return CreatePlanOutput(
            plan_id=plan_id,
            task_count=len(gantt.tasks),
            normalized_csv_text=normalized_csv_text,
            metadata=ProjectMetadata.from_dict(metadata_dict),
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

    def get_timeline_status(self, payload: TimelineStatusInput) -> TimelineStatusOutput:
        """
        Compute the Timeline Status for each task based on schedule vs actual progress.

        Timeline Status definitions:
          - Scheduled: Task not started yet, status is Backlog or Planned
          - In Development: Task has begun (status is In Progress or In Review)
          - Delayed: Start Date passed but still Backlog/Planned, OR End Date passed and not Done
          - Critically Delayed: Delayed AND impacting project completion (on critical path or slack exhausted)
          - Complete: Task status is Done
        """
        from datetime import date, datetime

        with self._lock:
            layout = self._layouts.get(payload.plan_id)

        if layout is None:
            raise ValueError(
                f"No layout found for plan_id={payload.plan_id}. "
                f"Did you call gantt.schedule first?"
            )

        # Determine current date
        if payload.current_date:
            current_date_str = payload.current_date.strip()
        else:
            current_date_str = date.today().isoformat()

        def parse_date(s: str) -> date | None:
            if not s:
                return None
            try:
                return datetime.strptime(s.strip(), "%Y-%m-%d").date()
            except Exception:
                return None

        current_date = parse_date(current_date_str)
        if current_date is None:
            current_date = date.today()
            current_date_str = current_date.isoformat()

        # Get critical path task IDs
        critical_path_ids = set((layout.get("meta") or {}).get("critical_path") or [])

        results: list[TaskTimelineStatus] = []

        for t in layout.get("tasks") or []:
            task_id = t.get("id") or ""
            display_task_id = t.get("display_task_id") or t.get("display_id")
            name = t.get("name") or t.get("title") or "(untitled)"
            phase = t.get("phase")
            status = (t.get("status") or "Backlog").strip()
            schedule = t.get("schedule") or {}
            start_date_str = schedule.get("start") or ""
            end_date_str = schedule.get("end") or ""
            slack_days = t.get("slack_days") or 0.0
            is_critical = t.get("is_critical") or (task_id in critical_path_ids)

            start_date = parse_date(start_date_str)
            end_date = parse_date(end_date_str)

            # Compute effective deadline (end_date + slack_days)
            deadline_str: str | None = None
            if end_date:
                from datetime import timedelta
                deadline_date = end_date + timedelta(days=int(slack_days))
                deadline_str = deadline_date.isoformat()

            # Determine Timeline Status
            status_lower = status.lower()

            # Rule 6: Complete - task is Done
            if status_lower == "done":
                timeline_status = "Complete"

            # Rule 2: In Development - task has begun (In Progress or In Review)
            elif status_lower in ("in progress", "in review"):
                timeline_status = "In Development"

            # Rules 3, 4, 5: Check for delays
            elif status_lower in ("backlog", "planned"):
                is_delayed = False

                # Rule 3: Start Date passed but status is still Backlog or Planned
                if start_date and current_date > start_date:
                    is_delayed = True

                # Rule 4: End Date passed and task is not Done (already checked status is backlog/planned)
                if end_date and current_date > end_date:
                    is_delayed = True

                if is_delayed:
                    # Rule 5: Critically Delayed if impacting project completion
                    # (on critical path OR slack exhausted)
                    if is_critical:
                        timeline_status = "Critically Delayed"
                    elif deadline_str:
                        deadline_date = parse_date(deadline_str)
                        if deadline_date and current_date > deadline_date:
                            # Slack exhausted - this delay impacts the project
                            timeline_status = "Critically Delayed"
                        else:
                            timeline_status = "Delayed"
                    else:
                        timeline_status = "Delayed"
                else:
                    # Rule 1: Scheduled - task not started yet
                    timeline_status = "Scheduled"

            else:
                # Unknown status - treat as Scheduled
                timeline_status = "Scheduled"

            results.append(TaskTimelineStatus(
                task_id=task_id,
                display_task_id=display_task_id,
                name=name,
                phase=phase,
                status=status,
                timeline_status=timeline_status,
                start_date=start_date_str or None,
                end_date=end_date_str or None,
                slack_days=slack_days if slack_days else None,
                is_critical=is_critical,
                deadline=deadline_str,
            ))

        return TimelineStatusOutput(
            plan_id=payload.plan_id,
            current_date=current_date_str,
            tasks=results,
        )

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

            # Skip Kanlytics "phase meta issues" (they should not be treated as schedulable tasks).
            body_text = (content.get("body") or "").strip()
            if PHASE_META_MARKER in body_text:
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
                repo_owner = ((content.get("repository") or {}).get("owner") or {}).get("login")
                repo_name = (content.get("repository") or {}).get("name")
                repo_ref = f"{repo_owner}/{repo_name}" if repo_owner and repo_name else None
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
                    repo=repo_ref,
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

    def get_phase_meta(self, payload: GetPhaseMetaInput) -> GetPhaseMetaOutput:
        """
        Fetch (and if needed create) the Phase "meta issue" for the given phase.

        The meta issue is a real GitHub Issue when we can determine a repo; otherwise a DraftIssue.
        The task checklist portion is auto-generated.
        """
        from uuid import NAMESPACE_URL, uuid5

        phase = (payload.phase or "").strip()
        if not phase:
            raise ValueError("phase is required.")

        client = GitHubProjectV2(payload.project_url)
        status_field_id, status_option_ids = client.ensure_status_columns(options=STATUS_OPTIONS, default="Backlog")
        task_id_field_id = client.ensure_text_field("Task ID")
        display_id_field_id = client.ensure_text_field("Display Task ID")
        phase_field_id = client.ensure_text_field("Phase")
        deps_field_id = client.ensure_text_field("Dependencies")
        wall_days_field_id = client.ensure_text_field("Wall Days")
        billable_days_field_id = client.ensure_text_field("Billable Days")

        phase_task_id = str(uuid5(NAMESPACE_URL, f"kanlytics:phase:{payload.project_url}:{phase}"))

        items = list(client.iter_items())

        # Infer a repo for creating/formatting refs.
        issue_repo = (payload.issue_repo or "").strip() or None
        if not issue_repo:
            for it in items:
                c = it.get("content") or {}
                if c.get("__typename") != "Issue":
                    continue
                url = (c.get("url") or "").strip()
                if not url:
                    continue
                try:
                    owner, repo, _ = client.parse_issue_url(url)
                    issue_repo = f"{owner}/{repo}"
                    break
                except Exception:
                    continue

        def _is_meta(it: dict) -> bool:
            c = it.get("content") or {}
            return PHASE_META_MARKER in ((c.get("body") or "") or "")

        def _format_ref(meta_repo: Optional[str], issue_url: str) -> str:
            owner, repo, number = client.parse_issue_url(issue_url)
            if meta_repo and meta_repo.lower() == f"{owner}/{repo}".lower():
                return f"#{number}"
            return f"{owner}/{repo}#{number}"

        # Build the checklist lines from current project items for this phase.
        phase_items: list[dict] = []
        for it in items:
            if _is_meta(it):
                continue
            c = it.get("content") or {}
            tn = c.get("__typename")
            if tn not in ("Issue", "DraftIssue"):
                continue
            ph = (client._get_text_field_value(it, "Phase") or "").strip() or "Unphased"
            if ph != phase:
                continue
            phase_items.append(it)

        def _sort_key(it: dict) -> tuple:
            c = it.get("content") or {}
            tn = c.get("__typename")
            if tn == "Issue":
                try:
                    num = int(c.get("number") or 0)
                except Exception:
                    num = 0
                return (0, num)
            # Drafts last, by title
            return (1, (c.get("title") or "").strip().lower())

        phase_items.sort(key=_sort_key)

        checklist: list[str] = []
        for it in phase_items:
            c = it.get("content") or {}
            tn = c.get("__typename")
            title = (c.get("title") or "").strip() or "(untitled)"
            if tn == "Issue":
                url = (c.get("url") or "").strip()
                if url:
                    checklist.append(f"- [ ] {_format_ref(issue_repo, url)} {title}")
                else:
                    checklist.append(f"- [ ] {title}")
            else:
                checklist.append(f"- [ ] (draft) {title}")

        # Find existing meta issue item by deterministic Task ID.
        rec = None
        for it in items:
            item_id = it.get("id")
            c = it.get("content") or {}
            tn = c.get("__typename")
            if tn not in ("Issue", "DraftIssue") or not item_id:
                continue
            if (client._get_text_field_value(it, "Task ID") or "").strip() == phase_task_id:
                rec = {
                    "item_id": item_id,
                    "type": tn,
                    "issue_url": c.get("url") if tn == "Issue" else None,
                    "draft_issue_id": c.get("id") if tn == "DraftIssue" else None,
                }
                break

        # If the meta issue already exists as a real Issue, prefer its actual repo for formatting "#123" shorthand.
        if rec and rec.get("issue_url"):
            try:
                owner, repo, _ = client.parse_issue_url(rec["issue_url"])
                issue_repo = f"{owner}/{repo}"
            except Exception:
                pass

        # Extract description from an existing body, if present.
        description = ""
        if rec:
            # Locate the actual item content to read its body.
            existing_body = ""
            for it in items:
                if it.get("id") == rec["item_id"]:
                    existing_body = (it.get("content") or {}).get("body") or ""
                    break
            txt = str(existing_body or "")
            if PHASE_META_MARKER in txt:
                # naive but reliable: grab everything after the '## phase' line up to first checklist line.
                lines = txt.splitlines()
                try:
                    hdr_idx = next(i for i, ln in enumerate(lines) if ln.strip() == f"## {phase}")
                except StopIteration:
                    hdr_idx = -1
                if hdr_idx >= 0:
                    after = lines[hdr_idx + 1 :]
                    desc_lines: list[str] = []
                    for ln in after:
                        if ln.strip().startswith("- [ ]"):
                            break
                        # skip leading empty line
                        desc_lines.append(ln)
                    description = "\n".join(desc_lines).strip()

        # If missing, create the meta issue now.
        if not rec:
            if issue_repo:
                labels_safe = client.ensure_labels_exist(repo=issue_repo, labels=["kanlytics:phase"])
                created_url = client.create_issue_rest(repo=issue_repo, title=phase, body="", labels=labels_safe, assignees=[])
                owner, repo, number = client.parse_issue_url(created_url)
                issue_node_id = client.resolve_issue_node_id(owner=owner, repo=repo, number=number)
                item_id = client.add_issue_item(issue_node_id=issue_node_id)
                rec = {"item_id": item_id, "type": "Issue", "issue_url": created_url, "draft_issue_id": None}
            else:
                item_id = client.add_draft_issue(title=phase, body="")
                rec = {"item_id": item_id, "type": "DraftIssue", "issue_url": None, "draft_issue_id": item_id}

        # Compose the canonical body (preserve description, regenerate checklist).
        parts: list[str] = [PHASE_META_MARKER, f"## {phase}"]
        if description.strip():
            parts.append("")
            parts.extend(description.strip().splitlines())
        parts.append("")
        parts.extend(checklist)
        body = "\n".join(parts).strip() + "\n"

        # Ensure project fields are set.
        client.set_text_field(item_id=rec["item_id"], field_id=task_id_field_id, text=phase_task_id)
        client.set_text_field(item_id=rec["item_id"], field_id=phase_field_id, text=phase)
        client.set_text_field(item_id=rec["item_id"], field_id=deps_field_id, text="")
        client.set_text_field(item_id=rec["item_id"], field_id=wall_days_field_id, text="0")
        client.set_text_field(item_id=rec["item_id"], field_id=billable_days_field_id, text="0")
        client.set_single_select_field(item_id=rec["item_id"], field_id=status_field_id, option_id=status_option_ids["Backlog"])
        # Display Task ID: best-effort "major.0" from items in this phase
        try:
            import re

            majors: list[int] = []
            for it in phase_items:
                disp = (client._get_text_field_value(it, "Display Task ID") or "").strip()
                m = re.match(r"^(\d+)\.(\d+)$", disp)
                if m:
                    majors.append(int(m.group(1)))
            if majors:
                major = max(set(majors), key=lambda v: (majors.count(v), -v))
                client.set_text_field(item_id=rec["item_id"], field_id=display_id_field_id, text=f"{major}.0")
        except Exception:
            pass

        # Update body on GitHub to match canonical format.
        if rec["type"] == "Issue" and rec.get("issue_url"):
            owner, repo, _ = client.parse_issue_url(rec["issue_url"])
            labels_safe = client.ensure_labels_exist(repo=f"{owner}/{repo}", labels=["kanlytics:phase"])
            client.update_issue_rest(issue_url=rec["issue_url"], title=phase, body=body, labels=labels_safe, assignees=[])
        else:
            draft_id = rec.get("draft_issue_id")
            if draft_id:
                client.update_draft_issue(draft_issue_id=draft_id, title=phase, body=body)

        return GetPhaseMetaOutput(
            phase=phase,
            task_id=phase_task_id,
            item_id=rec["item_id"],
            type=rec["type"],
            issue_url=rec.get("issue_url"),
            title=phase,
            description=description,
            body=body,
        )

    def update_phase_meta(self, payload: UpdatePhaseMetaInput) -> UpdatePhaseMetaOutput:
        """
        Update the editable description portion of a phase meta issue and regenerate its checklist.
        """
        # We implement this as: get -> overwrite description -> rewrite canonical body.
        # NOTE: description is the only editable region; task list is auto-generated.
        got = self.get_phase_meta(GetPhaseMetaInput(project_url=payload.project_url, phase=payload.phase, issue_repo=payload.issue_repo))
        phase = got.phase
        description = (payload.description or "").strip()

        client = GitHubProjectV2(payload.project_url)
        task_id_field_id = client.ensure_text_field("Task ID")

        # Locate the meta item to update.
        rec = None
        for it in client.iter_items():
            item_id = it.get("id")
            c = it.get("content") or {}
            tn = c.get("__typename")
            if tn not in ("Issue", "DraftIssue") or not item_id:
                continue
            if (client._get_text_field_value(it, "Task ID") or "").strip() == got.task_id:
                rec = {
                    "item_id": item_id,
                    "type": tn,
                    "issue_url": c.get("url") if tn == "Issue" else None,
                    "draft_issue_id": c.get("id") if tn == "DraftIssue" else None,
                }
                break
        if not rec:
            # Shouldn't happen because get_phase_meta creates it, but keep safe.
            raise ValueError("Phase meta issue not found after creation.")

        # Reuse the checklist from get_phase_meta's body by stripping everything up to first checklist line.
        lines = got.body.splitlines()
        checklist_idx = None
        for i, ln in enumerate(lines):
            if ln.strip().startswith("- [ ]"):
                checklist_idx = i
                break
        checklist = lines[checklist_idx:] if checklist_idx is not None else []

        parts: list[str] = [PHASE_META_MARKER, f"## {phase}"]
        if description:
            parts.append("")
            parts.extend(description.splitlines())
        parts.append("")
        parts.extend(checklist)
        body = "\n".join(parts).strip() + "\n"

        # Ensure Task ID is set (idempotent)
        client.set_text_field(item_id=rec["item_id"], field_id=task_id_field_id, text=got.task_id)

        if rec["type"] == "Issue" and rec.get("issue_url"):
            owner, repo, _ = client.parse_issue_url(rec["issue_url"])
            labels_safe = client.ensure_labels_exist(repo=f"{owner}/{repo}", labels=["kanlytics:phase"])
            client.update_issue_rest(issue_url=rec["issue_url"], title=phase, body=body, labels=labels_safe, assignees=[])
        else:
            draft_id = rec.get("draft_issue_id")
            if draft_id:
                client.update_draft_issue(draft_issue_id=draft_id, title=phase, body=body)

        return UpdatePhaseMetaOutput(
            phase=phase,
            task_id=got.task_id,
            item_id=rec["item_id"],
            type=rec["type"],
            issue_url=rec.get("issue_url"),
            title=phase,
            description=description,
            body=body,
        )

    def get_phase_meta_csv(self, payload: GetPhaseMetaCsvInput) -> GetPhaseMetaCsvOutput:
        """
        Repo-only phase meta issue support (no ProjectV2 URL required).

        This is used when a project hasn't been connected to a GitHub Project board yet.
        We create/update a real Issue in the provided repo and generate the checklist
        from the local CSV tasks.
        """
        import requests
        from uuid import NAMESPACE_URL, uuid5

        from kanlytics.core.github_project_v2 import GitHubProjectV2, detect_github_token, parse_repo_ref

        repo = (payload.repo or "").strip()
        project_name = (payload.project_name or "").strip()
        phase = (payload.phase or "").strip()
        if not repo:
            raise ValueError("repo is required.")
        if not project_name:
            raise ValueError("project_name is required.")
        if not phase:
            raise ValueError("phase is required.")

        token = detect_github_token()
        if not token:
            raise ValueError("GitHub token required (set in config.ini or env var like GITHUB_TOKEN)")

        headers = {
            "Authorization": f"token {token}",
            "Content-Type": "application/json",
            "Accept": "application/vnd.github+json",
            "User-Agent": "kanlytics/1.0",
        }

        owner, name = parse_repo_ref(repo)
        phase_task_id = str(uuid5(NAMESPACE_URL, f"kanlytics:phase:{repo}:{project_name}:{phase}"))
        marker = f"{PHASE_META_MARKER} id={phase_task_id}"

        gantt = self._gantt_from_csv_text(payload.csv_text or "")
        tasks = [t for t in gantt.tasks if ((getattr(t, "phase", "") or "Unphased").strip() or "Unphased") == phase]
        tasks.sort(key=lambda t: ((getattr(t, "display_task_id", "") or "").strip(), (getattr(t, "title", "") or getattr(t, "name", "") or "").strip().lower()))

        def _format_ref(issue_url: str) -> str:
            o, r, num = GitHubProjectV2.parse_issue_url(issue_url)
            if f"{o}/{r}".lower() == f"{owner}/{name}".lower():
                return f"#{num}"
            return f"{o}/{r}#{num}"

        checklist: list[str] = []
        for t in tasks:
            title = (getattr(t, "title", None) or getattr(t, "name", "") or "").strip() or "(untitled)"
            url = (getattr(t, "url", None) or "").strip()
            if url:
                checklist.append(f"- [ ] {_format_ref(url)} {title}")
            else:
                disp = (getattr(t, "display_task_id", None) or getattr(t, "task_id", None) or getattr(t, "id", None) or "").strip()
                checklist.append(f"- [ ] {disp + ' ' if disp else ''}{title}".rstrip())

        # Find existing meta issue by searching in body for the deterministic id marker.
        search_q = f"repo:{owner}/{name} in:body {phase_task_id} type:issue"
        sr = requests.get("https://api.github.com/search/issues", headers=headers, params={"q": search_q, "per_page": 1})
        sr.raise_for_status()
        items = (sr.json() or {}).get("items") or []
        issue_url = (items[0].get("html_url") if items else None)

        description = ""
        existing_body = ""
        if issue_url:
            _, _, num = GitHubProjectV2.parse_issue_url(issue_url)
            gr = requests.get(f"https://api.github.com/repos/{owner}/{name}/issues/{num}", headers=headers)
            gr.raise_for_status()
            data = gr.json() or {}
            existing_body = data.get("body") or ""
            # Extract existing description between header and checklist.
            txt = str(existing_body or "")
            if phase_task_id in txt:
                lines = txt.splitlines()
                try:
                    hdr_idx = next(i for i, ln in enumerate(lines) if ln.strip() == f"## {phase}")
                except StopIteration:
                    hdr_idx = -1
                if hdr_idx >= 0:
                    after = lines[hdr_idx + 1 :]
                    desc_lines: list[str] = []
                    for ln in after:
                        if ln.strip().startswith("- [ ]"):
                            break
                        desc_lines.append(ln)
                    description = "\n".join(desc_lines).strip()

        # Compose canonical body
        parts: list[str] = [marker, f"## {phase}"]
        if description.strip():
            parts.append("")
            parts.extend(description.strip().splitlines())
        parts.append("")
        parts.extend(checklist)
        body = "\n".join(parts).strip() + "\n"

        # Ensure label exists best-effort.
        try:
            lr = requests.get(f"https://api.github.com/repos/{owner}/{name}/labels", headers=headers, params={"per_page": 100})
            lr.raise_for_status()
            existing = {str(l.get("name") or "").lower() for l in (lr.json() or []) if isinstance(l, dict)}
            if "kanlytics:phase".lower() not in existing:
                cr = requests.post(f"https://api.github.com/repos/{owner}/{name}/labels", headers=headers, json={"name": "kanlytics:phase", "color": "BFDADC"})
                # ignore failure (permissions)
                if cr.status_code >= 400:
                    pass
        except Exception:
            pass

        if issue_url:
            _, _, num = GitHubProjectV2.parse_issue_url(issue_url)
            pr = requests.patch(
                f"https://api.github.com/repos/{owner}/{name}/issues/{num}",
                headers=headers,
                json={"title": phase, "body": body, "labels": ["kanlytics:phase"]},
            )
            pr.raise_for_status()
            issue_url = (pr.json() or {}).get("html_url") or issue_url
        else:
            cr = requests.post(
                f"https://api.github.com/repos/{owner}/{name}/issues",
                headers=headers,
                json={"title": phase, "body": body, "labels": ["kanlytics:phase"]},
            )
            cr.raise_for_status()
            issue_url = (cr.json() or {}).get("html_url")
            if not issue_url:
                raise ValueError("Issue creation succeeded but no html_url returned")

        # We don't have a project item id; reuse URL as stable identifier for UI.
        return GetPhaseMetaCsvOutput(
            phase=phase,
            task_id=phase_task_id,
            item_id=issue_url,
            type="Issue",
            issue_url=issue_url,
            title=phase,
            description=description,
            body=body,
        )

    def update_phase_meta_csv(self, payload: UpdatePhaseMetaCsvInput) -> UpdatePhaseMetaCsvOutput:
        # Update is just get + overwrite description in body + patch.
        got = self.get_phase_meta_csv(GetPhaseMetaCsvInput(repo=payload.repo, project_name=payload.project_name, csv_text=payload.csv_text, phase=payload.phase))

        import requests
        from kanlytics.core.github_project_v2 import GitHubProjectV2, detect_github_token, parse_repo_ref

        token = detect_github_token()
        if not token:
            raise ValueError("GitHub token required (set in config.ini or env var like GITHUB_TOKEN)")
        headers = {
            "Authorization": f"token {token}",
            "Content-Type": "application/json",
            "Accept": "application/vnd.github+json",
            "User-Agent": "kanlytics/1.0",
        }
        owner, name = parse_repo_ref(payload.repo)
        issue_url = (got.issue_url or "").strip()
        if not issue_url:
            raise ValueError("Phase meta issue URL missing.")
        _, _, num = GitHubProjectV2.parse_issue_url(issue_url)

        # Rebuild body using the existing checklist section from got.body, but with new description.
        lines = got.body.splitlines()
        checklist_idx = None
        for i, ln in enumerate(lines):
            if ln.strip().startswith("- [ ]"):
                checklist_idx = i
                break
        checklist = lines[checklist_idx:] if checklist_idx is not None else []

        phase = got.phase
        description = (payload.description or "").strip()
        marker = f"{PHASE_META_MARKER} id={got.task_id}"

        parts: list[str] = [marker, f"## {phase}"]
        if description:
            parts.append("")
            parts.extend(description.splitlines())
        parts.append("")
        parts.extend(checklist)
        body = "\n".join(parts).strip() + "\n"

        pr = requests.patch(
            f"https://api.github.com/repos/{owner}/{name}/issues/{num}",
            headers=headers,
            json={"title": phase, "body": body, "labels": ["kanlytics:phase"]},
        )
        pr.raise_for_status()
        issue_url2 = (pr.json() or {}).get("html_url") or issue_url

        return UpdatePhaseMetaCsvOutput(
            phase=phase,
            task_id=got.task_id,
            item_id=issue_url2,
            type="Issue",
            issue_url=issue_url2,
            title=phase,
            description=description,
            body=body,
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

                    body_text = (content.get("body") or "").strip()
                    if PHASE_META_MARKER in body_text:
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
                        repo_owner = ((content.get("repository") or {}).get("owner") or {}).get("login")
                        repo_name = (content.get("repository") or {}).get("name")
                        repo_ref = f"{repo_owner}/{repo_name}" if repo_owner and repo_name else None
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
                            repo=repo_ref,
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

        max_workers = int(os.getenv("KANLYTICS_GITHUB_EXPORT_WORKERS", "6") or "6")
        if max_workers < 1:
            max_workers = 1
        issue_update_futures: dict[Any, str] = {}
        pool = ThreadPoolExecutor(max_workers=max_workers)

        def _submit_issue_update(*, key: str, issue_url: str, title: str, body: str, labels: list[str], assignees: list[str]) -> None:
            def work() -> None:
                owner, repo, _ = client.parse_issue_url(issue_url)
                labels_safe = client.ensure_labels_exist(repo=f"{owner}/{repo}", labels=labels)
                client.update_issue_rest(issue_url=issue_url, title=title, body=body, labels=labels_safe, assignees=assignees)

            fut = pool.submit(work)
            issue_update_futures[fut] = key

        for t in gantt.tasks:
            task_id = (t.task_id or t.id or "").strip()
            if not task_id:
                task_id = new_uuid()

            title = (t.title or t.name or "").strip()
            body = (t.body or t.details or "").strip()
            labels = list(t.labels or [])
            assignees = list(t.assignees or [])
            task_repo = (getattr(t, "repo", None) or "").strip() or None

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
                    updates: list[tuple[str, dict[str, Any]]] = []
                    updates.append((task_id_field_id, {"text": task_id}))
                    if project_name_field_id and project_name_value:
                        updates.append((project_name_field_id, {"text": project_name_value}))
                    if getattr(t, "display_task_id", None):
                        updates.append((display_id_field_id, {"text": str(t.display_task_id)}))
                    updates.append((phase_field_id, {"text": (t.phase or "")}))
                    updates.append((deps_field_id, {"text": ",".join(t.dependencies or [])}))
                    updates.append((wall_days_field_id, {"text": str(t.wall_days or 0)}))
                    updates.append((billable_days_field_id, {"text": str(t.billable_days or 0)}))
                    updates.append((status_field_id, {"singleSelectOptionId": status_option_ids[desired_status]}))
                    if sch_start:
                        updates.append((start_date_field_id, {"date": sch_start}))
                    if sch_end:
                        updates.append((end_date_field_id, {"date": sch_end}))
                    client.set_fields_bulk(item_id=rec["item_id"], updates=updates)

                    if rec["type"] == "Issue":
                        issue_url = t.url or rec.get("issue_url")
                        if issue_url:
                            _submit_issue_update(
                                key=task_id,
                                issue_url=issue_url,
                                title=title or "(untitled)",
                                body=body,
                                labels=labels,
                                assignees=assignees,
                            )
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
                        updates: list[tuple[str, dict[str, Any]]] = []
                        updates.append((task_id_field_id, {"text": task_id}))
                        if project_name_field_id and project_name_value:
                            updates.append((project_name_field_id, {"text": project_name_value}))
                        if getattr(t, "display_task_id", None):
                            updates.append((display_id_field_id, {"text": str(t.display_task_id)}))
                        updates.append((phase_field_id, {"text": (t.phase or "")}))
                        updates.append((deps_field_id, {"text": ",".join(t.dependencies or [])}))
                        updates.append((wall_days_field_id, {"text": str(t.wall_days or 0)}))
                        updates.append((billable_days_field_id, {"text": str(t.billable_days or 0)}))
                        updates.append((status_field_id, {"singleSelectOptionId": status_option_ids[desired_status]}))
                        if sch_start:
                            updates.append((start_date_field_id, {"date": sch_start}))
                        if sch_end:
                            updates.append((end_date_field_id, {"date": sch_end}))
                        client.set_fields_bulk(item_id=item_id, updates=updates)
                        out.added_existing_issues += 1
                        # best-effort update to match local fields
                        _submit_issue_update(
                            key=task_id,
                            issue_url=t.url,
                            title=title or "(untitled)",
                            body=body,
                            labels=labels,
                            assignees=assignees,
                        )
                    elif (task_repo or issue_repo):
                        # Create a real repo issue, add to project, then update fields.
                        target_repo = task_repo or issue_repo
                        labels_safe = client.ensure_labels_exist(repo=target_repo, labels=labels)
                        created_url = client.create_issue_rest(
                            repo=target_repo,
                            title=title or "(untitled)",
                            body=body,
                            labels=labels_safe,
                            assignees=assignees,
                        )
                        owner, repo, number = client.parse_issue_url(created_url)
                        issue_node_id = client.resolve_issue_node_id(owner=owner, repo=repo, number=number)
                        item_id = client.add_issue_item(issue_node_id=issue_node_id)
                        updates: list[tuple[str, dict[str, Any]]] = []
                        updates.append((task_id_field_id, {"text": task_id}))
                        if project_name_field_id and project_name_value:
                            updates.append((project_name_field_id, {"text": project_name_value}))
                        if getattr(t, "display_task_id", None):
                            updates.append((display_id_field_id, {"text": str(t.display_task_id)}))
                        updates.append((phase_field_id, {"text": (t.phase or "")}))
                        updates.append((deps_field_id, {"text": ",".join(t.dependencies or [])}))
                        updates.append((wall_days_field_id, {"text": str(t.wall_days or 0)}))
                        updates.append((billable_days_field_id, {"text": str(t.billable_days or 0)}))
                        updates.append((status_field_id, {"singleSelectOptionId": status_option_ids[desired_status]}))
                        if sch_start:
                            updates.append((start_date_field_id, {"date": sch_start}))
                        if sch_end:
                            updates.append((end_date_field_id, {"date": sch_end}))
                        client.set_fields_bulk(item_id=item_id, updates=updates)
                        out.added_existing_issues += 1
                        out.updated_issues += 1
                    else:
                        item_id = client.add_draft_issue(title=title or "(untitled)", body=body)
                        updates: list[tuple[str, dict[str, Any]]] = []
                        updates.append((task_id_field_id, {"text": task_id}))
                        if project_name_field_id and project_name_value:
                            updates.append((project_name_field_id, {"text": project_name_value}))
                        if getattr(t, "display_task_id", None):
                            updates.append((display_id_field_id, {"text": str(t.display_task_id)}))
                        updates.append((phase_field_id, {"text": (t.phase or "")}))
                        updates.append((deps_field_id, {"text": ",".join(t.dependencies or [])}))
                        updates.append((wall_days_field_id, {"text": str(t.wall_days or 0)}))
                        updates.append((billable_days_field_id, {"text": str(t.billable_days or 0)}))
                        updates.append((status_field_id, {"singleSelectOptionId": status_option_ids[desired_status]}))
                        if sch_start:
                            updates.append((start_date_field_id, {"date": sch_start}))
                        if sch_end:
                            updates.append((end_date_field_id, {"date": sch_end}))
                        client.set_fields_bulk(item_id=item_id, updates=updates)
                        out.created_draft_issues += 1
            except Exception as e:
                out.errors.append(f"{task_id}: {e}")

        # --- Phase meta issues (one per phase) ---
        try:
            from uuid import NAMESPACE_URL, uuid5

            # Group tasks by phase
            tasks_by_phase: dict[str, list[Any]] = {}
            for t in gantt.tasks:
                ph = (getattr(t, "phase", None) or "Unphased").strip() or "Unphased"
                tasks_by_phase.setdefault(ph, []).append(t)

            # Choose a default repo for meta issues when not explicitly provided.
            default_meta_repo: Optional[str] = issue_repo
            if not default_meta_repo:
                for t in gantt.tasks:
                    if getattr(t, "url", None):
                        try:
                            owner, repo, _ = client.parse_issue_url(t.url)
                            default_meta_repo = f"{owner}/{repo}"
                            break
                        except Exception:
                            continue

            def _phase_major_for(ts: list[Any]) -> Optional[int]:
                import re

                majors: list[int] = []
                for x in ts:
                    s = (getattr(x, "display_task_id", None) or "").strip()
                    m = re.match(r"^(\d+)\.(\d+)$", s)
                    if m:
                        majors.append(int(m.group(1)))
                if not majors:
                    return None
                return max(set(majors), key=lambda v: (majors.count(v), -v))

            def _format_ref(meta_repo: Optional[str], issue_url: str) -> str:
                owner, repo, number = client.parse_issue_url(issue_url)
                if meta_repo and meta_repo.lower() == f"{owner}/{repo}".lower():
                    return f"#{number}"
                return f"{owner}/{repo}#{number}"

            for phase, ts in tasks_by_phase.items():
                # Deterministic Task ID for phase meta issue so we can update it idempotently.
                phase_task_id = str(uuid5(NAMESPACE_URL, f"kanlytics:phase:{payload.project_url}:{phase}"))
                rec = by_task_id.get(phase_task_id)

                meta_repo = default_meta_repo
                if rec and rec.get("issue_url"):
                    try:
                        owner, repo, _ = client.parse_issue_url(rec["issue_url"])
                        meta_repo = f"{owner}/{repo}"
                    except Exception:
                        pass
                title = phase

                # Meta schedule range: earliest sub-task start to latest sub-task end (if available).
                meta_start: Optional[str] = None
                meta_end: Optional[str] = None
                for x in ts:
                    xid = getattr(x, "id", None)
                    if not xid:
                        continue
                    sch = schedule_by_id.get(str(xid)) or {}
                    s = sch.get("start")
                    e = sch.get("end")
                    if s:
                        meta_start = s if meta_start is None else min(meta_start, s)
                    if e:
                        meta_end = e if meta_end is None else max(meta_end, e)

                # Build checklist body
                lines: list[str] = [PHASE_META_MARKER, f"## {phase}", ""]
                # Stable ordering: by display_task_id when present, else by title
                ts_sorted = ts[:]
                ts_sorted.sort(key=lambda x: ((getattr(x, "display_task_id", None) or "").strip(), (getattr(x, "title", None) or getattr(x, "name", "")).strip().lower()))
                for x in ts_sorted:
                    xt = (getattr(x, "title", None) or getattr(x, "name", "") or "").strip() or "(untitled)"
                    xurl = (getattr(x, "url", None) or "").strip()
                    if xurl:
                        ref = _format_ref(meta_repo, xurl)
                        lines.append(f"- [ ] {ref} {xt}")
                    else:
                        disp = (getattr(x, "display_task_id", None) or getattr(x, "task_id", None) or getattr(x, "id", None) or "").strip()
                        if disp:
                            lines.append(f"- [ ] {disp} {xt}")
                        else:
                            lines.append(f"- [ ] {xt}")
                body = "\n".join(lines).strip() + "\n"

                # Create/update meta issue item
                if rec:
                    # Ensure identifying fields
                    mj = _phase_major_for(ts)
                    project_name_value = (payload.project_name or "").strip()
                    updates: list[tuple[str, dict[str, Any]]] = []
                    updates.append((task_id_field_id, {"text": phase_task_id}))
                    if mj is not None:
                        updates.append((display_id_field_id, {"text": f"{mj}.0"}))
                    updates.append((phase_field_id, {"text": phase}))
                    updates.append((deps_field_id, {"text": ""}))
                    updates.append((wall_days_field_id, {"text": "0"}))
                    updates.append((billable_days_field_id, {"text": "0"}))
                    updates.append((status_field_id, {"singleSelectOptionId": status_option_ids["Backlog"]}))
                    if meta_start:
                        updates.append((start_date_field_id, {"date": meta_start}))
                    if meta_end:
                        updates.append((end_date_field_id, {"date": meta_end}))
                    if project_name_field_id and project_name_value:
                        updates.append((project_name_field_id, {"text": project_name_value}))
                    client.set_fields_bulk(item_id=rec["item_id"], updates=updates)

                    if rec["type"] == "Issue":
                        issue_url = rec.get("issue_url")
                        if issue_url:
                            _submit_issue_update(
                                key=f"phase-meta:{phase_task_id}",
                                issue_url=issue_url,
                                title=title,
                                body=body,
                                labels=["kanlytics:phase"],
                                assignees=[],
                            )
                    else:
                        draft_id = rec.get("draft_issue_id")
                        if draft_id:
                            client.update_draft_issue(draft_issue_id=draft_id, title=title, body=body)
                else:
                    # Prefer creating a real issue so we can use #123 references.
                    created_item_id: Optional[str] = None
                    if meta_repo:
                        labels_safe = client.ensure_labels_exist(repo=meta_repo, labels=["kanlytics:phase"])
                        created_url = client.create_issue_rest(repo=meta_repo, title=title, body=body, labels=labels_safe, assignees=[])
                        try:
                            owner2, repo2, _ = client.parse_issue_url(created_url)
                            meta_repo = f"{owner2}/{repo2}"
                        except Exception:
                            pass
                        owner, repo, number = client.parse_issue_url(created_url)
                        issue_node_id = client.resolve_issue_node_id(owner=owner, repo=repo, number=number)
                        created_item_id = client.add_issue_item(issue_node_id=issue_node_id)
                    else:
                        created_item_id = client.add_draft_issue(title=title, body=body)

                    if created_item_id:
                        mj = _phase_major_for(ts)
                        updates: list[tuple[str, dict[str, Any]]] = []
                        updates.append((task_id_field_id, {"text": phase_task_id}))
                        if mj is not None:
                            updates.append((display_id_field_id, {"text": f"{mj}.0"}))
                        updates.append((phase_field_id, {"text": phase}))
                        updates.append((deps_field_id, {"text": ""}))
                        updates.append((wall_days_field_id, {"text": "0"}))
                        updates.append((billable_days_field_id, {"text": "0"}))
                        updates.append((status_field_id, {"singleSelectOptionId": status_option_ids["Backlog"]}))
                        if meta_start:
                            updates.append((start_date_field_id, {"date": meta_start}))
                        if meta_end:
                            updates.append((end_date_field_id, {"date": meta_end}))
                        project_name_value = (payload.project_name or "").strip()
                        if project_name_field_id and project_name_value:
                            updates.append((project_name_field_id, {"text": project_name_value}))
                        client.set_fields_bulk(item_id=created_item_id, updates=updates)
        except Exception as e:
            out.errors.append(f"phase-meta: {e}")

        # Wait for background issue updates (REST) to finish.
        if issue_update_futures:
            for fut in as_completed(list(issue_update_futures.keys())):
                key = issue_update_futures.get(fut, "unknown")
                try:
                    fut.result()
                    if not str(key).startswith("phase-meta:"):
                        out.updated_issues += 1
                except Exception as e:
                    out.errors.append(f"{key}: {e}")

        pool.shutdown(wait=True)

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
                # Parallelize slow REST issue updates (PATCH /issues/...) while keeping ProjectV2 mutations
                # batched and sequential (GraphQL is already fast once batched).
                max_workers = int(os.getenv("KANLYTICS_GITHUB_EXPORT_WORKERS", "6") or "6")
                issue_update_futures: dict[Any, str] = {}

                with ThreadPoolExecutor(max_workers=max_workers) as pool:
                    def _submit_issue_update(*, key: str, issue_url: str, title: str, body: str, labels: list[str], assignees: list[str]) -> None:
                        def work() -> None:
                            owner, repo, _ = client.parse_issue_url(issue_url)
                            labels_safe = client.ensure_labels_exist(repo=f"{owner}/{repo}", labels=labels)
                            client.update_issue_rest(issue_url=issue_url, title=title, body=body, labels=labels_safe, assignees=assignees)

                        fut = pool.submit(work)
                        issue_update_futures[fut] = key

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
                                updates: list[tuple[str, dict[str, Any]]] = []
                                updates.append((task_id_field_id, {"text": task_id}))
                                if project_name_field_id and project_name_value:
                                    updates.append((project_name_field_id, {"text": project_name_value}))
                                if getattr(t, "display_task_id", None):
                                    updates.append((display_id_field_id, {"text": str(t.display_task_id)}))
                                updates.append((phase_field_id, {"text": (t.phase or "")}))
                                updates.append((deps_field_id, {"text": ",".join(t.dependencies or [])}))
                                updates.append((wall_days_field_id, {"text": str(t.wall_days or 0)}))
                                updates.append((billable_days_field_id, {"text": str(t.billable_days or 0)}))
                                updates.append((status_field_id, {"singleSelectOptionId": status_option_ids[desired_status]}))
                                if sch_start:
                                    updates.append((start_date_field_id, {"date": sch_start}))
                                if sch_end:
                                    updates.append((end_date_field_id, {"date": sch_end}))
                                client.set_fields_bulk(item_id=rec["item_id"], updates=updates)

                                if rec["type"] == "Issue":
                                    issue_url = t.url or rec.get("issue_url")
                                    if issue_url:
                                        _submit_issue_update(
                                            key=task_id,
                                            issue_url=issue_url,
                                            title=title or "(untitled)",
                                            body=body,
                                            labels=labels,
                                            assignees=assignees,
                                        )
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
                                    updates: list[tuple[str, dict[str, Any]]] = []
                                    updates.append((task_id_field_id, {"text": task_id}))
                                    if project_name_field_id and project_name_value:
                                        updates.append((project_name_field_id, {"text": project_name_value}))
                                    if getattr(t, "display_task_id", None):
                                        updates.append((display_id_field_id, {"text": str(t.display_task_id)}))
                                    updates.append((phase_field_id, {"text": (t.phase or "")}))
                                    updates.append((deps_field_id, {"text": ",".join(t.dependencies or [])}))
                                    updates.append((wall_days_field_id, {"text": str(t.wall_days or 0)}))
                                    updates.append((billable_days_field_id, {"text": str(t.billable_days or 0)}))
                                    updates.append((status_field_id, {"singleSelectOptionId": status_option_ids[desired_status]}))
                                    if sch_start:
                                        updates.append((start_date_field_id, {"date": sch_start}))
                                    if sch_end:
                                        updates.append((end_date_field_id, {"date": sch_end}))
                                    client.set_fields_bulk(item_id=item_id, updates=updates)
                                    out.added_existing_issues += 1
                                    _submit_issue_update(
                                        key=task_id,
                                        issue_url=t.url,
                                        title=title or "(untitled)",
                                        body=body,
                                        labels=labels,
                                        assignees=assignees,
                                    )
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
                                        updates: list[tuple[str, dict[str, Any]]] = []
                                        updates.append((task_id_field_id, {"text": task_id}))
                                        if project_name_field_id and project_name_value:
                                            updates.append((project_name_field_id, {"text": project_name_value}))
                                        if getattr(t, "display_task_id", None):
                                            updates.append((display_id_field_id, {"text": str(t.display_task_id)}))
                                        updates.append((phase_field_id, {"text": (t.phase or "")}))
                                        updates.append((deps_field_id, {"text": ",".join(t.dependencies or [])}))
                                        updates.append((wall_days_field_id, {"text": str(t.wall_days or 0)}))
                                        updates.append((billable_days_field_id, {"text": str(t.billable_days or 0)}))
                                        updates.append((status_field_id, {"singleSelectOptionId": status_option_ids[desired_status]}))
                                        if sch_start:
                                            updates.append((start_date_field_id, {"date": sch_start}))
                                        if sch_end:
                                            updates.append((end_date_field_id, {"date": sch_end}))
                                        client.set_fields_bulk(item_id=item_id, updates=updates)
                                        out.added_existing_issues += 1
                                    else:
                                        item_id = client.add_draft_issue(title=title or "(untitled)", body=body)
                                        updates: list[tuple[str, dict[str, Any]]] = []
                                        updates.append((task_id_field_id, {"text": task_id}))
                                        if project_name_field_id and project_name_value:
                                            updates.append((project_name_field_id, {"text": project_name_value}))
                                        if getattr(t, "display_task_id", None):
                                            updates.append((display_id_field_id, {"text": str(t.display_task_id)}))
                                        updates.append((phase_field_id, {"text": (t.phase or "")}))
                                        updates.append((deps_field_id, {"text": ",".join(t.dependencies or [])}))
                                        updates.append((wall_days_field_id, {"text": str(t.wall_days or 0)}))
                                        updates.append((billable_days_field_id, {"text": str(t.billable_days or 0)}))
                                        updates.append((status_field_id, {"singleSelectOptionId": status_option_ids[desired_status]}))
                                        if sch_start:
                                            updates.append((start_date_field_id, {"date": sch_start}))
                                        if sch_end:
                                            updates.append((end_date_field_id, {"date": sch_end}))
                                        client.set_fields_bulk(item_id=item_id, updates=updates)
                                        out.created_draft_issues += 1
                        except Exception as e:
                            out.errors.append(f"{task_id}: {e}")

                    # --- Phase meta issues (one per phase) ---
                    # Ensure each phase has a corresponding "meta issue" on the project board.
                    try:
                        from uuid import NAMESPACE_URL, uuid5

                        # Group tasks by phase
                        tasks_by_phase: dict[str, list[Any]] = {}
                        for t in gantt.tasks:
                            ph = (getattr(t, "phase", None) or "Unphased").strip() or "Unphased"
                            tasks_by_phase.setdefault(ph, []).append(t)

                        # Choose a default repo for meta issues when not explicitly provided.
                        default_meta_repo: Optional[str] = issue_repo
                        if not default_meta_repo:
                            for t in gantt.tasks:
                                if getattr(t, "url", None):
                                    try:
                                        owner, repo, _ = client.parse_issue_url(t.url)
                                        default_meta_repo = f"{owner}/{repo}"
                                        break
                                    except Exception:
                                        continue

                        def _phase_major_for(ts: list[Any]) -> Optional[int]:
                            import re

                            majors: list[int] = []
                            for x in ts:
                                s = (getattr(x, "display_task_id", None) or "").strip()
                                m = re.match(r"^(\d+)\.(\d+)$", s)
                                if m:
                                    majors.append(int(m.group(1)))
                            if not majors:
                                return None
                            return max(set(majors), key=lambda v: (majors.count(v), -v))

                        def _format_ref(meta_repo: Optional[str], issue_url: str) -> str:
                            owner, repo, number = client.parse_issue_url(issue_url)
                            if meta_repo and meta_repo.lower() == f"{owner}/{repo}".lower():
                                return f"#{number}"
                            return f"{owner}/{repo}#{number}"

                        self._job_update(job_id, progress=96, message="Updating phase meta issues…")

                        for phase, ts in tasks_by_phase.items():
                            # Deterministic Task ID for phase meta issue so we can update it idempotently.
                            phase_task_id = str(uuid5(NAMESPACE_URL, f"kanlytics:phase:{payload.project_url}:{phase}"))
                            rec = by_task_id.get(phase_task_id)

                            meta_repo = default_meta_repo
                            if rec and rec.get("issue_url"):
                                try:
                                    owner, repo, _ = client.parse_issue_url(rec["issue_url"])
                                    meta_repo = f"{owner}/{repo}"
                                except Exception:
                                    pass
                            title = phase

                            # Meta schedule range: earliest sub-task start to latest sub-task end (if available).
                            meta_start: Optional[str] = None
                            meta_end: Optional[str] = None
                            for x in ts:
                                xid = getattr(x, "id", None)
                                if not xid:
                                    continue
                                sch = schedule_by_id.get(str(xid)) or {}
                                s = sch.get("start")
                                e = sch.get("end")
                                if s:
                                    meta_start = s if meta_start is None else min(meta_start, s)
                                if e:
                                    meta_end = e if meta_end is None else max(meta_end, e)

                            # Build checklist body
                            lines: list[str] = [PHASE_META_MARKER, f"## {phase}", ""]
                            ts_sorted = ts[:]
                            ts_sorted.sort(
                                key=lambda x: (
                                    (getattr(x, "display_task_id", None) or "").strip(),
                                    (getattr(x, "title", None) or getattr(x, "name", "")).strip().lower(),
                                )
                            )
                            for x in ts_sorted:
                                xt = (getattr(x, "title", None) or getattr(x, "name", "") or "").strip() or "(untitled)"
                                xurl = (getattr(x, "url", None) or "").strip()
                                if xurl:
                                    ref = _format_ref(meta_repo, xurl)
                                    lines.append(f"- [ ] {ref} {xt}")
                                else:
                                    disp = (
                                        (getattr(x, "display_task_id", None) or getattr(x, "task_id", None) or getattr(x, "id", None) or "")
                                        .strip()
                                    )
                                    if disp:
                                        lines.append(f"- [ ] {disp} {xt}")
                                    else:
                                        lines.append(f"- [ ] {xt}")
                            body = "\n".join(lines).strip() + "\n"

                            if rec:
                                mj = _phase_major_for(ts)
                                updates: list[tuple[str, dict[str, Any]]] = []
                                updates.append((task_id_field_id, {"text": phase_task_id}))
                                if mj is not None:
                                    updates.append((display_id_field_id, {"text": f"{mj}.0"}))
                                updates.append((phase_field_id, {"text": phase}))
                                updates.append((deps_field_id, {"text": ""}))
                                updates.append((wall_days_field_id, {"text": "0"}))
                                updates.append((billable_days_field_id, {"text": "0"}))
                                updates.append((status_field_id, {"singleSelectOptionId": status_option_ids["Backlog"]}))
                                if meta_start:
                                    updates.append((start_date_field_id, {"date": meta_start}))
                                if meta_end:
                                    updates.append((end_date_field_id, {"date": meta_end}))
                                project_name_value = (payload.project_name or "").strip()
                                if project_name_field_id and project_name_value:
                                    updates.append((project_name_field_id, {"text": project_name_value}))
                                client.set_fields_bulk(item_id=rec["item_id"], updates=updates)

                                if rec["type"] == "Issue":
                                    issue_url = rec.get("issue_url")
                                    if issue_url:
                                        _submit_issue_update(
                                            key=f"phase-meta:{phase_task_id}",
                                            issue_url=issue_url,
                                            title=title,
                                            body=body,
                                            labels=["kanlytics:phase"],
                                            assignees=[],
                                        )
                                else:
                                    draft_id = rec.get("draft_issue_id")
                                    if draft_id:
                                        client.update_draft_issue(draft_issue_id=draft_id, title=title, body=body)
                            else:
                                created_item_id: Optional[str] = None
                                if meta_repo:
                                    labels_safe = client.ensure_labels_exist(repo=meta_repo, labels=["kanlytics:phase"])
                                    created_url = client.create_issue_rest(
                                        repo=meta_repo, title=title, body=body, labels=labels_safe, assignees=[]
                                    )
                                    owner, repo, number = client.parse_issue_url(created_url)
                                    issue_node_id = client.resolve_issue_node_id(owner=owner, repo=repo, number=number)
                                    created_item_id = client.add_issue_item(issue_node_id=issue_node_id)
                                else:
                                    created_item_id = client.add_draft_issue(title=title, body=body)

                                if created_item_id:
                                    mj = _phase_major_for(ts)
                                    updates: list[tuple[str, dict[str, Any]]] = []
                                    updates.append((task_id_field_id, {"text": phase_task_id}))
                                    if mj is not None:
                                        updates.append((display_id_field_id, {"text": f"{mj}.0"}))
                                    updates.append((phase_field_id, {"text": phase}))
                                    updates.append((deps_field_id, {"text": ""}))
                                    updates.append((wall_days_field_id, {"text": "0"}))
                                    updates.append((billable_days_field_id, {"text": "0"}))
                                    updates.append((status_field_id, {"singleSelectOptionId": status_option_ids["Backlog"]}))
                                    if meta_start:
                                        updates.append((start_date_field_id, {"date": meta_start}))
                                    if meta_end:
                                        updates.append((end_date_field_id, {"date": meta_end}))
                                    project_name_value = (payload.project_name or "").strip()
                                    if project_name_field_id and project_name_value:
                                        updates.append((project_name_field_id, {"text": project_name_value}))
                                    client.set_fields_bulk(item_id=created_item_id, updates=updates)
                    except Exception as e:
                        out.errors.append(f"phase-meta: {e}")

                    # Wait for background issue updates (REST) to finish.
                    if issue_update_futures:
                        self._job_update(job_id, progress=97, message=f"Updating GitHub issues… ({len(issue_update_futures)})")
                        for fut in as_completed(list(issue_update_futures.keys())):
                            key = issue_update_futures.get(fut, "unknown")
                            try:
                                fut.result()
                                # Count task issue updates, but not phase-meta maintenance issues.
                                if not str(key).startswith("phase-meta:"):
                                    out.updated_issues += 1
                            except Exception as e:
                                out.errors.append(f"{key}: {e}")

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
        
        Note: This method strips metadata headers before parsing.
        """
        # Strip metadata headers before parsing
        _, csv_body = parse_csv_metadata(csv_text)
        
        fd, path = tempfile.mkstemp(suffix=".csv", text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(csv_body)
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
