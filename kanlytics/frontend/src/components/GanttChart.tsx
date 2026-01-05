import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Edge, GanttLayout, PhaseMeta, TaskItem } from "../types";

type Props = {
  layout: GanttLayout;
  pxPerDay?: number;
  rowHeight?: number;
  showDeps?: boolean;
  showDailyGrid?: boolean;
  showCriticalPath?: boolean;
  detailMode?: "all" | "phaseSummary";
  projectName?: string;
  timeAxisMode?: "dayCount" | "weeks" | "months" | "calendarDays" | "calendarWeeks" | "calendarMonths";
  phaseLayout?: "linear" | "stacked";
  barPadPx?: number;
  phaseFilter?: string[];
  onPhaseFilterChange?: (phases: string[]) => void;
  extraPhases?: string[];
  phaseMajors?: Record<string, number>;
  onAddPhase?: () => void;
  onAddTask?: (phase: string) => void;
  onEditTask?: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
  onFetchPhaseMeta?: (phase: string) => Promise<PhaseMeta>;
  onSavePhaseMeta?: (phase: string, description: string) => Promise<PhaseMeta>;
  onDeletePhase?: (phase: string) => void;
  suppressInfoPanel?: boolean;
  exportId?: string;
  hideHeader?: boolean;
  axisBaseDate?: string;
  axisMaxXDay?: number;
};

function groupByPhase(tasks: TaskItem[]) {
  const map = new Map<string, TaskItem[]>();
  for (const t of tasks) {
    const ph = t.phase || "Unphased";
    if (!map.has(ph)) map.set(ph, []);
    map.get(ph)!.push(t);
  }
  const groups = Array.from(map.entries()).map(([phase, ts]) => {
    ts.sort((a, b) => a.schedule.row - b.schedule.row);
    return { phase, tasks: ts };
  });
  groups.sort((a, b) => a.tasks[0].schedule.row - b.tasks[0].schedule.row);
  return groups;
}

function parseIsoDateUtc(iso: string): number | null {
  // Expect YYYY-MM-DD (from backend), interpret as UTC midnight.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || "").trim());
  if (!m) return null;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  return Date.UTC(yy, mm - 1, dd);
}

function barPath(
  x: number,
  y: number,
  w: number,
  h: number,
  roundLeft: boolean,
  roundRight: boolean
): string {
  const r = Math.max(0, Math.min(8, h / 2, w / 2));
  const xl = x;
  const xr = x + w;
  const yt = y;
  const yb = y + h;

  const rl = roundLeft ? r : 0;
  const rr = roundRight ? r : 0;

  // Start top-left
  let d = `M ${xl + rl} ${yt}`;
  // Top edge to top-right
  d += ` L ${xr - rr} ${yt}`;
  // Top-right corner
  if (roundRight && rr > 0) d += ` A ${rr} ${rr} 0 0 1 ${xr} ${yt + rr}`;
  // Right edge
  d += ` L ${xr} ${yb - rr}`;
  // Bottom-right corner
  if (roundRight && rr > 0) d += ` A ${rr} ${rr} 0 0 1 ${xr - rr} ${yb}`;
  // Bottom edge to bottom-left
  d += ` L ${xl + rl} ${yb}`;
  // Bottom-left corner
  if (roundLeft && rl > 0) d += ` A ${rl} ${rl} 0 0 1 ${xl} ${yb - rl}`;
  // Left edge
  d += ` L ${xl} ${yt + rl}`;
  // Top-left corner
  if (roundLeft && rl > 0) d += ` A ${rl} ${rl} 0 0 1 ${xl + rl} ${yt}`;
  d += " Z";
  return d;
}

function fmtIsoDateTime(s?: string | null): string {
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString();
  } catch {
    return s;
  }
}

function Pill(props: { text: string; variant?: "neutral" | "blue" | "green" | "red" | "purple"; title?: string }) {
  const v = props.variant ?? "neutral";
  const bg =
    v === "blue"
      ? "rgba(37, 99, 235, 0.18)"
      : v === "green"
        ? "rgba(34, 197, 94, 0.18)"
        : v === "red"
          ? "rgba(239, 68, 68, 0.18)"
          : v === "purple"
            ? "rgba(168, 85, 247, 0.18)"
            : "rgba(148, 163, 184, 0.18)";
  const border =
    v === "blue"
      ? "rgba(37, 99, 235, 0.35)"
      : v === "green"
        ? "rgba(34, 197, 94, 0.35)"
        : v === "red"
          ? "rgba(239, 68, 68, 0.35)"
          : v === "purple"
            ? "rgba(168, 85, 247, 0.35)"
            : "rgba(148, 163, 184, 0.28)";
  return (
    <span
      title={props.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        border: `1px solid ${border}`,
        background: bg,
        color: "var(--text)",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.7,
        whiteSpace: "nowrap",
      }}
    >
      {props.text}
    </span>
  );
}

function MarkdownBox(props: { markdown: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 10, background: "var(--card)" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...p }) => <a {...p} target="_blank" rel="noreferrer" style={{ color: "var(--gantt-selected)" }} />,
          code: ({ node, className, children, ...p }) => {
            const text = String(children ?? "");
            const isInline = !className && !text.includes("\n");
            return (
              <code
                {...p}
                className={className}
                style={{
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  background: isInline ? "rgba(148, 163, 184, 0.18)" : "transparent",
                  padding: isInline ? "2px 6px" : undefined,
                  borderRadius: isInline ? 8 : undefined,
                }}
              >
                {children}
              </code>
            );
          },
          pre: ({ node, children, ...p }) => (
            <pre
              {...p}
              style={{
                margin: 0,
                overflow: "auto",
                padding: 10,
                borderRadius: 12,
                border: "1px solid var(--border)",
                background: "var(--bg)",
              }}
            >
              {children}
            </pre>
          ),
          h1: ({ node, ...p }) => <h3 style={{ margin: "10px 0 6px" }} {...p} />,
          h2: ({ node, ...p }) => <h3 style={{ margin: "10px 0 6px" }} {...p} />,
          h3: ({ node, ...p }) => <h4 style={{ margin: "10px 0 6px" }} {...p} />,
          ul: ({ node, ...p }) => <ul style={{ margin: "6px 0 6px 18px" }} {...p} />,
          ol: ({ node, ...p }) => <ol style={{ margin: "6px 0 6px 18px" }} {...p} />,
          p: ({ node, ...p }) => <p style={{ margin: "6px 0" }} {...p} />,
        }}
      >
        {props.markdown}
      </ReactMarkdown>
    </div>
  );
}

function buildDepPaths(
  tasks: TaskItem[],
  edges: Edge[],
  rowIndexById: Map<string, number>,
  spanById: Map<string, { xDay: number; wDay: number }>,
  barEndsById: Map<string, { startXDay: number; endXDay: number }>,
  phaseLayout: "linear" | "stacked",
  phaseHeaderRowByPhase: Map<string, number>,
  xOffset: number,
  pxPerDay: number,
  rowHeight: number,
  yOffset: number,
  barPadPx: number
) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const paths: { d: string; key: string }[] = [];
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;

    const aSpan = spanById.get(a.id);
    const bSpan = spanById.get(b.id);
    if (!aSpan || !bSpan) continue;

    const aEnds = barEndsById.get(a.id);
    const bEnds = barEndsById.get(b.id);
    if (!aEnds || !bEnds) continue;

    // Arrow start: end of dependency bar (ensure at least 1 day for milestones)
    const aIsMilestone = Math.abs(aEnds.endXDay - aEnds.startXDay) < 1e-9;
    const axRaw = xOffset + aEnds.endXDay * pxPerDay;
    const ax = aIsMilestone ? axRaw : Math.max(xOffset, axRaw - barPadPx);
    const aRow = rowIndexById.get(a.id) ?? a.schedule.row;
    const ay = aRow * rowHeight + rowHeight / 2 + yOffset;

    // Arrow end: start of dependent bar
    const bIsMilestone = Math.abs(bEnds.endXDay - bEnds.startXDay) < 1e-9;
    const bxRaw = xOffset + bEnds.startXDay * pxPerDay;
    const bx = bIsMilestone ? bxRaw : Math.max(xOffset, bxRaw + barPadPx);
    const bRow = rowIndexById.get(b.id) ?? b.schedule.row;
    const by = bRow * rowHeight + rowHeight / 2 + yOffset;

    const aPhase = a.phase || "Unphased";
    const bPhase = b.phase || "Unphased";

    // In stacked mode, cross-phase deps often go "backwards" in x (because each phase
    // starts at x=0). If we route naively, the line cuts through the target phase's
    // task bars. Instead, detour into the target phase's header/axis lane, run
    // backwards there, then drop down into the target bar start.
    let d: string;
    if (phaseLayout === "stacked" && aPhase !== bPhase && bx < ax) {
      const headerRow = phaseHeaderRowByPhase.get(bPhase) ?? 0;
      // Put the lane at the very top of the phase header row to avoid the date labels.
      const laneY = headerRow * rowHeight + 2 + yOffset;

      const bump = 10;
      const xOut = ax + bump;
      // Ensure we extend a bit left of the dependent task start even if it's at day 0.
      const xIn = Math.max(0, bx - bump);

      d = `M ${ax} ${ay} L ${xOut} ${ay} L ${xOut} ${laneY} L ${xIn} ${laneY} L ${xIn} ${by} L ${bx} ${by}`;
    } else {
      const midX = (ax + bx) / 2;
      d = `M ${ax} ${ay} L ${midX} ${ay} L ${midX} ${by} L ${bx} ${by}`;
    }
    paths.push({ d, key: `${e.from}->${e.to}` });
  }
  return paths;
}

export const GanttChart: React.FC<Props> = ({
  layout,
  pxPerDay = 20,
  rowHeight = 28,
  showDeps = true,
  showDailyGrid = false,
  showCriticalPath = true,
  detailMode = "all",
  projectName = "",
  timeAxisMode = "dayCount",
  phaseLayout = "stacked",
  barPadPx = 0,
  phaseFilter: phaseFilterProp,
  onPhaseFilterChange,
  extraPhases = [],
  phaseMajors = {},
  onAddPhase,
  onAddTask,
  onEditTask,
  onDeleteTask,
  onFetchPhaseMeta,
  onSavePhaseMeta,
  onDeletePhase,
  suppressInfoPanel = false,
  exportId,
  hideHeader = false,
  axisBaseDate,
  axisMaxXDay,
}) => {
  const formatPhaseLabel = (ph: string) => {
    const major = phaseMajors[ph];
    if (typeof major === "number" && Number.isFinite(major) && major > 0) return `${major} — ${ph}`;
    return ph;
  };
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState("");
  const [phaseFilterInternal, setPhaseFilterInternal] = useState<string[]>([]);
  const phaseFilter = phaseFilterProp !== undefined ? phaseFilterProp : phaseFilterInternal;
  const setPhaseFilter = onPhaseFilterChange || setPhaseFilterInternal;
  const [phasePickerOpen, setPhasePickerOpen] = useState<boolean>(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedPhase, setSelectedPhase] = useState<string>("");
  const [phaseMeta, setPhaseMeta] = useState<PhaseMeta | null>(null);
  const [phaseMetaErr, setPhaseMetaErr] = useState<string>("");
  const [phaseMetaBusy, setPhaseMetaBusy] = useState<boolean>(false);
  const [editPhaseOpen, setEditPhaseOpen] = useState<boolean>(false);
  const [editPhaseTab, setEditPhaseTab] = useState<"write" | "preview">("write");
  const [editPhaseDescription, setEditPhaseDescription] = useState<string>("");
  const [infoOpen, setInfoOpen] = useState<boolean>(false);

  const tasks = layout.tasks;
  const phaseSummary = detailMode === "phaseSummary";
  const isWeekUnit = timeAxisMode === "weeks" || timeAxisMode === "calendarWeeks";
  const isMonthUnit = timeAxisMode === "months" || timeAxisMode === "calendarMonths";
  const unitMode = isWeekUnit || isMonthUnit;
  const criticalPathIds = useMemo(() => (layout.meta.critical_path || []) as string[], [layout.meta.critical_path]);
  const criticalSet = useMemo(() => new Set(criticalPathIds), [criticalPathIds]);
  const criticalIdSet = criticalSet;

  const phases = useMemo(() => {
    // Order phases that have tasks first (stable by earliest task row),
    // then append any "empty" phases (created but no tasks yet).
    const byPhaseMinRow = new Map<string, number>();
    for (const t of tasks) {
      const ph = t.phase || "Unphased";
      const cur = byPhaseMinRow.get(ph);
      byPhaseMinRow.set(ph, cur == null ? t.schedule.row : Math.min(cur, t.schedule.row));
    }

    const withTasks = Array.from(byPhaseMinRow.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([ph]) => ph);

    const extrasOnly = (extraPhases || [])
      .map((p) => (p || "").trim())
      .filter(Boolean)
      .filter((p) => !byPhaseMinRow.has(p))
      .sort((a, b) => a.localeCompare(b));

    // De-dupe while preserving the computed order.
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ph of [...withTasks, ...extrasOnly]) {
      if (seen.has(ph)) continue;
      seen.add(ph);
      out.push(ph);
    }
    return out;
  }, [tasks, extraPhases]);

  const phaseFilterLabel = useMemo(() => {
    const sel = (phaseFilter || []).map((p) => (p || "").trim()).filter(Boolean);
    if (!sel.length) return "All phases";
    if (sel.length === 1) return formatPhaseLabel(sel[0]);
    return `${sel.length} phases`;
  }, [phaseFilter]);

  useEffect(() => {
    if (!phasePickerOpen) return;
    const onDoc = () => setPhasePickerOpen(false);
    window.addEventListener("click", onDoc);
    return () => window.removeEventListener("click", onDoc);
  }, [phasePickerOpen]);

  const filtered = useMemo(() => {
    // In phase summary mode, we don't show per-task rows, so task search is not useful.
    // Keep phaseFilter behavior (if it's set via previous view), but ignore text search.
    const q = phaseSummary ? "" : search.trim().toLowerCase();
    const selected = new Set((phaseFilter || []).map((p) => (p || "").trim()).filter(Boolean));
    return tasks.filter(t => {
      if (selected.size > 0 && !selected.has(t.phase || "Unphased")) return false;
      if (!q) return true;
      const key = t.display_id || t.display_task_id || t.id;
      const hay = `${key} ${t.name} ${t.details ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tasks, search, phaseFilter, phaseSummary]);

  const renderTasks = useMemo(() => {
    if (!phaseSummary) return filtered;
    // Only render critical-path tasks in phase summary view.
    // Also drop 0-day milestones/diamonds in this view to avoid visual pile-ups.
    return tasks.filter(t => criticalSet.has(t.id) && (t.schedule.w ?? 0) > 0);
  }, [phaseSummary, filtered, tasks, criticalSet]);

  const renderTasksNoMilestones = useMemo(() => {
    if (!unitMode) return renderTasks;
    // Unit-based views use aggregated bubbles; drop 0-day tasks entirely.
    return renderTasks.filter(t => (t.schedule.w ?? 0) > 0);
  }, [renderTasks, unitMode]);

  // If the selected task disappears (new plan/filtering), clear selection.
  useEffect(() => {
    if (!selectedId) return;
    if (tasks.some(t => t.id === selectedId)) return;
    setSelectedId("");
    setInfoOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length]);

  // If phases change and the selected phase no longer exists, clear selection.
  useEffect(() => {
    if (!selectedPhase) return;
    if (phases.includes(selectedPhase)) return;
    setSelectedPhase("");
    setPhaseMeta(null);
    setPhaseMetaErr("");
    setInfoOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phases.join("|")]);

  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const selected = useMemo(() => (selectedId ? taskById.get(selectedId) : undefined), [selectedId, taskById]);

  async function selectPhase(phase: string) {
    const ph = (phase || "").trim();
    if (!ph) return;
    setSelectedId("");
    setSelectedPhase(ph);
    setInfoOpen(true);
    setPhaseMeta(null);
    setPhaseMetaErr("");
    if (!onFetchPhaseMeta) {
      setPhaseMetaErr("No GitHub connection available for phase meta issues.");
      return;
    }
    try {
      setPhaseMetaBusy(true);
      const meta = await onFetchPhaseMeta(ph);
      setPhaseMeta(meta);
    } catch (e: any) {
      setPhaseMetaErr(e?.message || String(e));
    } finally {
      setPhaseMetaBusy(false);
    }
  }

  const displayById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) {
      const k = t.display_id || t.display_task_id || "";
      if (k) m.set(t.id, k);
    }
    return m;
  }, [tasks]);

  const dependentsById = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of layout.edges) {
      if (!m.has(e.from)) m.set(e.from, []);
      m.get(e.from)!.push(e.to);
    }
    return m;
  }, [layout.edges]);

  // Base project start (UTC midnight). Can be overridden for multi-project shared time-axis views.
  const baseUtc = useMemo(
    () => parseIsoDateUtc(axisBaseDate || layout.meta.project_start) ?? Date.now(),
    [axisBaseDate, layout.meta.project_start],
  );

  const spanById = useMemo(() => {
    const m = new Map<string, { xDay: number; wDay: number }>();
    const MS_DAY = 24 * 60 * 60 * 1000;

    const baseDate = new Date(baseUtc);
    const baseYear = baseDate.getUTCFullYear();
    const baseMonth = baseDate.getUTCMonth(); // 0..11
    const baseMonthStartUtc = Date.UTC(baseYear, baseMonth, 1);
    const daysInMonthUtc = (y: number, mo: number) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const monthCoordForDayBoundary = (dayOffset: number) => {
      const d = new Date(baseUtc + dayOffset * MS_DAY);
      const y = d.getUTCFullYear();
      const mo = d.getUTCMonth();
      const day0 = d.getUTCDate() - 1; // 0-based within month
      const monthsSinceBase = (y - baseYear) * 12 + (mo - baseMonth);
      const dim = daysInMonthUtc(y, mo);
      return monthsSinceBase + day0 / dim;
    };

    for (const t of renderTasksNoMilestones) {
      const startUtc = parseIsoDateUtc(t.schedule.start);
      const endUtc = parseIsoDateUtc(t.schedule.end);
      if (startUtc == null || endUtc == null) {
        // Fallback to backend-provided day units
        m.set(t.id, { xDay: t.schedule.x ?? 0, wDay: t.schedule.w ?? 0 });
        continue;
      }
      const startDay = Math.max(0, Math.floor((startUtc - baseUtc) / MS_DAY));
      // Normally we use inclusive calendar-day span (end-start+1) so working-days schedules
      // can show weekend gaps. However, true milestones have schedule.w === 0 and should
      // render as a point (diamond) and not consume a day.
      const daySpan =
        (t.schedule.w ?? 0) === 0 ? 0 : Math.max(0, Math.floor((endUtc - startUtc) / MS_DAY) + 1); // inclusive end

      if (!unitMode) {
        m.set(t.id, { xDay: startDay, wDay: daySpan });
        continue;
      }

      if (daySpan <= 0) {
        if (isMonthUnit) m.set(t.id, { xDay: monthCoordForDayBoundary(startDay), wDay: 0 });
        else m.set(t.id, { xDay: startDay / 7, wDay: 0 });
        continue;
      }
      if (isMonthUnit) {
        // Calendar months: fractional month coordinates based on day boundaries.
        const x0 = monthCoordForDayBoundary(startDay);
        const x1 = monthCoordForDayBoundary(startDay + daySpan);
        m.set(t.id, { xDay: x0, wDay: Math.max(0, x1 - x0) });
      } else {
        // Weeks/calendar weeks: fractional week coordinates so bars end on the correct day boundary.
        m.set(t.id, { xDay: startDay / 7, wDay: daySpan / 7 });
      }
    }
    return m;
  }, [renderTasksNoMilestones, baseUtc, unitMode, isMonthUnit]);

  const phaseStartByPhase = useMemo(() => {
    const m = new Map<string, number>();
    if (phaseLayout !== "stacked") return m;
    for (const t of renderTasksNoMilestones) {
      const span = spanById.get(t.id);
      if (!span) continue;
      const ph = t.phase || "Unphased";
      const cur = m.get(ph);
      m.set(ph, cur == null ? span.xDay : Math.min(cur, span.xDay));
    }
    return m;
  }, [renderTasksNoMilestones, spanById, phaseLayout]);

  const baseUtcByPhase = useMemo(() => {
    const m = new Map<string, number>();
    if (phaseLayout !== "stacked") return m;
    for (const [ph, startDay] of phaseStartByPhase.entries()) {
      // Base is only used for weekend shading / calendar labels; for unit-based views we don't need this.
      m.set(ph, baseUtc + startDay * 24 * 60 * 60 * 1000);
    }
    return m;
  }, [phaseStartByPhase, baseUtc, phaseLayout]);

  const drawSpanById = useMemo(() => {
    // The spans used for drawing bars (xDay in chart coordinates).
    // - linear: same as spanById (global timeline)
    // - stacked: normalize each phase so its min start aligns to x=0
    if (phaseLayout !== "stacked") return spanById;
    const m = new Map<string, { xDay: number; wDay: number }>();
    for (const t of renderTasksNoMilestones) {
      const span = spanById.get(t.id);
      if (!span) continue;
      const ph = t.phase || "Unphased";
      const off = phaseStartByPhase.get(ph) ?? 0;
      m.set(t.id, { xDay: Math.max(0, span.xDay - off), wDay: span.wDay });
    }
    return m;
  }, [renderTasksNoMilestones, spanById, phaseStartByPhase, phaseLayout]);

  const segmentsById = useMemo(() => {
    // If the backend is scheduling in working-day mode, split bars across weekends:
    // - draw only weekday segments
    // - leave gaps over Sat/Sun to indicate no work
    //
    // If scheduling is in calendar-day mode, do NOT split; bars should be continuous.
    const m = new Map<
      string,
      Array<{ xDay: number; wDay: number; roundLeft: boolean; roundRight: boolean }>
    >();

    const isWeekend = (base: number, dayIndex: number) => {
      const t = base + dayIndex * 24 * 60 * 60 * 1000;
      const dow = new Date(t).getUTCDay(); // 0=Sun..6=Sat
      return dow === 0 || dow === 6;
    };

    const splitOnWeekends = Boolean(layout.meta.working_days) && !unitMode;

    for (const t of renderTasksNoMilestones) {
      const span = drawSpanById.get(t.id);
      if (!span) continue;

      // Unit-based modes: treat each task as a single continuous segment.
      if (unitMode) {
        m.set(t.id, [{ xDay: span.xDay, wDay: Math.max(0, span.wDay), roundLeft: true, roundRight: true }]);
        continue;
      }

      const ph = t.phase || "Unphased";
      const phaseBase = phaseLayout === "stacked" ? (baseUtcByPhase.get(ph) ?? baseUtc) : baseUtc;

      const startDay = span.xDay;
      const totalDays = Math.max(1, span.wDay);
      const endDay = startDay + totalDays - 1;

      if (!splitOnWeekends) {
        m.set(t.id, [{ xDay: startDay, wDay: totalDays, roundLeft: true, roundRight: true }]);
        continue;
      }

      const segs: Array<{ xDay: number; wDay: number; roundLeft: boolean; roundRight: boolean }> = [];
      let curStart: number | null = null;
      let curLen = 0;

      for (let d = startDay; d <= endDay; d += 1) {
        if (isWeekend(phaseBase, d)) {
          if (curStart != null && curLen > 0) {
            segs.push({ xDay: curStart, wDay: curLen, roundLeft: false, roundRight: false });
            curStart = null;
            curLen = 0;
          }
          continue;
        }
        if (curStart == null) curStart = d;
        curLen += 1;
      }
      if (curStart != null && curLen > 0) {
        segs.push({ xDay: curStart, wDay: curLen, roundLeft: false, roundRight: false });
      }

      // Apply rounded ends to the true start/end (if those days are drawn)
      if (segs.length > 0) {
        // Round left if first segment begins on actual start day
        segs[0].roundLeft = segs[0].xDay === startDay;
        // Round right if last segment ends on actual end day
        const last = segs[segs.length - 1];
        last.roundRight = last.xDay + last.wDay - 1 === endDay;

        // Any internal segment boundaries (weekend splits) should be square on the weekend-facing side.
        // We already default roundLeft/roundRight to false, so only true ends are rounded.
      }

      m.set(t.id, segs);
    }
    return m;
  }, [renderTasksNoMilestones, drawSpanById, baseUtc, baseUtcByPhase, phaseLayout, layout.meta.working_days, unitMode]);

  const barEndsById = useMemo(() => {
    // For arrows: use the first segment start and last segment end (in day units).
    const m = new Map<string, { startXDay: number; endXDay: number }>();
    for (const t of renderTasksNoMilestones) {
      const segs = segmentsById.get(t.id) || [];
      const span = drawSpanById.get(t.id);
      if (!span) continue;

      if (unitMode) {
        // Weeks mode uses fractional units; use exact span without rounding to full weeks.
        const startXDay = span.xDay;
        const endXDay = span.xDay + Math.max(0, span.wDay);
        m.set(t.id, { startXDay, endXDay });
        continue;
      }

      if (span.wDay === 0) {
        // Milestone point: center of the day cell.
        const p = span.xDay + 0.5;
        m.set(t.id, { startXDay: p, endXDay: p });
        continue;
      }

      if (segs.length === 0) {
        const startXDay = span.xDay;
        const endXDay = span.xDay + Math.max(1, span.wDay);
        m.set(t.id, { startXDay, endXDay });
        continue;
      }

      const startXDay = segs[0].xDay;
      const last = segs[segs.length - 1];
      const endXDay = last.xDay + Math.max(1, last.wDay);
      m.set(t.id, { startXDay, endXDay });
    }
    return m;
  }, [renderTasksNoMilestones, segmentsById, drawSpanById, unitMode]);

  const maxXDayLocal = useMemo(() => {
    let m = 0;
    for (const t of renderTasksNoMilestones) {
      const ends = barEndsById.get(t.id);
      if (!ends) continue;
      m = Math.max(m, ends.endXDay);
    }
    return m;
  }, [renderTasksNoMilestones, barEndsById]);

  const maxXDay = axisMaxXDay != null ? Math.max(maxXDayLocal, axisMaxXDay) : maxXDayLocal;

  const width = Math.max(900, (maxXDay + 5) * pxPerDay);
  const chartPadLeft = 10; // pixels of breathing room at left edge
  const svgWidth = width + chartPadLeft;
  const groups = useMemo(() => {
    // Build groups using the full phase list so phases with no tasks still render
    // a header row in the left pane (important for adding tasks later).
    const selected = new Set((phaseFilter || []).map((p) => (p || "").trim()).filter(Boolean));
    const visiblePhases = selected.size === 0 ? phases : phases.filter((p) => selected.has(p));
    const byPhase = new Map<string, TaskItem[]>();
    for (const t of filtered) {
      const ph = t.phase || "Unphased";
      if (!byPhase.has(ph)) byPhase.set(ph, []);
      byPhase.get(ph)!.push(t);
    }
    const out = visiblePhases.map((ph) => {
      const ts = byPhase.get(ph) || [];
      ts.sort((a, b) => a.schedule.row - b.schedule.row);
      return { phase: ph, tasks: ts };
    });
    return out;
  }, [filtered, phases, phaseFilter]);

  const phaseRows = useMemo(() => phases, [phases]);

  // Build a "display row model" that both panes use. This fixes misalignment when
  // the left pane includes phase header rows (extra vertical height) but the SVG
  // uses schedule.row directly.
  type DisplayRow =
    | { kind: "project"; name: string }
    | { kind: "phase"; phase: string }
    | { kind: "task"; task: TaskItem };

  const displayRows = useMemo<DisplayRow[]>(() => {
    const rows: DisplayRow[] = [];
    if (phaseSummary) {
      rows.push({ kind: "project", name: projectName.trim() || "Project" });
      for (const ph of phaseRows) rows.push({ kind: "phase", phase: ph });
      return rows;
    }
    for (const g of groups) {
      rows.push({ kind: "phase", phase: g.phase });
      for (const t of g.tasks) rows.push({ kind: "task", task: t });
    }
    return rows;
  }, [groups, phaseSummary, phaseRows, projectName]);

  const rowIndexById = useMemo(() => {
    const m = new Map<string, number>();
    if (phaseSummary) {
      const idxByPhase = new Map<string, number>();
      displayRows.forEach((r, idx) => {
        if (r.kind === "phase") idxByPhase.set(r.phase, idx);
      });
      for (const t of renderTasks) {
        const ph = t.phase || "Unphased";
        const rowIdx = idxByPhase.get(ph);
        if (rowIdx != null) m.set(t.id, rowIdx);
      }
      return m;
    }
    displayRows.forEach((r, idx) => {
      if (r.kind === "task") m.set(r.task.id, idx);
    });
    return m;
  }, [displayRows, phaseSummary, renderTasks]);

  const phaseSections = useMemo(() => {
    // Find each phase header row, and the y-range it covers (until next phase header).
    // Used in stacked layout for per-phase axes and shading.
    const sections: Array<{ phase: string; headerRowIdx: number; startRowIdx: number; endRowIdx: number }> = [];
    let current: { phase: string; headerRowIdx: number; startRowIdx: number; endRowIdx: number } | null = null;
    for (let i = 0; i < displayRows.length; i += 1) {
      const r = displayRows[i];
      if (r.kind === "phase") {
        if (current) current.endRowIdx = i - 1;
        current = { phase: r.phase, headerRowIdx: i, startRowIdx: i, endRowIdx: i };
        sections.push(current);
      }
    }
    if (current) current.endRowIdx = displayRows.length - 1;
    return sections;
  }, [displayRows]);

  const phaseHeaderRowByPhase = useMemo(() => {
    const m = new Map<string, number>();
    for (const sec of phaseSections) m.set(sec.phase, sec.headerRowIdx);
    return m;
  }, [phaseSections, phaseSummary]);

  const height = useMemo(() => {
    const rowsH = displayRows.length * rowHeight;
    // In compact multi-project views, don't force an artificial minimum height —
    // it creates visible "empty rows" under the task list.
    if (hideHeader) return rowsH;
    return Math.max(220, rowsH);
  }, [displayRows.length, rowHeight, hideHeader]);

  const depPaths = useMemo(
    () =>
      showDeps && !phaseSummary && !unitMode
        ? buildDepPaths(
            renderTasks,
            layout.edges,
            rowIndexById,
            drawSpanById,
            barEndsById,
            phaseLayout,
            phaseHeaderRowByPhase,
            chartPadLeft,
            pxPerDay,
            rowHeight,
            0,
            barPadPx
          )
        : [],
    [
      renderTasks,
      layout.edges,
      rowIndexById,
      drawSpanById,
      barEndsById,
      phaseLayout,
      phaseHeaderRowByPhase,
      chartPadLeft,
      pxPerDay,
      rowHeight,
      showDeps,
      barPadPx,
      phaseSummary,
      unitMode,
    ]
  );

  const rowBubbles = useMemo(() => {
    const bubbleMode = unitMode || (phaseSummary && phaseLayout === "stacked");
    if (!bubbleMode) return [];

    type Bubble = {
      rowIdx: number;
      startX: number;
      endX: number;
      repId: string;
      isCritical: boolean;
      startUtc: number | null;
    };
    const byRow = new Map<number, Bubble>();

    for (const t of renderTasksNoMilestones) {
      const span = drawSpanById.get(t.id);
      if (!span) continue;
      const rowIdx = rowIndexById.get(t.id);
      if (rowIdx == null) continue;

      const startX = span.xDay;
      const endX = span.xDay + Math.max(0, span.wDay);
      const isCritical = Boolean(criticalIdSet.has(t.id) || t.is_critical || (t.slack_days ?? 0) === 0);
      const startUtc = parseIsoDateUtc(t.schedule.start);

      const cur = byRow.get(rowIdx);
      if (!cur) {
        byRow.set(rowIdx, {
          rowIdx,
          startX,
          endX,
          repId: t.id,
          isCritical,
          startUtc,
        });
        continue;
      }
      cur.startX = Math.min(cur.startX, startX);
      cur.endX = Math.max(cur.endX, endX);
      cur.isCritical = cur.isCritical || isCritical;
      cur.startUtc = cur.startUtc == null ? startUtc : startUtc == null ? cur.startUtc : Math.min(cur.startUtc, startUtc);
      // Representative id: keep the earliest-starting task for stable selection.
      if (startX < (drawSpanById.get(cur.repId)?.xDay ?? Number.POSITIVE_INFINITY)) cur.repId = t.id;
      byRow.set(rowIdx, cur);
    }

    return Array.from(byRow.values()).sort((a, b) => a.rowIdx - b.rowIdx);
  }, [unitMode, phaseSummary, phaseLayout, renderTasksNoMilestones, drawSpanById, rowIndexById]);

  const ticks = useMemo(() => {
    const N = Math.ceil(width / pxPerDay);
    // Keep labels readable by enforcing a minimum pixel spacing.
    // Example target: no more than one label per ~40px.
    const minTickPx = 40;
    const minStepByPx = Math.max(1, Math.ceil(minTickPx / Math.max(1, pxPerDay)));

    // Coarse heuristic for very long timelines (keeps label count bounded).
    const coarseStep = N > 180 ? 14 : N > 90 ? 7 : 1;

    const step = Math.max(coarseStep, minStepByPx);
    const out: number[] = [];
    for (let d = 0; d <= N; d += step) out.push(d);
    return out;
  }, [width, pxPerDay]);

  const dayCount = useMemo(() => Math.ceil(width / pxPerDay), [width, pxPerDay]);

  const dateFmt = useMemo(() => new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit" }), []);

  const formatTickForBase = useMemo(() => {
    const MS_DAY = 24 * 60 * 60 * 1000;
    const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
    const base0 = new Date(baseUtc);
    const base0Y = base0.getUTCFullYear();
    const base0M = base0.getUTCMonth();

    if (timeAxisMode === "weeks") {
      return (base: number, d: number) => {
        const offsetDays = Math.round((base - baseUtc) / MS_DAY);
        const offsetWeeks = Math.floor(offsetDays / 7);
        return String(offsetWeeks + d);
      };
    }
    if (timeAxisMode === "calendarWeeks") {
      return (base: number, d: number) => dateFmt.format(new Date(base + d * 7 * MS_DAY));
    }
    if (timeAxisMode === "months") {
      return (base: number, d: number) => {
        const dt = new Date(base);
        const y = dt.getUTCFullYear();
        const mo = dt.getUTCMonth();
        const offsetMonths = (y - base0Y) * 12 + (mo - base0M);
        return String(offsetMonths + d);
      };
    }
    if (timeAxisMode === "calendarMonths") {
      return (base: number, d: number) => {
        const dt = new Date(base);
        const y = dt.getUTCFullYear();
        const mo = dt.getUTCMonth();
        return monthFmt.format(new Date(Date.UTC(y, mo + d, 1)));
      };
    }
    if (timeAxisMode !== "calendarDays") {
      // In stacked layout each phase uses its own "base" (min start within that phase).
      // For a global day counter, offset each phase by how many calendar days it starts
      // after the overall project start (baseUtc).
      return (base: number, d: number) => {
        const offsetDays = Math.round((base - baseUtc) / MS_DAY);
        return String(offsetDays + d);
      };
    }
    // Calendar axis: always add calendar days (do not "skip" weekends visually).
    return (base: number, d: number) => dateFmt.format(new Date(base + d * MS_DAY));
  }, [timeAxisMode, dateFmt, baseUtc]);

  const formatTick = useMemo(() => (d: number) => formatTickForBase(baseUtc, d), [formatTickForBase, baseUtc]);

  const dayBands = useMemo(() => {
    // Background banding for LINEAR mode (single global axis).
    const out: { d: number; fill: string }[] = [];
    if (unitMode) {
      for (let d = 0; d <= dayCount; d += 1) {
        out.push({ d, fill: d % 2 === 0 ? "var(--gantt-band-a)" : "var(--gantt-band-b)" });
      }
      return out;
    }
    let workdayIdx = 0;
    for (let d = 0; d <= dayCount; d += 1) {
      const t = baseUtc + d * 24 * 60 * 60 * 1000;
      const dow = new Date(t).getUTCDay(); // 0=Sun..6=Sat
      const isWeekend = dow === 0 || dow === 6;
      if (isWeekend) {
        out.push({ d, fill: "var(--gantt-weekend)" });
      } else {
        const fill = workdayIdx % 2 === 0 ? "var(--gantt-band-a)" : "var(--gantt-band-b)";
        out.push({ d, fill });
        workdayIdx += 1;
      }
    }
    return out;
  }, [baseUtc, dayCount, unitMode]);

  function selectTask(id: string) {
    setSelectedPhase("");
    setPhaseMeta(null);
    setPhaseMetaErr("");
    setSelectedId(id);
    setInfoOpen(true);
  }

  function clearSelection() {
    setSelectedId("");
    setSelectedPhase("");
    setPhaseMeta(null);
    setPhaseMetaErr("");
    setInfoOpen(false);
  }

  // Escape closes the panel + clears selection (GitHub-style).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const infoPanelMinWidth = 560;
  const infoPanelMaxWidth = 1040;
  const infoPanelInset = 20;
  const taskListWidth = 360;
  const headerHeight = hideHeader ? 0 : 112;

  const linearAxisRowIdx = useMemo(() => {
    // In phase summary mode, the first row is the project header; axis should live there.
    if (phaseSummary) return 0;
    if (!phaseSections.length) return 0;
    let m = phaseSections[0].headerRowIdx;
    for (const sec of phaseSections) m = Math.min(m, sec.headerRowIdx);
    return m;
  }, [phaseSections]);

  const [panelBounds, setPanelBounds] = useState<{ left: number; right: number; top: number; bottom: number } | null>(
    null
  );

  // Keep the info panel fixed in the viewport, but aligned/inset within the visible gantt shell.
  useLayoutEffect(() => {
    const compute = () => {
      const root = rootRef.current;
      const shell = root?.closest(".ganttShell") as HTMLElement | null;
      if (!shell) {
        setPanelBounds(null);
        return;
      }
      const r = shell.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const left = Math.max(16, r.left + taskListWidth + infoPanelInset);
      const right = Math.max(16, vw - r.right + infoPanelInset);
      const top = Math.max(16, r.top + infoPanelInset);
      const bottom = Math.max(16, vh - r.bottom + infoPanelInset);

      setPanelBounds({ left, right, top, bottom });
    };

    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, { passive: true });
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `${taskListWidth}px 1fr`,
        minWidth: 0,
      }}
      ref={rootRef}
      data-kanlytics-gantt-export-root
      data-kanlytics-gantt-export-id={exportId || ""}
    >
      {editPhaseOpen ? (
        <div
          className="modalBackdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Edit phase"
          onClick={() => setEditPhaseOpen(false)}
        >
          <div
            className="modalCard"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 920, maxHeight: "calc(100vh - 36px)", overflow: "auto" }}
          >
            <div className="modalHeader">
              <div>Edit phase</div>
              <button
                type="button"
                onClick={() => setEditPhaseOpen(false)}
                style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <div className="label">Phase</div>
                <input value={selectedPhase} disabled />
              </div>
              <div>
                <div className="label">Description / notes</div>
                <div style={{ border: "1px solid var(--border-2)", borderRadius: 10, overflow: "hidden", background: "var(--input-bg)" }}>
                  <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
                    <button
                      type="button"
                      onClick={() => setEditPhaseTab("write")}
                      style={{
                        padding: "8px 10px",
                        border: "none",
                        background: editPhaseTab === "write" ? "var(--selected-row-bg)" : "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Write
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditPhaseTab("preview")}
                      style={{
                        padding: "8px 10px",
                        border: "none",
                        background: editPhaseTab === "preview" ? "var(--selected-row-bg)" : "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Preview
                    </button>
                  </div>
                  {editPhaseTab === "write" ? (
                    <textarea
                      value={editPhaseDescription}
                      onChange={(e) => setEditPhaseDescription(e.target.value)}
                      placeholder="Optional notes for this phase. The task checklist is auto-generated."
                      style={{
                        width: "100%",
                        minHeight: 180,
                        padding: 10,
                        border: "none",
                        outline: "none",
                        background: "transparent",
                        color: "var(--text)",
                        resize: "vertical",
                      }}
                    />
                  ) : (
                    <div style={{ padding: 10, minHeight: 180, overflow: "auto" }}>
                      {editPhaseDescription.trim() ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{editPhaseDescription}</ReactMarkdown>
                      ) : (
                        <div className="small">Nothing to preview.</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="small" style={{ color: "var(--muted-2)" }}>
                The task checklist section is not editable here and will be regenerated automatically.
              </div>
            </div>
            <div className="modalActions">
              <button type="button" onClick={() => setEditPhaseOpen(false)} style={{ padding: "10px 12px", borderRadius: 10 }}>
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!selectedPhase || !onSavePhaseMeta) return;
                  try {
                    setPhaseMetaBusy(true);
                    const meta = await onSavePhaseMeta(selectedPhase, editPhaseDescription);
                    setPhaseMeta(meta);
                    setEditPhaseOpen(false);
                  } catch (e: any) {
                    setPhaseMetaErr(e?.message || String(e));
                  } finally {
                    setPhaseMetaBusy(false);
                  }
                }}
                disabled={!selectedPhase || !onSavePhaseMeta}
                style={{ padding: "10px 12px", borderRadius: 10 }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="taskList" onClick={clearSelection}>
        {!hideHeader ? (
          <div className="ganttHeader" style={{ padding: 12, height: headerHeight, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div className="label">{phaseSummary ? "Project" : "Phase"}</div>
            {phaseSummary ? (
              <select value={projectName.trim() ? "current" : ""} disabled>
                <option value="">All projects</option>
                {projectName.trim() ? <option value="current">{projectName.trim()}</option> : null}
              </select>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ position: "relative", flex: 1 }} onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => setPhasePickerOpen((v) => !v)}
                    style={{
                      width: "100%",
                      height: 44,
                      padding: "10px 10px",
                      borderRadius: 10,
                      border: "1px solid var(--border-2)",
                      background: "var(--input-bg)",
                      color: "var(--text)",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                    title={phaseFilterLabel}
                  >
                    {phaseFilterLabel}
                  </button>
                  {phasePickerOpen ? (
                    <div
                      style={{
                        position: "absolute",
                        zIndex: 5,
                        top: 48,
                        left: 0,
                        right: 0,
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        padding: 10,
                        boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
                        maxHeight: 260,
                        overflow: "auto",
                      }}
                    >
                      <label style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 6px", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={(phaseFilter || []).length === 0}
                          onChange={() => setPhaseFilter([])}
                        />
                        <span>All phases</span>
                      </label>
                      <div style={{ height: 1, background: "var(--border)", margin: "6px 0" }} />
                      {phases.map((ph) => {
                        const selected = (phaseFilter || []).includes(ph);
                        return (
                          <label key={ph} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 6px", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => {
                                const cur = (phaseFilter || []).slice();
                                // If we were in "All phases" mode (empty), start from empty selection.
                                const base = cur.length === 0 ? [] : cur;
                                const idx = base.indexOf(ph);
                                if (idx >= 0) base.splice(idx, 1);
                                else base.push(ph);
                                setPhaseFilter(base);
                              }}
                            />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{formatPhaseLabel(ph)}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onAddPhase?.()}
                  disabled={!onAddPhase}
                  title="Add phase"
                  style={{
                    width: 44,
                    height: 44,
                    padding: 0,
                    borderRadius: 10,
                    border: "1px solid var(--border-2)",
                    background: "var(--card)",
                    color: "var(--text)",
                    cursor: "pointer",
                    flex: "0 0 auto",
                  }}
                >
                  +
                </button>
              </div>
            )}
          </div>
          <div style={{ flex: 1 }} />
        </div>
        ) : null}

        <div>
          {phaseSummary
            ? (
                <>
                  {/* Project header row (replaces Phase header) */}
                  <div
                    style={{
                      height: rowHeight,
                      padding: "0 12px",
                      borderBottom: "1px solid var(--border)",
                      background: "var(--gantt-phase-header)",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={projectName.trim() || "Project"}
                  >
                    {projectName.trim() || "Project"}
                  </div>

                  {/* Phase rows (replace Task rows) */}
                  {phaseRows.map((ph) => (
                    <div
                      key={ph}
                      style={{
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--border)",
                        height: rowHeight,
                        display: "flex",
                        alignItems: "center",
                        overflow: "hidden",
                      }}
                      title={ph}
                    >
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ph}</span>
                    </div>
                  ))}
                </>
              )
            : groups.map(g => (
                <div key={g.phase}>
                  <div
                    style={{
                      height: rowHeight,
                      padding: "0 12px",
                      borderBottom: "1px solid var(--border)",
                      background: "var(--gantt-phase-header)",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      cursor: onFetchPhaseMeta ? "pointer" : "default",
                    }}
                    title={onFetchPhaseMeta ? "Open phase meta issue" : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!onFetchPhaseMeta) return;
                      void selectPhase(g.phase);
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {formatPhaseLabel(g.phase)}
                    </span>
                    {!phaseSummary ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddTask?.(g.phase);
                        }}
                        disabled={!onAddTask}
                        title="Add task"
                        aria-label={`Add task to phase ${g.phase}`}
                        style={{
                          width: 30,
                          height: 30,
                          padding: 0,
                          borderRadius: 10,
                          border: "1px solid var(--border-2)",
                          background: "var(--card)",
                          color: "var(--text)",
                          cursor: "pointer",
                          flex: "0 0 auto",
                        }}
                      >
                        +
                      </button>
                    ) : null}
                  </div>
                  {g.tasks.map(t => (
                    <div
                      key={t.id}
                      style={{
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--border)",
                        height: rowHeight,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        overflow: "hidden",
                        cursor: "pointer",
                        background: t.id === selectedId ? "var(--selected-row-bg)" : "transparent",
                      }}
                      title={t.details || t.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectTask(t.id);
                      }}
                    >
                      <span className="mono" style={{ width: 54, flex: "0 0 auto", color: "var(--muted-2)" }}>
                        {t.display_id || t.display_task_id || "—"}
                      </span>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                    </div>
                  ))}
                </div>
              ))}
        </div>
      </div>

      <div
        style={{ overflow: "auto", position: "relative" }}
        onClick={() => {
          // Clicking the empty chart area clears selection.
          clearSelection();
        }}
      >
        {!hideHeader ? (
          <div className="ganttHeader" style={{ padding: 12, minWidth: svgWidth, height: headerHeight, display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              {/* Keep vertical alignment with Phase label, but don't show "Search" text */}
              <div className="label" style={{ visibility: "hidden" }}>
                Search
              </div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={phaseSummary ? "Phase summary view" : "Filter tasks…"}
                disabled={phaseSummary}
              />
            </div>
          </div>
        ) : null}

        {/* Centered, inset overlay panel fixed to viewport (does not scroll away). */}
        {infoOpen && !suppressInfoPanel ? (
          <div
            style={{
              position: "fixed",
              left: panelBounds?.left ?? taskListWidth + 24,
              right: panelBounds?.right ?? 24,
              top: panelBounds?.top ?? (hideHeader ? 24 : 90),
              bottom: panelBounds?.bottom ?? 24,
              zIndex: 60,
              pointerEvents: "none",
              padding: infoPanelInset,
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                pointerEvents: "auto",
                width: "100%",
                maxWidth: infoPanelMaxWidth,
                minWidth: infoPanelMinWidth,
                height: "100%",
                background: "var(--overlay-bg)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                boxShadow: "var(--overlay-shadow)",
                overflow: "hidden",
                backdropFilter: "blur(2px)",
              }}
            >
                <div style={{ padding: 12, borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
                  <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>{selectedPhase ? "Phase details" : "Task details"}</div>
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flex: "0 0 auto" }}>
                      {selectedPhase ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              if (!selectedPhase) return;
                              if (!phaseMeta) return;
                              setEditPhaseDescription(phaseMeta.description || "");
                              setEditPhaseTab("write");
                              setEditPhaseOpen(true);
                            }}
                            disabled={!selectedPhase || !phaseMeta || !onSavePhaseMeta}
                            style={{
                              padding: "6px 10px",
                              borderRadius: 10,
                              border: "1px solid var(--border-2)",
                              background: "var(--card)",
                              color: "var(--text)",
                              lineHeight: 1,
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!selectedPhase) return;
                              const ok = window.confirm(`Delete phase "${selectedPhase}" and all its tasks? This cannot be undone.`);
                              if (!ok) return;
                              onDeletePhase?.(selectedPhase);
                              setSelectedPhase("");
                              setPhaseMeta(null);
                              setInfoOpen(false);
                            }}
                            disabled={!selectedPhase || !onDeletePhase}
                            style={{
                              padding: "6px 10px",
                              borderRadius: 10,
                              border: "1px solid var(--toast-error-border)",
                              background: "var(--card)",
                              color: "var(--toast-error-text)",
                              lineHeight: 1,
                            }}
                          >
                            Delete
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              if (!selected) return;
                              onEditTask?.(selected.id);
                            }}
                            disabled={!selected || !onEditTask}
                            style={{
                              padding: "6px 10px",
                              borderRadius: 10,
                              border: "1px solid var(--border-2)",
                              background: "var(--card)",
                              color: "var(--text)",
                              lineHeight: 1,
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!selected) return;
                              const ok = window.confirm("Delete this task? Dependency references will be removed from other tasks.");
                              if (!ok) return;
                              onDeleteTask?.(selected.id);
                              setInfoOpen(false);
                            }}
                            disabled={!selected || !onDeleteTask}
                            style={{
                              padding: "6px 10px",
                              borderRadius: 10,
                              border: "1px solid var(--toast-error-border)",
                              background: "var(--card)",
                              color: "var(--toast-error-text)",
                              lineHeight: 1,
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => setInfoOpen(false)}
                        title="Close details panel"
                        aria-label="Close details panel"
                        style={{
                          padding: "6px 10px",
                          borderRadius: 10,
                          border: "1px solid var(--border-2)",
                          background: "var(--card)",
                          color: "var(--text)",
                          lineHeight: 1,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
                <div style={{ padding: 12, overflow: "auto", height: "calc(100% - 62px)" }}>
                  {selectedPhase ? (
                    <>
                      <div style={{ display: "grid", gap: 10 }}>
                        <div style={{ display: "grid", gap: 4 }}>
                          <div className="small" style={{ color: "var(--muted-2)" }}>
                            Phase
                          </div>
                          <div style={{ fontWeight: 700 }}>{selectedPhase}</div>
                        </div>
                        {phaseMetaBusy ? <div className="small">Loading phase meta issue…</div> : null}
                        {phaseMetaErr ? (
                          <div className="small" style={{ color: "var(--toast-error-text)" }}>
                            {phaseMetaErr}
                          </div>
                        ) : null}
                        {phaseMeta ? (
                          <>
                            {phaseMeta.issue_url ? (
                              <a href={phaseMeta.issue_url} target="_blank" rel="noreferrer" className="small">
                                {phaseMeta.issue_url}
                              </a>
                            ) : (
                              <div className="small" style={{ color: "var(--muted-2)" }}>
                                Draft issue (no URL)
                              </div>
                            )}
                            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{phaseMeta.body || ""}</ReactMarkdown>
                            </div>
                            <div className="small" style={{ color: "var(--muted-2)" }}>
                              Note: the task checklist above is auto-generated and will be overwritten on sync.
                            </div>
                          </>
                        ) : null}
                      </div>
                    </>
                  ) : !selected ? (
                    <div className="small">No task selected.</div>
                  ) : (
                    <>
                      {(() => {
                        const display = selected.display_id || selected.display_task_id || "—";
                        const title = selected.title || selected.name || "—";
                        const state = (selected.state || "").toLowerCase();
                        const stateVariant = state === "closed" ? "red" : "green";
                        const slackDays = selected.slack_days;
                        const isCritical = Boolean(selected.is_critical);
                        const deps = selected.dependencies || [];
                        const dependents = dependentsById.get(selected.id) || [];
                        const depDisplay = deps.map((dep) => displayById.get(dep) || dep);
                        const dependentDisplay = dependents.map((id) => displayById.get(id) || id);

                        const sidebarCard: React.CSSProperties = {
                          border: "1px solid var(--border)",
                          borderRadius: 14,
                          padding: 12,
                          background: "var(--card)",
                        };

                        const statusText = (() => {
                          const st = (selected.status || "").trim();
                          if (st) return st;
                          const known = new Set(["Backlog", "Planned", "In Progress", "In Review", "Done"]);
                          const ph = (selected.phase || "").trim();
                          return known.has(ph) ? ph : "Backlog";
                        })();

                        return (
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 320px",
                              gap: 16,
                              alignItems: "start",
                              minWidth: 0,
                            }}
                          >
                            {/* Left column: main content */}
                            <div style={{ minWidth: 0 }}>
                              {/* Header */}
                              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.2, marginBottom: 8 }}>
                                    {title}
                                  </div>
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                                    <Pill text={state ? state.charAt(0).toUpperCase() + state.slice(1) : "Open"} variant={stateVariant as any} />
                                    <Pill text={`ID: ${display}`} variant="neutral" />
                                    {isCritical ? <Pill text="Critical path" variant="red" title="Slack = 0 days" /> : null}
                                    {typeof slackDays === "number" ? <Pill text={`Slack: ${slackDays}d`} variant="purple" /> : null}
                                  </div>
                                </div>
                                {selected.url ? (
                                  <a
                                    href={selected.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{
                                      color: "var(--gantt-selected)",
                                      fontWeight: 700,
                                      textDecoration: "none",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    Open on GitHub
                                  </a>
                                ) : null}
                              </div>

                              <div style={{ height: 12 }} />

                              {/* Body */}
                              <div>
                                <div className="label">Description</div>
                                <MarkdownBox markdown={selected.details || selected.body || ""} />
                              </div>

                              {selected.acceptance_criteria ? (
                                <>
                                  <div style={{ height: 12 }} />
                                  <div>
                                    <div className="label">Acceptance criteria</div>
                                    <MarkdownBox markdown={selected.acceptance_criteria} />
                                  </div>
                                </>
                              ) : null}

                              {/* Activity / history */}
                              <div style={{ height: 12 }} />
                              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                                <div style={{ fontWeight: 800, marginBottom: 8 }}>Activity</div>
                                <div style={{ display: "grid", gap: 8 }}>
                                  <div className="small">
                                    <span style={{ fontWeight: 700 }}>Scheduled</span>: {selected.schedule.start} → {selected.schedule.end}
                                  </div>
                                  {selected.start_date || selected.end_date ? (
                                    <div className="small">
                                      <span style={{ fontWeight: 700 }}>Planned window</span>: {(selected.start_date ?? "—")} → {(selected.end_date ?? "—")}
                                    </div>
                                  ) : null}
                                  <div className="small">
                                    <span style={{ fontWeight: 700 }}>Dependencies</span>: {depDisplay.length ? depDisplay.join(", ") : "None"}
                                  </div>
                                  <div className="small">
                                    <span style={{ fontWeight: 700 }}>Dependents</span>: {dependentDisplay.length ? dependentDisplay.join(", ") : "None"}
                                  </div>
                                  <div className="small">
                                    <span style={{ fontWeight: 700 }}>Created</span>: {fmtIsoDateTime((selected as any).created_at)}
                                  </div>
                                  <div className="small">
                                    <span style={{ fontWeight: 700 }}>Updated</span>: {fmtIsoDateTime((selected as any).updated_at)}
                                  </div>
                                  {(selected as any).closed_at ? (
                                    <div className="small">
                                      <span style={{ fontWeight: 700 }}>Closed</span>: {fmtIsoDateTime((selected as any).closed_at)}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </div>

                            {/* Right column: sidebar */}
                            <div style={{ display: "grid", gap: 12 }}>
                              <div style={sidebarCard}>
                                <div style={{ fontWeight: 800, marginBottom: 8 }}>Details</div>
                                <div style={{ display: "grid", gap: 8 }}>
                                  <div className="small">
                                    <span style={{ fontWeight: 700 }}>Display ID</span>: <span className="mono">{display}</span>
                                  </div>
                                  <div className="small">
                                    <span style={{ fontWeight: 700 }}>Status</span>: {statusText}
                                  </div>
                                  <div className="small">
                                    <span style={{ fontWeight: 700 }}>Phase</span>: {selected.phase || "—"}
                                  </div>
                                  {selected.durations ? (
                                    <div className="small">
                                      <span style={{ fontWeight: 700 }}>Durations</span>: wall {selected.durations.wall}d / billable{" "}
                                      {selected.durations.billable}d
                                    </div>
                                  ) : null}
                                  {selected.milestone_or_output ? (
                                    <div className="small">
                                      <span style={{ fontWeight: 700 }}>Milestone</span>: {selected.milestone_or_output}
                                    </div>
                                  ) : null}
                                </div>
                              </div>

                              <div style={sidebarCard}>
                                <div style={{ fontWeight: 800, marginBottom: 8 }}>Assignees</div>
                                {selected.assignees && selected.assignees.length ? (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                    {selected.assignees.map((a) => (
                                      <Pill key={a} text={a} variant="neutral" />
                                    ))}
                                  </div>
                                ) : (
                                  <div className="small">None</div>
                                )}
                              </div>

                              <div style={sidebarCard}>
                                <div style={{ fontWeight: 800, marginBottom: 8 }}>Labels</div>
                                {selected.labels && selected.labels.length ? (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                    {selected.labels.map((l) => (
                                      <Pill key={l} text={l} variant="blue" />
                                    ))}
                                  </div>
                                ) : (
                                  <div className="small">None</div>
                                )}
                              </div>

                              <div style={sidebarCard}>
                                <div style={{ fontWeight: 800, marginBottom: 8 }}>Dependencies</div>
                                {depDisplay.length ? (
                                  <div style={{ display: "grid", gap: 6 }}>
                                    {depDisplay.map((d) => (
                                      <div key={d} className="small">
                                        {d}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="small">None</div>
                                )}
                              </div>

                              <div style={sidebarCard}>
                                <div style={{ fontWeight: 800, marginBottom: 8 }}>Dependents</div>
                                {dependentDisplay.length ? (
                                  <div style={{ display: "grid", gap: 6 }}>
                                    {dependentDisplay.map((d) => (
                                      <div key={d} className="small">
                                        {d}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="small">None</div>
                                )}
                              </div>

                              {selected.notes ? (
                                <div style={sidebarCard}>
                                  <div style={{ fontWeight: 800, marginBottom: 8 }}>Notes</div>
                                  <div style={{ whiteSpace: "pre-wrap" }} className="small">
                                    {selected.notes}
                                  </div>
                                </div>
                              ) : null}

                              <details style={sidebarCard as any}>
                                <summary className="small" style={{ cursor: "pointer", fontWeight: 800 }}>
                                  Raw identifiers
                                </summary>
                                <div className="small" style={{ marginTop: 10, display: "grid", gap: 6 }}>
                                  <div>
                                    <span className="mono">Task ID</span>: <span className="mono">{selected.task_id || "—"}</span>
                                  </div>
                                  <div>
                                    <span className="mono">Internal id</span>: <span className="mono">{selected.id}</span>
                                  </div>
                                  {selected.url ? (
                                    <div style={{ wordBreak: "break-all" }}>
                                      <span className="mono">URL</span>: <span className="mono">{selected.url}</span>
                                    </div>
                                  ) : null}
                                </div>
                              </details>
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
            </div>
          </div>
        ) : null}

        <svg width={svgWidth} height={height} style={{ display: "block" }}>
          {phaseLayout === "linear" ? (
            <>
              {/* Day background bands */}
              {dayBands.map((b) => (
                <rect
                  key={b.d}
                  x={chartPadLeft + b.d * pxPerDay}
                  y={0}
                  width={pxPerDay}
                  height={height}
                  fill={b.fill}
                />
              ))}

              {/* Vertical grid lines */}
              {showDailyGrid
                ? Array.from({ length: dayCount + 1 }, (_, d) => (
                    <line
                      key={d}
                      x1={chartPadLeft + d * pxPerDay}
                      y1={0}
                      x2={chartPadLeft + d * pxPerDay}
                      y2={height}
                          stroke="var(--gantt-grid)"
                    />
                  ))
                : ticks.map(d => (
                    <line
                      key={d}
                      x1={chartPadLeft + d * pxPerDay}
                      y1={0}
                      x2={chartPadLeft + d * pxPerDay}
                      y2={height}
                          stroke="var(--gantt-grid)"
                    />
                  ))}

              {/* Global axis labels (rendered inside the chart, like stacked mode) */}
              {(showDailyGrid ? Array.from({ length: dayCount + 1 }, (_, d) => d) : ticks).map((d) => (
                <text
                  key={`tick-linear-${d}`}
                  x={chartPadLeft + d * pxPerDay + 2}
                  y={linearAxisRowIdx * rowHeight + 18}
                  fontSize={11}
                  fill="var(--gantt-axis)"
                >
                  {formatTickForBase(baseUtc, d)}
                </text>
              ))}
            </>
          ) : (
            <>
              {/* Stacked mode: per-phase banding, grid, and per-phase axes */}
              {phaseSections.map((sec) => {
                const phaseBase = baseUtcByPhase.get(sec.phase) ?? baseUtc;
                const y0 = sec.startRowIdx * rowHeight;
                const secH = (sec.endRowIdx - sec.startRowIdx + 1) * rowHeight;

                // Build alternating bands, resetting per phase.
                const fills: string[] = [];
                if (unitMode) {
                  for (let d = 0; d <= dayCount; d += 1) {
                    fills.push(d % 2 === 0 ? "var(--gantt-band-a)" : "var(--gantt-band-b)");
                  }
                } else {
                  let workdayIdx = 0;
                  for (let d = 0; d <= dayCount; d += 1) {
                    const t = phaseBase + d * 24 * 60 * 60 * 1000;
                    const dow = new Date(t).getUTCDay();
                    const isWeekend = dow === 0 || dow === 6;
                    if (isWeekend) fills.push("var(--gantt-weekend)");
                    else {
                      fills.push(workdayIdx % 2 === 0 ? "var(--gantt-band-a)" : "var(--gantt-band-b)");
                      workdayIdx += 1;
                    }
                  }
                }

                const lineDays = showDailyGrid ? Array.from({ length: dayCount + 1 }, (_, d) => d) : ticks;

                return (
                  <g key={`phase-${sec.phase}`}>
                    {/* Day background bands for this phase section */}
                    {fills.map((fill, d) => (
                      <rect
                        key={`band-${sec.phase}-${d}`}
                        x={chartPadLeft + d * pxPerDay}
                        y={y0}
                        width={pxPerDay}
                        height={secH}
                        fill={fill}
                      />
                    ))}

                    {/* Vertical grid lines for this phase section */}
                    {lineDays.map((d) => (
                      <line
                        key={`grid-${sec.phase}-${d}`}
                        x1={chartPadLeft + d * pxPerDay}
                        y1={y0}
                        x2={chartPadLeft + d * pxPerDay}
                        y2={y0 + secH}
                        stroke="var(--gantt-grid)"
                      />
                    ))}

                    {/* Per-phase axis labels on the phase header row (skip in Phase Summary) */}
                    {!phaseSummary
                      ? lineDays.map((d) => (
                          <text
                            key={`tick-${sec.phase}-${d}`}
                            x={chartPadLeft + d * pxPerDay + 2}
                            y={sec.headerRowIdx * rowHeight + 18}
                            fontSize={11}
                            fill="var(--gantt-axis)"
                          >
                            {formatTickForBase(phaseBase, d)}
                          </text>
                        ))
                      : null}
                  </g>
                );
              })}

              {/* Phase Summary: show date/counter inside the phase bubbles instead of a full-width axis row. */}
            </>
          )}

          {showDeps && depPaths.map(p => (
            <path key={p.key} d={p.d} fill="none" stroke="var(--gantt-dep)" strokeWidth={1} />
          ))}

          {unitMode || (phaseSummary && phaseLayout === "stacked")
            ? rowBubbles.map((b) => {
                const y = b.rowIdx * rowHeight + 5;
                const h = rowHeight - 10;
                const selectedRow = selectedId ? rowIndexById.get(selectedId) : undefined;
                const isSelectedRow = selectedRow === b.rowIdx;
                const isCritical = showCriticalPath && b.isCritical;
                const strokeColor = isSelectedRow ? "var(--gantt-selected)" : isCritical ? "var(--gantt-critical)" : "var(--text)";

                const padL = Math.max(0, barPadPx);
                const padR = Math.max(0, barPadPx);
                const x = chartPadLeft + b.startX * pxPerDay + padL;
                const w = Math.max(2, Math.max(6, (b.endX - b.startX) * pxPerDay) - padL - padR);
                const d = barPath(x, y, w, h, true, true);

                // In Phase Summary (stacked), show one date/counter inside each bubble.
                let bubbleLabel: string | null = null;
                if (phaseSummary && phaseLayout === "stacked" && b.startUtc != null) {
                  const MS_DAY = 24 * 60 * 60 * 1000;
                  const offDays = Math.max(0, Math.floor((b.startUtc - baseUtc) / MS_DAY));
                  if (timeAxisMode === "calendarDays") {
                    bubbleLabel = dateFmt.format(new Date(b.startUtc));
                  } else if (timeAxisMode === "calendarWeeks") {
                    const wkStartUtc = baseUtc + Math.floor(offDays / 7) * 7 * MS_DAY;
                    bubbleLabel = dateFmt.format(new Date(wkStartUtc));
                  } else if (timeAxisMode === "calendarMonths") {
                    const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
                    bubbleLabel = monthFmt.format(new Date(b.startUtc));
                  } else if (timeAxisMode === "months") {
                    const dt0 = new Date(baseUtc);
                    const dt = new Date(b.startUtc);
                    const offMonths = (dt.getUTCFullYear() - dt0.getUTCFullYear()) * 12 + (dt.getUTCMonth() - dt0.getUTCMonth());
                    bubbleLabel = String(offMonths);
                  } else if (timeAxisMode === "weeks") {
                    bubbleLabel = String(Math.floor(offDays / 7));
                  } else {
                    bubbleLabel = String(offDays);
                  }
                  // If the bubble is too small, omit the label to avoid clutter.
                  if (w < 32) bubbleLabel = null;
                }

                return (
                  <g
                    key={`bubble-${b.rowIdx}`}
                    data-kanlytics-taskbar="1"
                    onClick={(e) => {
                      e.stopPropagation();
                      selectTask(b.repId);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <path d={d} fill="none" stroke={strokeColor} strokeWidth={isCritical ? 2.5 : 2} opacity={0.9} />
                    {bubbleLabel ? (
                      <text
                        x={x + 8}
                        y={y + h / 2 + 4}
                        fontSize={11}
                        fill="var(--text)"
                        textAnchor="start"
                        style={{ pointerEvents: "none" }}
                      >
                        {bubbleLabel}
                      </text>
                    ) : null}
                  </g>
                );
              })
            : renderTasks.map(t => {
            const span = drawSpanById.get(t.id);
            const segs = segmentsById.get(t.id) || [];
            const rowIdx = rowIndexById.get(t.id) ?? t.schedule.row;
            const y = rowIdx * rowHeight + 5;
            const h = rowHeight - 10;
            const labelRendered = false;
            const isSelected = t.id === selectedId;
            const isMilestone = (span?.wDay ?? 0) === 0;
            const isCritical =
              showCriticalPath &&
              (criticalIdSet.has(t.id) || t.is_critical || (t.slack_days ?? 0) === 0);
            const strokeColor = isSelected ? "var(--gantt-selected)" : isCritical ? "var(--gantt-critical)" : "var(--text)";
            return (
              <g
                key={t.id}
                data-kanlytics-taskbar="1"
                onClick={(e) => {
                  e.stopPropagation();
                  selectTask(t.id);
                }}
                style={{ cursor: "pointer" }}
              >
                {isMilestone ? (
                  (() => {
                    const xDay = span?.xDay ?? (t.schedule.x ?? 0);
                    const cx = chartPadLeft + xDay * pxPerDay + pxPerDay / 2;
                    const cy = y + h / 2;
                    const r = Math.min(10, Math.max(6, pxPerDay * 0.28));
                    const pts = `${cx} ${cy - r} ${cx + r} ${cy} ${cx} ${cy + r} ${cx - r} ${cy}`;
                    return (
                      <>
                        <polygon
                          points={pts}
                          fill="var(--card)"
                          stroke={strokeColor}
                          strokeWidth={isCritical ? 2.5 : 2}
                          opacity={0.95}
                        />
                      </>
                    );
                  })()
                ) : segs.length === 0 ? (
                  (() => {
                    const xDay = span?.xDay ?? (t.schedule.x ?? 0);
                    const wDay = Math.max(1, span?.wDay ?? (t.schedule.w ?? 0));
                    const padL = Math.max(0, barPadPx);
                    const padR = Math.max(0, barPadPx);
                    const x = chartPadLeft + xDay * pxPerDay + padL;
                    const w = Math.max(2, Math.max(6, wDay * pxPerDay) - padL - padR);
                    const d = barPath(x, y, w, h, true, true);
                    return (
                      <>
                        <path d={d} fill="none" stroke={strokeColor} strokeWidth={isCritical ? 2.5 : 2} opacity={0.9} />
                        {!phaseSummary ? (
                          <text x={x + 8} y={y + h / 2 + 4} fontSize={11} fill="var(--text)" style={{ pointerEvents: "none" }}>
                            {t.display_id || t.display_task_id || ""}
                          </text>
                        ) : null}
                      </>
                    );
                  })()
                ) : (
                  <>
                    {segs.map((seg, idx) => {
                      const padL = seg.roundLeft ? Math.max(0, barPadPx) : 0;
                      const padR = seg.roundRight ? Math.max(0, barPadPx) : 0;
                      const x = chartPadLeft + seg.xDay * pxPerDay + padL;
                      const w = Math.max(2, Math.max(6, seg.wDay * pxPerDay) - padL - padR);
                      const d = barPath(x, y, w, h, seg.roundLeft, seg.roundRight);
                      return (
                        <path
                          key={`${t.id}-seg-${idx}`}
                          d={d}
                          fill="none"
                          stroke={strokeColor}
                          strokeWidth={isCritical ? 2.5 : 2}
                          opacity={0.9}
                        />
                      );
                    })}
                    {/* Label once, on the first segment */}
                    {!phaseSummary ? (
                      <text
                        x={chartPadLeft + segs[0].xDay * pxPerDay + (segs[0].roundLeft ? Math.max(0, barPadPx) : 0) + 8}
                        y={y + h / 2 + 4}
                        fontSize={11}
                        fill="var(--text)"
                        style={{ pointerEvents: "none" }}
                      >
                        {t.display_id || t.display_task_id || ""}
                      </text>
                    ) : null}
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
