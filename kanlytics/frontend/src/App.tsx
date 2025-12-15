import React, { useEffect, useMemo, useRef, useState } from "react";
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastScheduleKeyRef = useRef<string>("");
  const toastTimerRef = useRef<number | null>(null);

  const [kanlyticsOpen, setKanlyticsOpen] = useState<boolean>(true);
  const [sourceOpen, setSourceOpen] = useState<boolean>(true);
  const [ganttSettingsOpen, setGanttSettingsOpen] = useState<boolean>(true);
  const [viewOptionsOpen, setViewOptionsOpen] = useState<boolean>(true);
  const [fileName, setFileName] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  const [startDate, setStartDate] = useState<string>(todayISO());
  const [durationMode, setDurationMode] = useState<"wall" | "billable">("wall");
  const [workingDays, setWorkingDays] = useState<boolean>(false);
  const [pxPerDay, setPxPerDay] = useState<number>(40);
  const [showDeps, setShowDeps] = useState<boolean>(true);
  const [showDailyGrid, setShowDailyGrid] = useState<boolean>(false);
  const [timeAxisMode, setTimeAxisMode] = useState<"dayCount" | "calendar">("dayCount");
  const [phaseLayout, setPhaseLayout] = useState<"linear" | "stacked">("stacked");

  const [planId, setPlanId] = useState<string>("");
  const [layout, setLayout] = useState<GanttLayout | null>(null);

  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");

  const hasCsv = useMemo(() => csvText.trim().length > 0, [csvText]);

  function showToast(kind: "success" | "error", text: string) {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    if (kind === "success") {
      setErr("");
      setMsg(text);
    } else {
      setMsg("");
      setErr(text);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setMsg("");
      setErr("");
      toastTimerRef.current = null;
    }, 3000);
  }

  async function handleFile(file: File) {
    setErr("");
    setMsg("");
    setLayout(null);
    setPlanId("");
    setFileName(file.name);
    const text = await file.text();
    setCsvText(text);
  }

  function saveCsv() {
    if (!hasCsv) {
      showToast("error", "No CSV loaded.");
      return;
    }
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = (fileName || "kanlytics").replace(/\.csv$/i, "");
    a.href = url;
    a.download = `${base}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("success", "CSV saved.");
  }

  async function createAndSchedule() {
    if (!hasCsv || !startDate.trim()) return;
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
      showToast("success", `Scheduled ${created.task_count} tasks.`);

      // Prevent an immediate duplicate re-schedule when the effects run.
      lastScheduleKeyRef.current = JSON.stringify({
        planId: created.plan_id,
        startDate,
        durationMode,
        workingDays,
      });
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rescheduleExisting() {
    if (!planId || !startDate.trim()) return;
    const key = JSON.stringify({ planId, startDate, durationMode, workingDays });
    if (key === lastScheduleKeyRef.current) return;
    lastScheduleKeyRef.current = key;

    setBusy(true);
    try {
      const scheduled = await schedulePlan({
        planId,
        startDate,
        durationMode,
        workingDays,
      });
      setLayout(scheduled.layout);
    } catch (e: any) {
      // Keep reschedule failures visible but ephemeral.
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  // Auto-run on upload (csvText changes from empty -> non-empty)
  useEffect(() => {
    if (!hasCsv) return;
    // Create a fresh plan whenever the CSV changes.
    void createAndSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCsv, csvText]);

  // Auto re-schedule when schedule parameters change (no re-upload)
  useEffect(() => {
    if (!planId) return;
    void rescheduleExisting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, startDate, durationMode, workingDays]);

  return (
    <div className="container">
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <button
              type="button"
              onClick={() => setKanlyticsOpen(v => !v)}
              aria-expanded={kanlyticsOpen}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: 0,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 20,
                fontWeight: 700,
                color: "#0f172a",
              }}
              title={kanlyticsOpen ? "Collapse panels" : "Expand panels"}
            >
              <span className="mono" aria-hidden="true" style={{ fontSize: 18 }}>
                {kanlyticsOpen ? "▾" : "▸"}
              </span>
              <span>Kanlytics</span>
            </button>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          </div>
        </div>

        <div style={{ height: 12 }} />

        {/* Panels (collapsible) */}
        {kanlyticsOpen ? (
          <>
            {/* Project Source panel */}
            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 12,
              }}
            >
              <button
                type="button"
                onClick={() => setSourceOpen(v => !v)}
                aria-expanded={sourceOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 700,
                  color: "#0f172a",
                  marginBottom: 10,
                }}
                title={sourceOpen ? "Collapse Source" : "Expand Source"}
              >
                <span className="mono" aria-hidden="true">
                  {sourceOpen ? "▾" : "▸"}
                </span>
                <span>Project Source</span>
              </button>

              {sourceOpen ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleFile(f);
                    }}
                  />
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      style={{ background: "white", color: "#0f172a", border: "1px solid #cbd5e1" }}
                    >
                      Load CSV
                    </button>
                    <button
                      type="button"
                      onClick={saveCsv}
                      disabled={!hasCsv}
                      style={{ background: "white", color: "#0f172a", border: "1px solid #cbd5e1" }}
                    >
                      Save CSV
                    </button>
                  </div>
                </>
              ) : null}
            </div>

            {/* Gantt Settings panel */}
            <div
              style={{
                marginTop: 12,
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 12,
              }}
            >
              <button
                type="button"
                onClick={() => setGanttSettingsOpen(v => !v)}
                aria-expanded={ganttSettingsOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 700,
                  color: "#0f172a",
                  marginBottom: 10,
                }}
                title={ganttSettingsOpen ? "Collapse Gantt Settings" : "Expand Gantt Settings"}
              >
                <span className="mono" aria-hidden="true">
                  {ganttSettingsOpen ? "▾" : "▸"}
                </span>
                <span>Gantt Settings</span>
              </button>

              {ganttSettingsOpen ? (
                <div className="row">
                  <div style={{ minWidth: 170 }}>
                    <div className="label">Project start date</div>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  </div>
                </div>
              ) : null}
            </div>

            {/* View Options panel */}
            <div
              style={{
                marginTop: 12,
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 12,
              }}
            >
              <button
                type="button"
                onClick={() => setViewOptionsOpen(v => !v)}
                aria-expanded={viewOptionsOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 700,
                  color: "#0f172a",
                  marginBottom: 10,
                }}
                title={viewOptionsOpen ? "Collapse View Options" : "Expand View Options"}
              >
                <span className="mono" aria-hidden="true">
                  {viewOptionsOpen ? "▾" : "▸"}
                </span>
                <span>View Options</span>
              </button>

              {viewOptionsOpen ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: 16,
                    alignItems: "end",
                  }}
                >
                  <div>
                    <div className="label">Duration mode</div>
                    <select value={durationMode} onChange={(e) => setDurationMode(e.target.value as any)}>
                      <option value="wall">Wall</option>
                      <option value="billable">Billable</option>
                    </select>
                  </div>

                  <div>
                    <div className="label">Working days</div>
                    <select value={workingDays ? "yes" : "no"} onChange={(e) => setWorkingDays(e.target.value === "yes")}>
                      <option value="no">Calendar days</option>
                      <option value="yes">Mon–Fri</option>
                    </select>
                  </div>

                  <div>
                    <div className="label">Zoom</div>
                    <select value={pxPerDay} onChange={(e) => setPxPerDay(Number(e.target.value))}>
                      {[10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80].map((v) => (
                        <option key={v} value={v}>
                          {v} px/day
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="label">Time axis</div>
                    <select value={timeAxisMode} onChange={(e) => setTimeAxisMode(e.target.value as any)}>
                      <option value="dayCount">Days</option>
                      <option value="calendar">Calendar dates</option>
                    </select>
                  </div>

                  <div>
                    <div className="label">Phase layout</div>
                    <select value={phaseLayout} onChange={(e) => setPhaseLayout(e.target.value as any)}>
                      <option value="stacked">Stacked</option>
                      <option value="linear">Linear</option>
                    </select>
                  </div>

                  <div>
                    <div className="label">Dependencies</div>
                    <select value={showDeps ? "yes" : "no"} onChange={(e) => setShowDeps(e.target.value === "yes")}>
                      <option value="yes">Show</option>
                      <option value="no">Hide</option>
                    </select>
                  </div>

                  <div>
                    <div className="label">Daily grid</div>
                    <select value={showDailyGrid ? "yes" : "no"} onChange={(e) => setShowDailyGrid(e.target.value === "yes")}>
                      <option value="no">Off</option>
                      <option value="yes">On</option>
                    </select>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        <div style={{ marginTop: 12 }}>
          {err ? <div className="error">{err}</div> : null}
          {msg ? <div className="success">{msg}</div> : null}
        </div>
      </div>

      <div className="card">
        {!layout ? (
          <div className="small">No layout yet. Set a source by loading a CSV in <b>Source</b>.</div>
        ) : (
          <div className="ganttShell">
            <GanttChart
              layout={layout}
              pxPerDay={pxPerDay}
              rowHeight={28}
              showDeps={showDeps}
              showDailyGrid={showDailyGrid}
              timeAxisMode={timeAxisMode}
              phaseLayout={phaseLayout}
            />
          </div>
        )}
      </div>
    </div>
  );
}
