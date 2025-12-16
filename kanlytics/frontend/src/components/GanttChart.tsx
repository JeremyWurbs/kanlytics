import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Edge, GanttLayout, TaskItem } from "../types";

type Props = {
  layout: GanttLayout;
  pxPerDay?: number;
  rowHeight?: number;
  showDeps?: boolean;
  showDailyGrid?: boolean;
  timeAxisMode?: "dayCount" | "calendar";
  phaseLayout?: "linear" | "stacked";
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
  yOffset: number
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
    const ax = xOffset + aEnds.endXDay * pxPerDay;
    const aRow = rowIndexById.get(a.id) ?? a.schedule.row;
    const ay = aRow * rowHeight + rowHeight / 2 + yOffset;

    // Arrow end: start of dependent bar
    const bx = xOffset + bEnds.startXDay * pxPerDay;
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
  timeAxisMode = "dayCount",
  phaseLayout = "stacked",
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
      const key = t.display_id || t.display_task_id || t.id;
      const hay = `${key} ${t.name} ${t.details ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tasks, search, phaseFilter]);

  // Base project start (UTC midnight).
  const baseUtc = useMemo(() => parseIsoDateUtc(layout.meta.project_start) ?? Date.now(), [layout.meta.project_start]);

  const spanById = useMemo(() => {
    const m = new Map<string, { xDay: number; wDay: number }>();
    for (const t of filtered) {
      const startUtc = parseIsoDateUtc(t.schedule.start);
      const endUtc = parseIsoDateUtc(t.schedule.end);
      if (startUtc == null || endUtc == null) {
        // Fallback to backend-provided day units
        m.set(t.id, { xDay: t.schedule.x ?? 0, wDay: t.schedule.w ?? 0 });
        continue;
      }
      const xDay = Math.max(0, Math.floor((startUtc - baseUtc) / (24 * 60 * 60 * 1000)));
      const wDay = Math.max(0, Math.floor((endUtc - startUtc) / (24 * 60 * 60 * 1000)) + 1); // inclusive end
      m.set(t.id, { xDay, wDay });
    }
    return m;
  }, [filtered, baseUtc]);

  const phaseStartByPhase = useMemo(() => {
    const m = new Map<string, number>();
    if (phaseLayout !== "stacked") return m;
    for (const t of filtered) {
      const span = spanById.get(t.id);
      if (!span) continue;
      const ph = t.phase || "Unphased";
      const cur = m.get(ph);
      m.set(ph, cur == null ? span.xDay : Math.min(cur, span.xDay));
    }
    return m;
  }, [filtered, spanById, phaseLayout]);

  const baseUtcByPhase = useMemo(() => {
    const m = new Map<string, number>();
    if (phaseLayout !== "stacked") return m;
    for (const [ph, startDay] of phaseStartByPhase.entries()) {
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
    for (const t of filtered) {
      const span = spanById.get(t.id);
      if (!span) continue;
      const ph = t.phase || "Unphased";
      const off = phaseStartByPhase.get(ph) ?? 0;
      m.set(t.id, { xDay: Math.max(0, span.xDay - off), wDay: span.wDay });
    }
    return m;
  }, [filtered, spanById, phaseStartByPhase, phaseLayout]);

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

    const splitOnWeekends = Boolean(layout.meta.working_days);

    for (const t of filtered) {
      const span = drawSpanById.get(t.id);
      if (!span) continue;

      const ph = t.phase || "Unphased";
      const phaseBase = phaseLayout === "stacked" ? (baseUtcByPhase.get(ph) ?? baseUtc) : baseUtc;

      const startDay = span.xDay;
      const totalDays = Math.max(1, span.wDay); // render milestones as 1-day visual
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
  }, [filtered, drawSpanById, baseUtc, baseUtcByPhase, phaseLayout, layout.meta.working_days]);

  const barEndsById = useMemo(() => {
    // For arrows: use the first segment start and last segment end (in day units).
    const m = new Map<string, { startXDay: number; endXDay: number }>();
    for (const t of filtered) {
      const segs = segmentsById.get(t.id) || [];
      const span = drawSpanById.get(t.id);
      if (!span) continue;

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
  }, [filtered, segmentsById, drawSpanById]);

  const maxXDay = useMemo(() => {
    let m = 0;
    for (const t of filtered) {
      const ends = barEndsById.get(t.id);
      if (!ends) continue;
      m = Math.max(m, ends.endXDay);
    }
    return m;
  }, [filtered, barEndsById]);

  const width = Math.max(900, (maxXDay + 5) * pxPerDay);
  const chartPadLeft = 10; // pixels of breathing room at left edge
  const svgWidth = width + chartPadLeft;
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
  }, [phaseSections]);

  const height = useMemo(() => Math.max(220, (displayRows.length + 1) * rowHeight), [displayRows.length, rowHeight]);

  const depPaths = useMemo(
    () =>
      showDeps
        ? buildDepPaths(
            filtered,
            layout.edges,
            rowIndexById,
            drawSpanById,
            barEndsById,
            phaseLayout,
            phaseHeaderRowByPhase,
            chartPadLeft,
            pxPerDay,
            rowHeight,
            chartYOffset
          )
        : [],
    [
      filtered,
      layout.edges,
      rowIndexById,
      drawSpanById,
      barEndsById,
      phaseLayout,
      phaseHeaderRowByPhase,
      chartPadLeft,
      pxPerDay,
      rowHeight,
      chartYOffset,
      showDeps,
    ]
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

  const dayCount = useMemo(() => Math.ceil(width / pxPerDay), [width, pxPerDay]);

  const dateFmt = useMemo(() => new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit" }), []);

  const formatTickForBase = useMemo(() => {
    if (timeAxisMode !== "calendar") return (_base: number, d: number) => String(d);
    // Calendar axis: always add calendar days (do not "skip" weekends visually).
    return (base: number, d: number) => dateFmt.format(new Date(base + d * 24 * 60 * 60 * 1000));
  }, [timeAxisMode, dateFmt]);

  const formatTick = useMemo(() => (d: number) => formatTickForBase(baseUtc, d), [formatTickForBase, baseUtc]);

  const dayBands = useMemo(() => {
    // Background banding for LINEAR mode (single global axis).
    const out: { d: number; fill: string }[] = [];
    let workdayIdx = 0;
    for (let d = 0; d <= dayCount; d += 1) {
      const t = baseUtc + d * 24 * 60 * 60 * 1000;
      const dow = new Date(t).getUTCDay(); // 0=Sun..6=Sat
      const isWeekend = dow === 0 || dow === 6;
      if (isWeekend) {
        out.push({ d, fill: "#e6f3ff" });
      } else {
        const fill = workdayIdx % 2 === 0 ? "#ffffff" : "#f8fafc";
        out.push({ d, fill });
        workdayIdx += 1;
      }
    }
    return out;
  }, [baseUtc, dayCount]);

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
                  <span className="mono" style={{ width: 54, flex: "0 0 auto", color: "#475569" }}>
                    {t.display_id || t.display_task_id || "—"}
                  </span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div style={{ overflow: "auto" }}>
        <div ref={rightHeaderRef} className="ganttHeader" style={{ padding: 12, minWidth: svgWidth }}>
          <svg width={svgWidth} height={28}>
            {phaseLayout === "linear"
              ? ticks.map(d => (
                  <g key={d}>
                    <line x1={chartPadLeft + d * pxPerDay} y1={0} x2={chartPadLeft + d * pxPerDay} y2={28} stroke="#e2e8f0" />
                    <text x={chartPadLeft + d * pxPerDay + 2} y={18} fontSize={11} fill="#475569">
                      {formatTick(d)}
                    </text>
                  </g>
                ))
              : null}
          </svg>
        </div>

        <svg width={svgWidth} height={height + chartYOffset} style={{ display: "block" }}>
          {phaseLayout === "linear" ? (
            <>
              {/* Day background bands */}
              {dayBands.map((b) => (
                <rect
                  key={b.d}
                  x={chartPadLeft + b.d * pxPerDay}
                  y={0}
                  width={pxPerDay}
                  height={height + chartYOffset}
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
                      y2={height + chartYOffset}
                      stroke="#e2e8f0"
                    />
                  ))
                : ticks.map(d => (
                    <line
                      key={d}
                      x1={chartPadLeft + d * pxPerDay}
                      y1={0}
                      x2={chartPadLeft + d * pxPerDay}
                      y2={height + chartYOffset}
                      stroke="#e2e8f0"
                    />
                  ))}
            </>
          ) : (
            <>
              {/* Stacked mode: per-phase banding, grid, and per-phase axes */}
              {phaseSections.map((sec) => {
                const phaseBase = baseUtcByPhase.get(sec.phase) ?? baseUtc;
                const y0 = sec.startRowIdx * rowHeight + chartYOffset;
                const secH = (sec.endRowIdx - sec.startRowIdx + 1) * rowHeight;

                // Build alternating weekday colors, resetting per phase.
                const fills: string[] = [];
                let workdayIdx = 0;
                for (let d = 0; d <= dayCount; d += 1) {
                  const t = phaseBase + d * 24 * 60 * 60 * 1000;
                  const dow = new Date(t).getUTCDay();
                  const isWeekend = dow === 0 || dow === 6;
                  if (isWeekend) fills.push("#e6f3ff");
                  else {
                    fills.push(workdayIdx % 2 === 0 ? "#ffffff" : "#f8fafc");
                    workdayIdx += 1;
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
                        stroke="#e2e8f0"
                      />
                    ))}

                    {/* Per-phase axis labels on the phase header row */}
                    {lineDays.map((d) => (
                      <text
                        key={`tick-${sec.phase}-${d}`}
                        x={chartPadLeft + d * pxPerDay + 2}
                        y={sec.headerRowIdx * rowHeight + 18 + chartYOffset}
                        fontSize={11}
                        fill="#475569"
                      >
                        {formatTickForBase(phaseBase, d)}
                      </text>
                    ))}
                  </g>
                );
              })}
            </>
          )}

          {showDeps && depPaths.map(p => (
            <path key={p.key} d={p.d} fill="none" stroke="#94a3b8" strokeWidth={1} />
          ))}

          {filtered.map(t => {
            const span = drawSpanById.get(t.id);
            const segs = segmentsById.get(t.id) || [];
            const rowIdx = rowIndexById.get(t.id) ?? t.schedule.row;
            const y = rowIdx * rowHeight + 5 + chartYOffset;
            const h = rowHeight - 10;
            const labelRendered = false;
            return (
              <g key={t.id}>
                {segs.length === 0 ? (
                  (() => {
                    const xDay = span?.xDay ?? (t.schedule.x ?? 0);
                    const wDay = Math.max(1, span?.wDay ?? (t.schedule.w ?? 0));
                    const x = chartPadLeft + xDay * pxPerDay;
                    const w = Math.max(6, wDay * pxPerDay);
                    const d = barPath(x, y, w, h, true, true);
                    return (
                      <>
                        <path d={d} fill="none" stroke="#0f172a" strokeWidth={2} opacity={0.9} />
                        <text x={x + 8} y={y + h / 2 + 4} fontSize={11} fill="#0f172a" style={{ pointerEvents: "none" }}>
                          {t.display_id || t.display_task_id || ""}
                        </text>
                      </>
                    );
                  })()
                ) : (
                  <>
                    {segs.map((seg, idx) => {
                      const x = chartPadLeft + seg.xDay * pxPerDay;
                      const w = Math.max(6, seg.wDay * pxPerDay);
                      const d = barPath(x, y, w, h, seg.roundLeft, seg.roundRight);
                      return <path key={`${t.id}-seg-${idx}`} d={d} fill="none" stroke="#0f172a" strokeWidth={2} opacity={0.9} />;
                    })}
                    {/* Label once, on the first segment */}
                    <text
                      x={chartPadLeft + segs[0].xDay * pxPerDay + 8}
                      y={y + h / 2 + 4}
                      fontSize={11}
                      fill="#0f172a"
                      style={{ pointerEvents: "none" }}
                    >
                      {t.display_id || t.display_task_id || ""}
                    </text>
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
