import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Edge, GanttLayout, TaskItem } from "../types";

type Props = {
  layout: GanttLayout;
  pxPerDay?: number;
  rowHeight?: number;
  showDeps?: boolean;
  showDailyGrid?: boolean;
  timeAxisMode?: "dayCount" | "calendar";
  phaseLayout?: "linear" | "stacked";
  barPadPx?: number;
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
    const ax = Math.max(xOffset, xOffset + aEnds.endXDay * pxPerDay - barPadPx);
    const aRow = rowIndexById.get(a.id) ?? a.schedule.row;
    const ay = aRow * rowHeight + rowHeight / 2 + yOffset;

    // Arrow end: start of dependent bar
    const bx = Math.max(xOffset, xOffset + bEnds.startXDay * pxPerDay + barPadPx);
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
  barPadPx = 0,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState("");
  const [phaseFilter, setPhaseFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [infoOpen, setInfoOpen] = useState<boolean>(false);

  const tasks = layout.tasks;

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

  // If the selected task disappears (new plan/filtering), clear selection.
  useEffect(() => {
    if (!selectedId) return;
    if (tasks.some(t => t.id === selectedId)) return;
    setSelectedId("");
    setInfoOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length]);

  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const selected = useMemo(() => (selectedId ? taskById.get(selectedId) : undefined), [selectedId, taskById]);

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
            0,
            barPadPx
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
      showDeps,
      barPadPx,
    ]
  );

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
    const MS_DAY = 24 * 60 * 60 * 1000;
    if (timeAxisMode !== "calendar") {
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
  }, [baseUtc, dayCount]);

  function selectTask(id: string) {
    setSelectedId(id);
    setInfoOpen(true);
  }

  function clearSelection() {
    setSelectedId("");
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
  const headerHeight = 112;

  const linearAxisRowIdx = useMemo(() => {
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
    >
      <div className="taskList" onClick={clearSelection}>
        <div className="ganttHeader" style={{ padding: 12, height: headerHeight, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div className="label">Phase</div>
            <select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)}>
              <option value="">All phases</option>
              {phases.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }} />
        </div>

        <div>
          {groups.map(g => (
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
                }}
              >
                {g.phase}
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
        <div className="ganttHeader" style={{ padding: 12, minWidth: svgWidth, height: headerHeight, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            {/* Keep vertical alignment with Phase label, but don't show "Search" text */}
            <div className="label" style={{ visibility: "hidden" }}>
              Search
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tasks…" />
          </div>
        </div>

        {/* Centered, inset overlay panel fixed to viewport (does not scroll away). */}
        {infoOpen ? (
          <div
            style={{
              position: "fixed",
              left: panelBounds?.left ?? taskListWidth + 24,
              right: panelBounds?.right ?? 24,
              top: panelBounds?.top ?? 90,
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
                      <div style={{ fontWeight: 700 }}>Task details</div>
                    </div>
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
                <div style={{ padding: 12, overflow: "auto", height: "calc(100% - 62px)" }}>
                  {!selected ? (
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
                                    <Pill text={`Status: ${statusText}`} variant="blue" />
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

                // Build alternating weekday colors, resetting per phase.
                const fills: string[] = [];
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

                    {/* Per-phase axis labels on the phase header row */}
                    {lineDays.map((d) => (
                      <text
                        key={`tick-${sec.phase}-${d}`}
                        x={chartPadLeft + d * pxPerDay + 2}
                        y={sec.headerRowIdx * rowHeight + 18}
                        fontSize={11}
                        fill="var(--gantt-axis)"
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
            <path key={p.key} d={p.d} fill="none" stroke="var(--gantt-dep)" strokeWidth={1} />
          ))}

          {filtered.map(t => {
            const span = drawSpanById.get(t.id);
            const segs = segmentsById.get(t.id) || [];
            const rowIdx = rowIndexById.get(t.id) ?? t.schedule.row;
            const y = rowIdx * rowHeight + 5;
            const h = rowHeight - 10;
            const labelRendered = false;
            const isSelected = t.id === selectedId;
            return (
              <g
                key={t.id}
                onClick={(e) => {
                  e.stopPropagation();
                  selectTask(t.id);
                }}
                style={{ cursor: "pointer" }}
              >
                {segs.length === 0 ? (
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
                        <path d={d} fill="none" stroke={isSelected ? "var(--gantt-selected)" : "var(--text)"} strokeWidth={2} opacity={0.9} />
                        <text x={x + 8} y={y + h / 2 + 4} fontSize={11} fill="var(--text)" style={{ pointerEvents: "none" }}>
                          {t.display_id || t.display_task_id || ""}
                        </text>
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
                          stroke={isSelected ? "var(--gantt-selected)" : "var(--text)"}
                          strokeWidth={2}
                          opacity={0.9}
                        />
                      );
                    })}
                    {/* Label once, on the first segment */}
                    <text
                      x={chartPadLeft + segs[0].xDay * pxPerDay + (segs[0].roundLeft ? Math.max(0, barPadPx) : 0) + 8}
                      y={y + h / 2 + 4}
                      fontSize={11}
                      fill="var(--text)"
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
