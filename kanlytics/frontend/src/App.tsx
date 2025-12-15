import React, { useMemo, useState } from "react";
import { createPlan, schedulePlan } from "./api";
import type { GanttLayout } from "./types";
import { GanttChart } from "./components/GanttChart";
import "./styles.css";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function App() {
  const apiBase = import.meta.env.VITE_API_BASE || "http://localhost:8080";

  const [controlsOpen, setControlsOpen] = useState<boolean>(true);
  const [fileName, setFileName] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  const [startDate, setStartDate] = useState<string>(todayISO());
  const [durationMode, setDurationMode] = useState<"wall" | "billable">("wall");
  const [workingDays, setWorkingDays] = useState<boolean>(false);
  const [pxPerDay, setPxPerDay] = useState<number>(20);
  const [showDeps, setShowDeps] = useState<boolean>(true);
  const [timeAxisMode, setTimeAxisMode] = useState<"dayCount" | "calendar">("dayCount");

  const [planId, setPlanId] = useState<string>("");
  const [layout, setLayout] = useState<GanttLayout | null>(null);

  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");

  const canRun = useMemo(() => csvText.trim().length > 0 && startDate.trim().length > 0, [csvText, startDate]);

  async function handleFile(file: File) {
    setErr("");
    setMsg("");
    setLayout(null);
    setPlanId("");
    setFileName(file.name);
    const text = await file.text();
    setCsvText(text);
  }

  async function run() {
    if (!canRun) return;
    setBusy(true);
    setErr("");
    setMsg("");

    try {
      const created = await createPlan(csvText);
      setPlanId(created.plan_id);

      const scheduled = await schedulePlan({
        planId: created.plan_id,
        startDate,
        durationMode,
        workingDays,
      });

      setLayout(scheduled.layout);
      setMsg(`Scheduled ${created.task_count} tasks. Plan ID: ${created.plan_id}`);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>Gantt Frontend</div>
            <div className="small">API: <span className="mono">{apiBase}</span></div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div className="small" style={{ alignSelf: "center" }}>Upload CSV → Schedule → Render SVG</div>
            <button
              type="button"
              onClick={() => setControlsOpen(v => !v)}
              style={{
                background: "white",
                color: "#0f172a",
                border: "1px solid #cbd5e1",
              }}
            >
              {controlsOpen ? "Collapse" : "Expand"}
            </button>
          </div>
        </div>

        {controlsOpen ? (
          <>
            <div style={{ height: 12 }} />

            <div className="row">
              <div style={{ minWidth: 240, flex: "2 1 320px" }}>
                <div className="label">CSV file</div>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                  }}
                />
                <div className="small" style={{ marginTop: 6 }}>
                  {fileName ? <>Loaded: <span className="mono">{fileName}</span></> : "No file loaded yet."}
                </div>
              </div>

              <div style={{ minWidth: 170 }}>
                <div className="label">Project start date</div>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>

              <div style={{ minWidth: 170 }}>
                <div className="label">Duration mode</div>
                <select value={durationMode} onChange={(e) => setDurationMode(e.target.value as any)}>
                  <option value="wall">Wall (default)</option>
                  <option value="billable">Billable</option>
                </select>
              </div>

              <div style={{ minWidth: 160 }}>
                <div className="label">Working days</div>
                <select value={workingDays ? "yes" : "no"} onChange={(e) => setWorkingDays(e.target.value === "yes")}>
                  <option value="no">Calendar days</option>
                  <option value="yes">Mon–Fri</option>
                </select>
              </div>

              <div style={{ minWidth: 160 }}>
                <div className="label">Zoom (px/day)</div>
                <input
                  type="text"
                  value={pxPerDay}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isNaN(n)) setPxPerDay(Math.max(4, Math.min(80, n)));
                  }}
                />
                <div className="small">Try 10–30</div>
              </div>

              <div style={{ minWidth: 160 }}>
                <div className="label">Time axis</div>
                <select value={timeAxisMode} onChange={(e) => setTimeAxisMode(e.target.value as any)}>
                  <option value="dayCount">Days (0, 1, 2…)</option>
                  <option value="calendar">Calendar dates</option>
                </select>
              </div>

              <div style={{ minWidth: 160 }}>
                <div className="label">Dependencies</div>
                <select value={showDeps ? "yes" : "no"} onChange={(e) => setShowDeps(e.target.value === "yes")}>
                  <option value="yes">Show</option>
                  <option value="no">Hide</option>
                </select>
              </div>

              <div style={{ minWidth: 170, alignSelf: "end" }}>
                <button onClick={run} disabled={!canRun || busy}>{busy ? "Running…" : "Create + Schedule"}</button>
                <div className="small" style={{ marginTop: 6 }}>
                  {planId ? <>Plan: <span className="mono">{planId}</span></> : " "}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="small" style={{ marginTop: 10 }}>
            Controls collapsed.
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          {err ? <div className="error">{err}</div> : null}
          {msg ? <div className="success">{msg}</div> : null}
        </div>
      </div>

      <div className="card">
        {!layout ? (
          <div className="small">No layout yet. Upload your CSV and click <b>Create + Schedule</b>.</div>
        ) : (
          <div className="ganttShell">
            <GanttChart layout={layout} pxPerDay={pxPerDay} rowHeight={28} showDeps={showDeps} timeAxisMode={timeAxisMode} />
          </div>
        )}
      </div>
    </div>
  );
}
