import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Edge, GanttLayout, TaskItem } from "../types";

type Props = {
  layout: GanttLayout;
  pxPerDay?: number;
  rowHeight?: number;
  showDeps?: boolean;
  timeAxisMode?: "dayCount" | "calendar";
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

function maxEndX(tasks: TaskItem[]) {
  let m = 0;
  for (const t of tasks) m = Math.max(m, (t.schedule.x ?? 0) + (t.schedule.w ?? 0));
  return m;
}

function buildDepPaths(
  tasks: TaskItem[],
  edges: Edge[],
  rowIndexById: Map<string, number>,
  pxPerDay: number,
  rowHeight: number,
  yOffset: number
) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const paths: { d: string; key: string }[] = [];
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;

    const ax = (a.schedule.x + Math.max(1, a.schedule.w)) * pxPerDay;
    const aRow = rowIndexById.get(a.id) ?? a.schedule.row;
    const ay = aRow * rowHeight + rowHeight / 2 + yOffset;

    const bx = b.schedule.x * pxPerDay;
    const bRow = rowIndexById.get(b.id) ?? b.schedule.row;
    const by = bRow * rowHeight + rowHeight / 2 + yOffset;

    const midX = (ax + bx) / 2;
    const d = `M ${ax} ${ay} L ${midX} ${ay} L ${midX} ${by} L ${bx} ${by}`;
    paths.push({ d, key: `${e.from}->${e.to}` });
  }
  return paths;
}

export const GanttChart: React.FC<Props> = ({
  layout,
  pxPerDay = 20,
  rowHeight = 28,
  showDeps = true,
  timeAxisMode = "dayCount",
}) => {
  const [search, setSearch] = useState("");
  const [phaseFilter, setPhaseFilter] = useState<string>("");

  const tasks = layout.tasks;
  const leftHeaderRef = useRef<HTMLDivElement | null>(null);
  const rightHeaderRef = useRef<HTMLDivElement | null>(null);
  const [chartYOffset, setChartYOffset] = useState(0);

  const phases = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) s.add(t.phase || "Unphased");
    return Array.from(s).sort();
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter(t => {
      if (phaseFilter && (t.phase || "Unphased") !== phaseFilter) return false;
      if (!q) return true;
      const hay = `${t.id} ${t.name} ${t.details ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tasks, search, phaseFilter]);

  const maxX = maxEndX(filtered);
  const width = Math.max(900, (maxX + 5) * pxPerDay);
  const groups = useMemo(() => groupByPhase(filtered), [filtered]);

  // Build a "display row model" that both panes use. This fixes misalignment when
  // the left pane includes phase header rows (extra vertical height) but the SVG
  // uses schedule.row directly.
  type DisplayRow =
    | { kind: "phase"; phase: string }
    | { kind: "task"; task: TaskItem };

  const displayRows = useMemo<DisplayRow[]>(() => {
    const rows: DisplayRow[] = [];
    for (const g of groups) {
      rows.push({ kind: "phase", phase: g.phase });
      for (const t of g.tasks) rows.push({ kind: "task", task: t });
    }
    return rows;
  }, [groups]);

  const rowIndexById = useMemo(() => {
    const m = new Map<string, number>();
    displayRows.forEach((r, idx) => {
      if (r.kind === "task") m.set(r.task.id, idx);
    });
    return m;
  }, [displayRows]);

  const height = useMemo(() => Math.max(220, (displayRows.length + 1) * rowHeight), [displayRows.length, rowHeight]);

  const depPaths = useMemo(
    () => (showDeps ? buildDepPaths(filtered, layout.edges, rowIndexById, pxPerDay, rowHeight, chartYOffset) : []),
    [filtered, layout.edges, rowIndexById, pxPerDay, rowHeight, chartYOffset, showDeps]
  );

  // The left pane sticky header (search/filters) is taller than the right pane
  // time-axis header. Without compensating, the SVG bars start "too high"
  // compared to the left task rows. Measure and offset the SVG content.
  useLayoutEffect(() => {
    const compute = () => {
      const leftH = leftHeaderRef.current?.getBoundingClientRect().height ?? 0;
      const rightH = rightHeaderRef.current?.getBoundingClientRect().height ?? 0;
      setChartYOffset(Math.max(0, leftH - rightH));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  const ticks = useMemo(() => {
    const N = Math.ceil(width / pxPerDay);
    const step = N > 180 ? 14 : N > 90 ? 7 : 1;
    const out: number[] = [];
    for (let d = 0; d <= N; d += step) out.push(d);
    return out;
  }, [width, pxPerDay]);

  const formatTick = useMemo(() => {
    if (timeAxisMode !== "calendar") return (d: number) => String(d);

    // Parse YYYY-MM-DD safely (avoid timezone parsing surprises).
    const [yy, mm, dd] = (layout.meta.project_start || "").split("-").map(Number);
    const baseUtc =
      Number.isFinite(yy) && Number.isFinite(mm) && Number.isFinite(dd)
        ? Date.UTC(yy, mm - 1, dd)
        : Date.now();

    const fmt = new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit" });
    return (d: number) => fmt.format(new Date(baseUtc + d * 24 * 60 * 60 * 1000));
  }, [timeAxisMode, layout.meta.project_start]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", minWidth: 0 }}>
      <div className="taskList">
        <div ref={leftHeaderRef} className="ganttHeader" style={{ padding: 12 }}>
          <div className="label">Search</div>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tasks…" />
          <div style={{ height: 10 }} />
          <div className="label">Phase</div>
          <select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)}>
            <option value="">All phases</option>
            {phases.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <div style={{ height: 10 }} />
          <div className="small">
            Start: <span className="mono">{layout.meta.project_start}</span><br />
            Mode: <span className="mono">{layout.meta.duration_mode}</span> · Working days: <span className="mono">{String(layout.meta.working_days)}</span>
          </div>
        </div>

        <div>
          {groups.map(g => (
            <div key={g.phase}>
              <div
                style={{
                  height: rowHeight,
                  padding: "0 12px",
                  borderBottom: "1px solid #e2e8f0",
                  background: "#f8fafc",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {g.phase}
              </div>
              {g.tasks.map(t => (
                <div
                  key={t.id}
                  style={{
                    padding: "8px 12px",
                    borderBottom: "1px solid #f1f5f9",
                    height: rowHeight,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    overflow: "hidden",
                  }}
                  title={t.details || t.name}
                >
                  <span className="mono" style={{ width: 54, flex: "0 0 auto", color: "#475569" }}>{t.id}</span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div style={{ overflow: "auto" }}>
        <div ref={rightHeaderRef} className="ganttHeader" style={{ padding: 12, minWidth: width }}>
          <svg width={width} height={28}>
            {ticks.map(d => (
              <g key={d}>
                <line x1={d * pxPerDay} y1={0} x2={d * pxPerDay} y2={28} stroke="#e2e8f0" />
                <text x={d * pxPerDay + 2} y={18} fontSize={11} fill="#475569">{formatTick(d)}</text>
              </g>
            ))}
          </svg>
        </div>

        <svg width={width} height={height + chartYOffset} style={{ display: "block" }}>
          {ticks.map(d => (
            <line key={d} x1={d * pxPerDay} y1={0} x2={d * pxPerDay} y2={height + chartYOffset} stroke="#f1f5f9" />
          ))}

          {showDeps && depPaths.map(p => (
            <path key={p.key} d={p.d} fill="none" stroke="#94a3b8" strokeWidth={1} />
          ))}

          {filtered.map(t => {
            const x = (t.schedule.x ?? 0) * pxPerDay;
            const wRaw = (t.schedule.w ?? 0) * pxPerDay;
            const w = Math.max(6, wRaw); // milestones show as small pill
            const rowIdx = rowIndexById.get(t.id) ?? t.schedule.row;
            const y = rowIdx * rowHeight + 5 + chartYOffset;
            return (
              <g key={t.id}>
                <rect x={x} y={y} width={w} height={rowHeight - 10} rx={8} ry={8} fill="#0f172a" opacity={0.9} />
                <text x={x + 8} y={y + (rowHeight - 10) / 2 + 4} fontSize={11} fill="#ffffff" style={{ pointerEvents: "none" }}>
                  {t.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
