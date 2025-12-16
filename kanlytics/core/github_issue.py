import re
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Sequence, Union
from uuid import UUID, uuid4

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator


class GitHubIssue(BaseModel):
    """
    Unified work item model used for:
    - GitHub Issues (loaded from REST/GraphQL)
    - Gantt tasks (loaded from CSV / edited in-app)

    This intentionally merges the prior `GitHubIssue` + Gantt `Task` shapes so the
    project can round-trip work items through GitHub + REST endpoints + Gantt views.
    """

    model_config = ConfigDict(
        validate_assignment=True,
        extra="ignore",
        populate_by_name=True,
    )

    # -----------------------------
    # Identifiers
    # -----------------------------
    # CSV-first stable identifier. This is what dependencies should reference.
    # We keep the column name exactly as requested: "Task ID".
    task_id: Optional[str] = Field(
        default=None,
        alias="Task ID",
        description="Stable task identifier (recommend a locally generated UUID). Used for dependency edges and round-tripping.",
    )

    # Human-friendly identifier for display + ordering (e.g. 3.2, 5.1, 5.5).
    # In templates this is required and is the ground truth for dependencies.
    # We accept the old column name "Template Task ID" for compatibility.
    display_task_id: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("Display Task ID", "Template Task ID"),
        serialization_alias="Display Task ID",
        description="Human-friendly display identifier (e.g. 3.2). Required in templates; used for ordering and presentation.",
    )

    # Canonical ID used internally by the library/scheduler.
    # Convention:
    # - Use `task_id` (stable, UUID).
    # - GitHub `url`/`number` are identifiers *on the remote*, but not dependency keys.
    id: Optional[str] = Field(
        default=None,
        description="Canonical unique work-item ID used internally (defaults to `Task ID`).",
    )
    url: Optional[str] = Field(
        default=None,
        description="GitHub issue URL (when sourced from GitHub). If provided and `id` is missing, `id` defaults to this.",
    )

    # -----------------------------
    # GitHub issue-like fields (optional for CSV/manual tasks)
    # -----------------------------
    number: Optional[int] = Field(default=None, description="GitHub issue number (if applicable).")
    title: str = Field(default="", description="Title/summary of the work item.")
    body: str = Field(default="", description="Description/body text (GitHub issue body or task description).")
    state: Optional[str] = Field(default=None, description="Issue state: 'open' or 'closed' (if applicable).")
    created_at: Optional[datetime] = Field(default=None, description="Creation timestamp (if applicable).")
    updated_at: Optional[datetime] = Field(default=None, description="Last update timestamp (if applicable).")
    closed_at: Optional[datetime] = Field(default=None, description="Close timestamp (if closed).")
    # Normalized forms (CSV-friendly): list of logins / label names.
    # These validators accept GitHub REST/GraphQL shapes too (list of dicts).
    assignees: List[str] = Field(
        default_factory=list,
        alias="Assignees",
        description="Assignee GitHub logins.",
    )
    labels: List[str] = Field(
        default_factory=list,
        alias="Labels",
        description="Label names.",
    )
    status_history: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Project-board status history (optional).",
    )

    # -----------------------------
    # Gantt/task planning fields
    # -----------------------------
    phase: str = Field(default="", description="Grouping bucket (e.g., release/milestone/phase).")
    name: str = Field(default="", description="Task name (synced with title).")
    details: str = Field(default="", description="Task details (synced with body).")
    milestone_or_output: str = Field(default="", description="Milestone / output (optional).")
    expected_output: Optional[str] = Field(
        default=None,
        description="Optional expected output (synced to milestone_or_output when only one is provided).",
    )
    acceptance_criteria: str = Field(default="", description="Acceptance criteria for the work item/task.")

    dependencies: List[str] = Field(
        default_factory=list,
        alias="Dependencies",
        description="Upstream dependency IDs (prefer full issue URLs when sourced from GitHub).",
    )

    # Optional: display-level dependencies (for templates / human editing).
    # We accept the old "Template Dependencies" header for compatibility.
    display_dependencies: List[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("Display Dependencies", "Template Dependencies"),
        serialization_alias="Display Dependencies",
        description="Human-friendly dependency identifiers (references Display Task ID values).",
    )

    # Durations (calendar/working interpretation is a scheduling concern)
    wall_days: float = Field(default=0.0, description="Planned wall-time duration in days.")
    billable_days: float = Field(default=0.0, description="Planned billable/effort duration in days.")
    effort_days: Optional[float] = Field(
        default=None,
        description="Legacy alias for planned effort in days. If provided, populates billable_days.",
    )

    # Optional planned window (lossless interchange)
    start_date: Optional[date] = Field(default=None, description="Planned start date (YYYY-MM-DD).")
    end_date: Optional[date] = Field(default=None, description="Planned end date (YYYY-MM-DD).")

    roles: Dict[str, Any] = Field(default_factory=dict, description="Role allocation metadata (optional).")
    notes: str = Field(default="", description="Freeform notes (optional).")

    # Derived / convenience
    time_estimate: Optional[str] = Field(
        default=None,
        description="Best-effort extracted time estimate from body/details (legacy/optional).",
    )

    # -----------------------------
    # Field validators / normalizers
    # -----------------------------

    @field_validator("id", mode="before")
    @classmethod
    def _strip_id(cls, v: Any) -> Any:
        if v is None:
            return None
        s = str(v).strip()
        return s if s else None

    @field_validator("task_id", mode="before")
    @classmethod
    def _strip_task_id(cls, v: Any) -> Any:
        if v is None:
            return None
        s = str(v).strip()
        return s if s else None

    @field_validator("display_task_id", mode="before")
    @classmethod
    def _strip_display_task_id(cls, v: Any) -> Any:
        if v is None:
            return None
        s = str(v).strip()
        return s if s else None

    @field_validator("task_id")
    @classmethod
    def _validate_task_id_uuid(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        try:
            # Normalize to canonical UUID string format
            return str(UUID(v))
        except Exception as e:
            raise ValueError("Task ID must be a valid UUID string") from e

    @field_validator("url", mode="before")
    @classmethod
    def _strip_url(cls, v: Any) -> Any:
        if v is None:
            return None
        s = str(v).strip()
        return s if s else None

    @field_validator("state", mode="before")
    @classmethod
    def _normalize_state(cls, v: Any) -> Any:
        if v is None:
            return None
        s = str(v).strip().lower()
        return s if s else None

    @field_validator("phase", "name", "title", "milestone_or_output", "details", "body", "notes", mode="before")
    @classmethod
    def _strip_strings(cls, v: Any) -> Any:
        if v is None:
            return ""
        return str(v)

    @field_validator("wall_days", "billable_days", mode="before")
    @classmethod
    def _coerce_days(cls, v: Any) -> float:
        if v is None:
            return 0.0
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).strip()
        if s in {"", "-", "—"}:
            return 0.0
        try:
            return float(s)
        except ValueError as e:
            raise ValueError(f"Invalid day value: {v!r}") from e

    @field_validator("dependencies", "display_dependencies", mode="before")
    @classmethod
    def _normalize_dependencies(cls, v: Any) -> List[str]:
        """
        Accept:
        - list/tuple of strings
        - a single comma-separated string
        Normalize into a de-duped list of non-empty IDs.
        """
        if v is None:
            return []
        if isinstance(v, str):
            parts = [p.strip() for p in v.split(",")]
        elif isinstance(v, Sequence):
            parts = []
            for item in v:
                if item is None:
                    continue
                parts.append(str(item).strip())
        else:
            raise ValueError("dependencies must be a list/tuple of strings or a comma-separated string")

        out: List[str] = []
        seen: set[str] = set()
        for p in parts:
            if not p:
                continue
            if p not in seen:
                out.append(p)
                seen.add(p)
        return out

    @field_validator("labels", mode="before")
    @classmethod
    def _normalize_labels(cls, v: Any) -> List[str]:
        """
        Accept:
        - "bug,enhancement"
        - ["bug", "enhancement"]
        - [{"name": "bug"}, {"name": "enhancement"}] (GitHub REST)
        - {"nodes": [{"name": "bug"}]} (some GraphQL-ish shapes)
        Normalize into a de-duped list of non-empty label names.
        """
        if v is None:
            return []
        items: List[Any]
        if isinstance(v, str):
            items = [p.strip() for p in v.split(",")]
        elif isinstance(v, dict) and "nodes" in v and isinstance(v["nodes"], list):
            items = v["nodes"]
        elif isinstance(v, Sequence):
            items = list(v)
        else:
            raise ValueError("labels must be a list, comma-separated string, or GitHub label shape")

        out: List[str] = []
        seen: set[str] = set()
        for item in items:
            name: Optional[str] = None
            if item is None:
                continue
            if isinstance(item, str):
                name = item.strip()
            elif isinstance(item, dict):
                # REST label dict typically has "name"
                name = str(item.get("name", "")).strip()
            else:
                name = str(item).strip()
            if not name:
                continue
            if name.lower() not in seen:
                out.append(name)
                seen.add(name.lower())
        return out

    @field_validator("assignees", mode="before")
    @classmethod
    def _normalize_assignees(cls, v: Any) -> List[str]:
        """
        Accept:
        - "alice,bob"
        - ["alice", "bob"]
        - [{"login": "alice"}, {"login": "bob"}] (GitHub REST)
        - {"nodes": [{"login": "alice"}]} (some GraphQL-ish shapes)
        Normalize into a de-duped list of non-empty logins.
        """
        if v is None:
            return []
        items: List[Any]
        if isinstance(v, str):
            items = [p.strip() for p in v.split(",")]
        elif isinstance(v, dict) and "nodes" in v and isinstance(v["nodes"], list):
            items = v["nodes"]
        elif isinstance(v, Sequence):
            items = list(v)
        else:
            raise ValueError("assignees must be a list, comma-separated string, or GitHub assignee shape")

        out: List[str] = []
        seen: set[str] = set()
        for item in items:
            login: Optional[str] = None
            if item is None:
                continue
            if isinstance(item, str):
                login = item.strip()
            elif isinstance(item, dict):
                login = str(item.get("login", "")).strip()
            else:
                login = str(item).strip()
            if not login:
                continue
            if login.lower() not in seen:
                out.append(login)
                seen.add(login.lower())
        return out

    @model_validator(mode="after")
    def _validate_invariants(self) -> "GitHubIssue":
        # Validate dates
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date must be >= start_date")

        # Validate state + closed_at consistency (best-effort)
        if self.state is not None and self.state not in {"open", "closed"}:
            raise ValueError("state must be 'open' or 'closed'")
        if self.state == "open" and self.closed_at is not None:
            raise ValueError("closed_at must be null when state is 'open'")

        # Validate non-negative durations
        if self.wall_days < 0:
            raise ValueError("wall_days must be >= 0")
        if self.billable_days < 0:
            raise ValueError("billable_days must be >= 0")

        # Prevent self-dependency if possible
        if self.id and self.id in self.dependencies:
            raise ValueError("dependencies cannot include the task's own id")

        return self

    @model_validator(mode="before")
    @classmethod
    def _normalize_inputs(cls, data: Any) -> Any:
        """
        Normalize/sync fields without triggering assignment re-validation.

        Important: we do *not* mutate `self` in `mode="after"` because
        `validate_assignment=True` can cause recursive validation loops.
        """
        if isinstance(data, cls):
            return data
        if data is None:
            raise ValueError("Input data is required")
        if not isinstance(data, dict):
            # let pydantic try other coercions (e.g. object with attributes)
            try:
                data = dict(data)  # type: ignore[arg-type]
            except Exception:
                return data

        d: Dict[str, Any] = dict(data)

        # Ensure task_id exists (CSV + ProjectV2 field "Task ID").
        # If an item was created manually on GitHub and lacks a Task ID, we generate one
        # so the importer can write it back to the ProjectV2 "Task ID" field.
        raw_id = d.get("id")
        raw_url = d.get("url")
        raw_task_id = d.get("task_id") if "task_id" in d else d.get("Task ID")

        # Ensure we retain task_id if provided via alias
        if d.get("task_id") in (None, "") and raw_task_id not in (None, ""):
            d["task_id"] = raw_task_id

        if d.get("task_id") in (None, ""):
            d["task_id"] = str(uuid4())

        # Ensure we retain display_task_id if provided via alias
        raw_display_id = (
            d.get("display_task_id")
            if "display_task_id" in d
            else d.get("Display Task ID", d.get("Template Task ID"))
        )
        if d.get("display_task_id") in (None, "") and raw_display_id not in (None, ""):
            d["display_task_id"] = raw_display_id

        # Canonical internal ID is always Task ID (stable dependency key).
        if raw_id not in (None, "") and str(raw_id).strip() not in (None, ""):
            # If caller passes id explicitly, require it matches task_id to avoid split identity.
            if str(raw_id).strip() != str(d["task_id"]).strip():
                raise ValueError("If `id` is provided it must match `Task ID` (Task ID is the canonical identifier).")

        d["id"] = d["task_id"]

        # Sync title/name (support both call sites)
        title = d.get("title")
        name = d.get("name")
        if title not in (None, "") and name in (None, ""):
            d["name"] = title
        elif name not in (None, "") and title in (None, ""):
            d["title"] = name

        # Sync body/details
        body = d.get("body")
        details = d.get("details")
        if body not in (None, "") and details in (None, ""):
            d["details"] = body
        elif details not in (None, "") and body in (None, ""):
            d["body"] = details

        # Sync milestone/expected_output
        expected_output = d.get("expected_output")
        milestone = d.get("milestone_or_output")
        if expected_output not in (None, "") and milestone in (None, ""):
            d["milestone_or_output"] = expected_output
        elif milestone not in (None, "") and expected_output in (None, ""):
            d["expected_output"] = milestone

        # Legacy alias: effort_days -> billable_days (only if billable_days isn't explicitly set)
        effort_days = d.get("effort_days")
        billable_days = d.get("billable_days")
        if effort_days is not None and (billable_days is None or billable_days in ("", 0, 0.0)):
            d["billable_days"] = effort_days

        # Compute time_estimate if missing
        if d.get("time_estimate") is None:
            text = d.get("body") or d.get("details") or ""
            d["time_estimate"] = cls._extract_time_estimate(str(text))

        return d

    @staticmethod
    def _extract_time_estimate(text: str) -> Optional[str]:
        """Extract a best-effort time estimate from body/details."""
        if not text:
            return None

        patterns = [
            r"time estimate[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(hours?|days?|weeks?|months?)",
            r"estimated time[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(hours?|days?|weeks?|months?)",
            r"estimate[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(hours?|days?|weeks?|months?)",
            r"effort[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(hours?|days?|weeks?|months?)",
            r"story points[:\s]*([0-9]+(?:\.[0-9]+)?)",
            r"points[:\s]*([0-9]+(?:\.[0-9]+)?)",
        ]

        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                value = match.group(1)
                unit = match.group(2) if len(match.groups()) > 1 else "points"
                return f"{value} {unit}"

        return None
