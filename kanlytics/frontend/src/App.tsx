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
  const apiBase = import.meta.env.VITE_API_BASE || "http://localhost:8080";

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastScheduleKeyRef = useRef<string>("");
  const toastTimerRef = useRef<number | null>(null);

  const [advancedOpen, setAdvancedOpen] = useState<boolean>(true);
  const [debugOpen, setDebugOpen] = useState<boolean>(false);
  const [fileName, setFileName] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  const [startDate, setStartDate] = useState<string>(todayISO());
  const [durationMode, setDurationMode] = useState<"wall" | "billable">("wall");
  const [workingDays, setWorkingDays] = useState<boolean>(false);
  const [pxPerDay, setPxPerDay] = useState<number>(40);
  const [showDeps, setShowDeps] = useState<boolean>(true);
  const [timeAxisMode, setTimeAxisMode] = useState<"dayCount" | "calendar">("dayCount");

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
              onClick={() => setAdvancedOpen(v => !v)}
              aria-expanded={advancedOpen}
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
              title={advancedOpen ? "Collapse options" : "Expand options"}
            >
              <span className="mono" aria-hidden="true" style={{ fontSize: 18 }}>
                {advancedOpen ? "▾" : "▸"}
              </span>
              <span>Kanlytics</span>
            </button>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setDebugOpen(v => !v)}
              style={{ background: "white", color: "#0f172a", border: "1px solid #cbd5e1" }}
            >
              {debugOpen ? "Hide debug" : "Debug"}
            </button>
          </div>
        </div>

        {debugOpen ? (
          <>
            <div style={{ height: 10 }} />
            <div
              style={{
                border: "1px dashed #cbd5e1",
                borderRadius: 12,
                padding: 12,
                background: "#f8fafc",
              }}
            >
              <div className="label">Debug</div>
              <div className="small">
                API base: <span className="mono">{apiBase}</span><br />
                Loaded CSV: <span className="mono">{fileName || "(none)"}</span><br />
                Plan: <span className="mono">{planId || "(none)"}</span><br />
                CSV chars: <span className="mono">{String(csvText.length)}</span>
              </div>
            </div>
          </>
        ) : null}

        <div style={{ height: 12 }} />

        {/* Always-visible essentials */}
        <div className="row">
          <div style={{ minWidth: 240, flex: "2 1 320px" }}>
            <div className="label">CSV</div>
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
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{ background: "white", color: "#0f172a", border: "1px solid #cbd5e1" }}
              >
                Upload CSV
              </button>
            </div>
          </div>

          <div style={{ minWidth: 170 }}>
            <div className="label">Project start date</div>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>

          <div style={{ minWidth: 170, alignSelf: "end" }} />
        </div>

        {/* Collapsible advanced options */}
        {advancedOpen ? (
          <>
            <div style={{ height: 12 }} />
            <div className="row">
              <div style={{ minWidth: 170 }}>
                <div className="label">Duration mode</div>
                <select value={durationMode} onChange={(e) => setDurationMode(e.target.value as any)}>
                  <option value="wall">Wall</option>
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

              <div style={{ minWidth: 220 }}>
                <div className="label">Zoom ({pxPerDay}px/day)</div>
                <input
                  type="range"
                  min={4}
                  max={80}
                  value={pxPerDay}
                  onChange={(e) => setPxPerDay(Number(e.target.value))}
                />
              </div>

              <div style={{ minWidth: 200 }}>
                <div className="label">Time axis</div>
                <select value={timeAxisMode} onChange={(e) => setTimeAxisMode(e.target.value as any)}>
                  <option value="dayCount">Days</option>
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
