from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple, Union
import csv
import math
import re
import uuid

from kanlytics.core.github_issue import GitHubIssue


DateLike = Union[date, datetime, str]


from dataclasses import dataclass


@dataclass(frozen=True)
class ScheduledTask:
    """
    A task with computed schedule and layout properties.
    """
    task: GitHubIssue
    start: date
    end: date  # inclusive end date
    start_offset_days: int
    duration_days: int  # in chosen day units (calendar days or working days)
    row: int


class Gantt:
    """
    Gantt plan loader + scheduler + layout engine.

    Design goals:
    - Keep the backend in pure Python (no Pandas required).
    - Normalize "two header rows" CSVs like your checklist.
    - Schedule by dependencies from a user-provided project start date.
    - Default scheduling duration uses "wall days".

    Key concepts:
    - A task's earliest start is the day AFTER all its dependencies end.
    - Duration is interpreted as number of days; default uses calendar days.
      (You can enable working-days scheduling.)

    Example::
        gantt = Gantt.from_csv("tasks.csv")
        gantt.schedule(start_date="2026-01-05")  # default uses wall days
        data = gantt.export_layout()
        # data is JSON-serializable and ready for a frontend.
    """

    def __init__(self, tasks: List[GitHubIssue]) -> None:
        self._tasks: List[GitHubIssue] = tasks
        self._task_by_id: Dict[str, GitHubIssue] = {t.id: t for t in tasks}

        self._scheduled: Dict[str, ScheduledTask] = {}
        self._last_schedule_meta: Dict[str, Any] = {}
        self._slack_days_by_id: Dict[str, int] = {}
        self._critical_path: List[str] = []

        self._validate_unique_ids()
        self._validate_dependency_refs()

    # -----------------------------
    # Construction / Loading
    # -----------------------------

    @classmethod
    def from_csv(cls, path: str) -> "Gantt":
        """
        Load tasks from the V2 template CSV format (single header row).

        Template workflow (Option A):
        - `Display Task ID` is a stable, human-friendly identifier used in templates (e.g. 3.2).
        - `Task ID` is a UUID that is generated the first time a template is instantiated.
        - In templates, `Dependencies` may reference Display Task IDs; on first load,
          we remap them into UUID `Dependencies` using the generated `Task ID`s.

        Example::
            g = Gantt.from_csv("/path/to/template.csv")
        """
        with open(path, "r", newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        if not rows:
            return cls([])

        def get(r: Dict[str, Any], key: str) -> str:
            return (r.get(key) or "").strip()

        # Pass 1: determine/generate UUID Task IDs and build display-id mapping
        display_to_task: Dict[str, str] = {}
        items: List[Dict[str, Any]] = []

        for r in rows:
            # Skip empty lines
            if all((v or "").strip() == "" for v in r.values()):
                continue

            display_id = get(r, "Display Task ID") or get(r, "Template Task ID")
            raw_task_id = get(r, "Task ID")
            task_id = raw_task_id

            if display_id == "" and task_id == "":
                raise ValueError("Each row must have at least 'Display Task ID' (or legacy 'Template Task ID') or 'Task ID'")

            # If Task ID is missing, GitHubIssue will auto-generate it, but we need the
            # mapping now to remap template dependencies deterministically.
            if task_id == "":
                task_id = str(uuid.uuid4())

            if display_id:
                if display_id in display_to_task and display_to_task[display_id] != task_id:
                    raise ValueError(f"Duplicate Display Task ID with conflicting Task IDs: {display_id}")
                display_to_task[display_id] = task_id

            items.append(
                {
                    "row": r,
                    "display_id": display_id,
                    "task_id": task_id,
                    "had_task_id": bool(raw_task_id),
                }
            )

        # Pass 2: remap dependencies and build GitHubIssue objects
        tasks: List[GitHubIssue] = []
        for it in items:
            r = it["row"]
            display_id = it["display_id"]
            task_id = it["task_id"]
            had_task_id = it["had_task_id"]

            deps_uuid: List[str] = []
            deps_raw = get(r, "Dependencies")
            display_deps_raw = get(r, "Display Dependencies") or get(r, "Template Dependencies")

            if had_task_id:
                # Instantiated project CSV: dependencies are already canonical IDs (UUIDs/URLs).
                deps_uuid = cls._parse_dependencies(deps_raw)
            else:
                # Template CSV: treat deps as Display Task IDs and remap to UUID Task IDs.
                # Prefer Dependencies column for template deps; fall back to Display/Template Dependencies if present.
                src = deps_raw or display_deps_raw
                for dep in cls._parse_dependencies(src):
                    if dep not in display_to_task:
                        raise ValueError(f"Missing Display Task ID referenced in Dependencies: {dep}")
                    deps_uuid.append(display_to_task[dep])

            # Minimal role support in V2: either provide JSON-ish `roles` later, or keep columns.
            roles: Dict[str, Any] = {}
            for role_key in (
                "role_pm",
                "role_sales",
                "role_tech_lead",
                "role_onsite_engr",
                "role_cad",
                "role_engr",
                "role_integrator",
                "role_client",
            ):
                v = get(r, role_key)
                if v:
                    roles[role_key.replace("role_", "")] = v

            tasks.append(
                GitHubIssue(
                    **{
                        "Display Task ID": display_id,
                        "Task ID": task_id,
                        "project_name": get(r, "project_name") or get(r, "Project Name"),
                        "phase": get(r, "phase"),
                        "status": get(r, "status") or get(r, "Status") or None,
                        "title": get(r, "title"),
                        "body": get(r, "body"),
                        "milestone_or_output": get(r, "milestone_or_output"),
                        "acceptance_criteria": get(r, "acceptance_criteria"),
                        "Dependencies": ",".join(deps_uuid),
                        "start_date": get(r, "start_date") or None,
                        "end_date": get(r, "end_date") or None,
                        "wall_days": cls._to_float(get(r, "wall_days")),
                        "billable_days": cls._to_float(get(r, "billable_days")),
                        "Labels": get(r, "Labels"),
                        "Assignees": get(r, "Assignees"),
                        "notes": get(r, "notes"),
                        "url": get(r, "url") or None,
                        "number": (int(get(r, "number")) if get(r, "number").isdigit() else None),
                        "state": get(r, "state") or None,
                        "roles": roles,
                    }
                )
            )

        return cls(tasks)

    @staticmethod
    def _read_csv_rows(path: str) -> List[Dict[str, str]]:
        """
        Read CSV into a list of row dicts with *stable, unique* column names.

        This CSV contains multiple blank column headers (""), and csv.DictReader
        will overwrite duplicate keys, causing us to lose important columns
        (notably the "Wall" duration column).

        Strategy:
        - Read the first row as raw headers.
        - Replace blank headers with pandas-like "Unnamed: {idx}" names.
        - De-duplicate repeated headers by appending ".{n}" suffixes.
        - Map subsequent rows onto these stable headers.
        """
        with open(path, "r", newline="", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            rows = list(reader)

        if not rows:
            return []

        raw_headers = rows[0]
        headers: List[str] = []
        seen: Dict[str, int] = {}

        for idx, h in enumerate(raw_headers):
            name = (h or "").strip()
            if name == "":
                name = f"Unnamed: {idx}"

            if name in seen:
                seen[name] += 1
                name = f"{name}.{seen[name]}"
            else:
                seen[name] = 0

            headers.append(name)

        out: List[Dict[str, str]] = []
        for row in rows[1:]:
            d: Dict[str, str] = {}
            for i, col in enumerate(headers):
                d[col] = row[i] if i < len(row) else ""
            out.append(d)

        return out

    @staticmethod
    def _build_normalization_map(metadata_row: Dict[str, str]) -> Dict[str, Any]:
        """
        Creates a mapping that tells us where the billable/wall columns really are
        and captures role columns from the metadata row.
        """
        # Detect the Billable/Wall source columns from the metadata row values.
        # (Row 2 of the CSV contains the strings "Billable" and "Wall".)
        billable_src = next(
            (col for col, val in metadata_row.items() if (val or "").strip().lower() == "billable"),
            "Expected Time (Days)",
        )
        wall_src = next(
            (col for col, val in metadata_row.items() if (val or "").strip().lower() == "wall"),
            "Unnamed: 7",
        )

        # Identify role columns by reading the metadata row values
        role_cols: Dict[str, str] = {}
        for col, val in metadata_row.items():
            v = (val or "").strip()
            if v in {"PM", "Sales", "Tech Lead", "Onsite Engr", "CAD", "Engr", "Integrator", "Client"}:
                # Normalize role keys to snake_case for frontend friendliness
                key = re.sub(r"[^a-zA-Z0-9]+", "_", v).strip("_").lower()
                role_cols[col] = key

        # Notes column heuristic: last unnamed column sometimes used
        notes_src = "Unnamed: 19" if "Unnamed: 19" in metadata_row else ""

        return {
            "billable_days_src": billable_src,
            "wall_days_src": wall_src,
            "role_cols": role_cols,
            "notes_src": notes_src,
        }

    @staticmethod
    def _normalize_task_id(raw: str) -> str:
        # Preserve strings like "1.10" and "2.0" without float coercion
        s = raw.strip()
        # If it looks like a number but came as "1.0", keep "1.0" (it is an ID)
        return s

    @staticmethod
    def _to_float(x: Any) -> float:
        s = ("" if x is None else str(x)).strip()
        if s in {"", "-", "—"}:
            return 0.0
        try:
            return float(s)
        except ValueError:
            return 0.0

    @staticmethod
    def _parse_dependencies(dep_str: str) -> List[str]:
        if not dep_str or dep_str in {"-", "—"}:
            return []
        parts = [p.strip() for p in dep_str.split(",")]
        return [p for p in parts if p]

    # -----------------------------
    # Validation
    # -----------------------------

    def _validate_unique_ids(self) -> None:
        seen: Set[str] = set()
        dups: List[str] = []
        for t in self._tasks:
            if t.id in seen:
                dups.append(t.id)
            seen.add(t.id)
        if dups:
            raise ValueError(f"Duplicate Task IDs found: {sorted(set(dups))}")

    def _validate_dependency_refs(self) -> None:
        missing: Dict[str, List[str]] = {}
        for t in self._tasks:
            for dep in t.dependencies:
                if dep not in self._task_by_id:
                    missing.setdefault(t.id, []).append(dep)
        if missing:
            # Don't fail silently; frontend needs to show this clearly.
            msg = ", ".join(f"{k} -> {v}" for k, v in missing.items())
            raise ValueError(f"Missing dependency references: {msg}")

    # -----------------------------
    # Public API
    # -----------------------------

    @property
    def tasks(self) -> List[GitHubIssue]:
        return list(self._tasks)

    def schedule(
        self,
        start_date: DateLike,
        *,
        duration_mode: str = "wall",
        working_days: bool = False,
        weekmask: Tuple[int, ...] = (0, 1, 2, 3, 4),  # Mon-Fri (0=Mon)
    ) -> None:
        """
        Compute schedule + row layout.

        Parameters
        ----------
        start_date:
            Project start date. Can be date, datetime, or ISO string "YYYY-MM-DD".
        duration_mode:
            "wall" (default) or "billable".
        working_days:
            If True, treat durations as working days (using weekmask).
        weekmask:
            Which weekdays count as working days when working_days=True.

        Example::
            g.schedule("2026-01-05")  # uses wall days by default
            g.schedule("2026-01-05", duration_mode="billable")
            g.schedule("2026-01-05", working_days=True)  # Mon-Fri by default
        """
        start = self._coerce_date(start_date)

        dur_getter = {
            "wall": lambda t: t.wall_days,
            "billable": lambda t: t.billable_days,
        }.get(duration_mode)

        if dur_getter is None:
            raise ValueError("duration_mode must be 'wall' or 'billable'")

        order = self._topological_order()

        scheduled: Dict[str, ScheduledTask] = {}

        # For now, row order follows topo order (stable + intuitive).
        # Later, we can pack rows by phase or try to minimize crossings/overlaps.
        for row_idx, task_id in enumerate(order):
            t = self._task_by_id[task_id]
            duration_raw = dur_getter(t)
            duration_days = max(0, int(math.ceil(duration_raw)))

            # Earliest start is project start OR day after max(dep end)
            est = start
            if t.dependencies:
                # A 0-day task is treated as a milestone: it does NOT consume a day and
                # should not force its successors to start "the next day".
                # For non-milestones, successors start the day after the predecessor ends.
                dep_ready = max(
                    (
                        scheduled[d].end
                        if scheduled[d].duration_days == 0
                        else self._add_days(scheduled[d].end, 1, working_days=working_days, weekmask=weekmask)
                    )
                    for d in t.dependencies
                )
                est = max(est, dep_ready)

            # If a task has an explicit planned window, we treat it as informational/derived by default
            # (e.g., pulled back from GitHub Project fields). To keep scheduling reactive to
            # working-days/weekend settings, we only use planned windows as constraints when the
            # task has no meaningful duration estimate (duration_days == 0).
            planned_start: Optional[date] = t.start_date if duration_days == 0 else None
            planned_end: Optional[date] = t.end_date if duration_days == 0 else None

            planned_duration_days: Optional[int] = None
            if planned_start and planned_end and planned_end >= planned_start:
                planned_duration_days = self._count_days_inclusive(planned_start, planned_end, working_days=working_days, weekmask=weekmask)
                duration_days = max(duration_days, planned_duration_days)

            # Apply start constraint (cannot violate dependencies).
            task_start = max(est, planned_start) if planned_start else est

            # Prefer honoring a concrete planned end when we can.
            if planned_start and planned_end and task_start == planned_start:
                task_end = planned_end
                # keep duration consistent with displayed range
                duration_days = self._count_days_inclusive(task_start, task_end, working_days=working_days, weekmask=weekmask)
            else:
                # If duration is 0, end == start - 1 is awkward; we make end == start (zero-length bar).
                if duration_days <= 0:
                    task_end = task_start
                else:
                    task_end = self._add_days(task_start, duration_days - 1, working_days=working_days, weekmask=weekmask)

            offset = self._days_between(start, task_start, working_days=working_days, weekmask=weekmask)

            scheduled[task_id] = ScheduledTask(
                task=t,
                start=task_start,
                end=task_end,
                start_offset_days=offset,
                duration_days=max(1, duration_days) if duration_days > 0 else 0,
                row=row_idx,
            )

        self._scheduled = scheduled
        self._slack_days_by_id, self._critical_path = self._compute_slack_and_critical_path(order, scheduled)
        self._last_schedule_meta = {
            "project_start": start.isoformat(),
            "duration_mode": duration_mode,
            "working_days": working_days,
            "weekmask": weekmask,
            "critical_path": list(self._critical_path),
        }

    def export_layout(self) -> Dict[str, Any]:
        """
        Export a JSON-serializable dict for the frontend.

        Returns:
        - schedule metadata
        - tasks with layout coordinates in "days from project start"
        - dependency edges

        Example::
            g.schedule("2026-01-05")
            payload = g.export_layout()
        """
        if not self._scheduled:
            raise RuntimeError("No schedule computed. Call schedule(...) first.")

        tasks_out: List[Dict[str, Any]] = []
        edges_out: List[Dict[str, str]] = []

        for st in sorted(self._scheduled.values(), key=lambda x: x.row):
            t = st.task
            display_id = t.display_task_id or (str(t.number) if t.number is not None else "")
            slack_days = self._slack_days_by_id.get(t.id, 0)
            tasks_out.append(
                {
                    "id": t.id,
                    "display_id": display_id,
                    "display_task_id": t.display_task_id,
                    "task_id": t.task_id,
                    "url": t.url,
                    "number": t.number,
                    "state": t.state,
                    "labels": list(t.labels or []),
                    "assignees": list(t.assignees or []),
                    "phase": t.phase,
                    "status": getattr(t, "status", None),
                    "name": t.name or t.title,
                    "title": t.title,
                    "details": t.details,
                    "body": t.body,
                    "milestone_or_output": t.milestone_or_output,
                    "acceptance_criteria": t.acceptance_criteria,
                    "dependencies": list(t.dependencies),
                    "roles": dict(t.roles),
                    "notes": t.notes,
                    "durations": {"wall": t.wall_days, "billable": t.billable_days},
                    "start_date": None if t.start_date is None else t.start_date.isoformat(),
                    "end_date": None if t.end_date is None else t.end_date.isoformat(),
                    "slack_days": slack_days,
                    "is_critical": slack_days == 0,
                    "schedule": {
                        "start": st.start.isoformat(),
                        "end": st.end.isoformat(),
                        "row": st.row,
                        "x": st.start_offset_days,
                        "w": st.duration_days,  # bar width in day units
                    },
                }
            )
            for dep in t.dependencies:
                edges_out.append({"from": dep, "to": t.id})

        return {
            "meta": dict(self._last_schedule_meta),
            "tasks": tasks_out,
            "edges": edges_out,
        }

    @staticmethod
    def _compute_slack_and_critical_path(
        order: List[str],
        scheduled: Dict[str, ScheduledTask],
    ) -> Tuple[Dict[str, int], List[str]]:
        """
        Compute CPM slack (in the same day units used by the schedule offsets) and return
        a single deterministic critical path.

        Definitions in this plan:
          ES(task) = scheduled start_offset_days
          DUR(task) = scheduled duration_days
          EF(task) = ES + DUR            (finish boundary, exclusive)
          ProjectFinish = max(EF)

        Backward pass:
          LF(task) = min(LS(successors)) for tasks with successors, else ProjectFinish
          LS(task) = LF - DUR
          Slack = LS - ES

        Critical tasks have Slack == 0.
        """
        if not order:
            return {}, []

        # Build successor lists from the dependency graph (dep -> task).
        succ: Dict[str, List[str]] = {tid: [] for tid in order}
        pred: Dict[str, List[str]] = {tid: [] for tid in order}
        for tid in order:
            t = scheduled[tid].task
            for d in t.dependencies:
                if d in succ:
                    succ[d].append(tid)
                    pred[tid].append(d)

        es: Dict[str, int] = {tid: scheduled[tid].start_offset_days for tid in order}
        dur: Dict[str, int] = {tid: max(0, scheduled[tid].duration_days) for tid in order}
        ef: Dict[str, int] = {tid: es[tid] + dur[tid] for tid in order}
        project_finish = max(ef.values()) if ef else 0

        lf: Dict[str, int] = {}
        ls: Dict[str, int] = {}

        for tid in reversed(order):
            if succ[tid]:
                lf_tid = min(ls[s] for s in succ[tid])
            else:
                lf_tid = project_finish
            lf[tid] = lf_tid
            ls[tid] = lf_tid - dur[tid]

        slack: Dict[str, int] = {tid: max(0, ls[tid] - es[tid]) for tid in order}

        # Deterministic critical path reconstruction:
        # pick an end task that finishes at project_finish and is critical.
        critical_end = [tid for tid in order if slack[tid] == 0 and ef[tid] == project_finish]
        if not critical_end:
            # No zero-slack tasks? (shouldn't happen unless empty durations)
            return slack, []

        # Use scheduled row as stable tiebreaker.
        critical_end.sort(key=lambda tid: scheduled[tid].row)
        cur = critical_end[0]
        path_rev: List[str] = [cur]

        # Walk backwards through critical predecessors that "touch" (EF(pred) == ES(cur)).
        while True:
            preds = [
                p
                for p in pred[cur]
                if slack.get(p, 1) == 0 and ef.get(p) == es.get(cur)
            ]
            if not preds:
                break
            preds.sort(key=lambda tid: scheduled[tid].row)
            cur = preds[0]
            path_rev.append(cur)

        path = list(reversed(path_rev))
        return slack, path

    def export_csv_v2(self) -> str:
        """
        Export the current plan as a V2 CSV (single header row).

        This is primarily used to "instantiate" templates:
        - If a template CSV had blank `Task ID`s, `from_csv` generates UUIDs.
        - This method returns a normalized CSV containing those generated IDs
          and UUID-based `Dependencies`, so the frontend can persist them.
        """
        import io

        fieldnames = [
            "Display Task ID",
            "Task ID",
            "url",
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

        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=fieldnames, lineterminator="\n")
        w.writeheader()

        for t in self._tasks:
            w.writerow(
                {
                    "Display Task ID": t.display_task_id or "",
                    "Task ID": t.task_id or "",
                    "url": t.url or "",
                    "number": "" if t.number is None else str(t.number),
                    "state": t.state or "",
                    "project_name": getattr(t, "project_name", "") or "",
                    "phase": t.phase or "",
                    "title": t.title or t.name or "",
                    "body": t.body or t.details or "",
                    "milestone_or_output": t.milestone_or_output or "",
                    "acceptance_criteria": t.acceptance_criteria or "",
                    "Dependencies": ",".join(t.dependencies or []),
                    "start_date": "" if t.start_date is None else t.start_date.isoformat(),
                    "end_date": "" if t.end_date is None else t.end_date.isoformat(),
                    "wall_days": "" if (t.wall_days or 0.0) == 0.0 else str(t.wall_days),
                    "billable_days": "" if (t.billable_days or 0.0) == 0.0 else str(t.billable_days),
                    "Labels": ",".join(t.labels or []),
                    "Assignees": ",".join(t.assignees or []),
                    "notes": t.notes or "",
                    "status": (getattr(t, "status", None) or ""),
                }
            )

        return buf.getvalue()

    # -----------------------------
    # Graph utilities
    # -----------------------------

    def _topological_order(self) -> List[str]:
        """
        Kahn's algorithm with cycle detection.
        """
        indeg: Dict[str, int] = {t.id: 0 for t in self._tasks}
        out: Dict[str, List[str]] = {t.id: [] for t in self._tasks}

        for t in self._tasks:
            for d in t.dependencies:
                out[d].append(t.id)
                indeg[t.id] += 1

        queue: List[str] = [tid for tid, deg in indeg.items() if deg == 0]
        # Stable ordering: prefer Display Task ID / issue number over UUID.
        queue.sort(key=self._sort_key_for_node)

        order: List[str] = []
        while queue:
            n = queue.pop(0)
            order.append(n)
            for m in out[n]:
                indeg[m] -= 1
                if indeg[m] == 0:
                    queue.append(m)
                    queue.sort(key=self._sort_key_for_node)

        if len(order) != len(self._tasks):
            # Find a cycle hint
            remaining = [tid for tid, deg in indeg.items() if deg > 0]
            raise ValueError(f"Dependency cycle detected among tasks: {remaining}")

        return order

    def _sort_key_for_node(self, task_id: str) -> Tuple:
        t = self._task_by_id.get(task_id)
        s = ""
        if t is not None:
            s = (t.display_task_id or (str(t.number) if t.number is not None else "")).strip()
        if not s:
            s = task_id
        parts = [p for p in s.split(".") if p != ""]

        # Important: Always return a comparable key across tasks.
        # If we return (3, 2) for "3.2" and ("550e8400-e29b...",) for UUIDs,
        # Python will raise: TypeError: '<' not supported between instances of 'str' and 'int'
        #
        # Strategy:
        # - Pure numeric dotted identifiers (e.g. "3.2") sort first by numeric tuple.
        # - Everything else sorts after by lowercase string.
        if parts and all(p.isdigit() for p in parts):
            return (0, tuple(int(p) for p in parts), "")
        return (1, (), s.lower())

    @staticmethod
    def _count_days_inclusive(
        start: date,
        end: date,
        *,
        working_days: bool,
        weekmask: Tuple[int, ...],
    ) -> int:
        if end < start:
            return 0
        if not working_days:
            return (end - start).days + 1
        cur = start
        count = 0
        while cur <= end:
            if cur.weekday() in weekmask:
                count += 1
            cur = cur + timedelta(days=1)
        return count

    # -----------------------------
    # Date helpers
    # -----------------------------

    @staticmethod
    def _coerce_date(d: DateLike) -> date:
        if isinstance(d, date) and not isinstance(d, datetime):
            return d
        if isinstance(d, datetime):
            return d.date()
        if isinstance(d, str):
            return date.fromisoformat(d)
        raise TypeError(f"Unsupported date type: {type(d)}")

    @staticmethod
    def _add_days(
        start: date,
        days: int,
        *,
        working_days: bool,
        weekmask: Tuple[int, ...],
    ) -> date:
        if days <= 0:
            return start
        if not working_days:
            return start + timedelta(days=days)

        cur = start
        added = 0
        while added < days:
            cur = cur + timedelta(days=1)
            if cur.weekday() in weekmask:
                added += 1
        return cur

    @staticmethod
    def _days_between(
        start: date,
        end: date,
        *,
        working_days: bool,
        weekmask: Tuple[int, ...],
    ) -> int:
        if end <= start:
            return 0
        if not working_days:
            return (end - start).days

        cur = start
        count = 0
        while cur < end:
            cur = cur + timedelta(days=1)
            if cur.weekday() in weekmask:
                count += 1
        return count
