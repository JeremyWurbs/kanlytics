import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPlan, schedulePlan, connectProject, exportProject, fetchJobStatus, startConnectProject, startExportProject } from "./api";
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

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("kanlytics.theme") === "dark";
    } catch {
      return false;
    }
  });

  const [kanlyticsOpen, setKanlyticsOpen] = useState<boolean>(true);
  const [dataOpen, setDataOpen] = useState<boolean>(true);
  const [ganttSettingsOpen, setGanttSettingsOpen] = useState<boolean>(true);
  const [viewOptionsOpen, setViewOptionsOpen] = useState<boolean>(true);
  const [fileName, setFileName] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  const [projectName, setProjectName] = useState<string>(() => {
    try {
      return window.localStorage.getItem("kanlytics.projectName") || "";
    } catch {
      return "";
    }
  });
  const [startDate, setStartDate] = useState<string>(todayISO());
  const [durationMode, setDurationMode] = useState<"wall" | "billable">("wall");
  const [workingDays, setWorkingDays] = useState<boolean>(false);
  const [pxPerDay, setPxPerDay] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem("kanlytics.view.pxPerDay");
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : 40;
    } catch {
      return 40;
    }
  });
  const [showDeps, setShowDeps] = useState<boolean>(true);
  const [showDailyGrid, setShowDailyGrid] = useState<boolean>(false);
  const [showCriticalPath, setShowCriticalPath] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem("kanlytics.view.showCriticalPath");
      if (raw === "0") return false;
      if (raw === "1") return true;
      return true; // default on
    } catch {
      return true;
    }
  });
  const [detailMode, setDetailMode] = useState<"all" | "phaseSummary">(() => {
    try {
      const raw = window.localStorage.getItem("kanlytics.view.detailMode");
      return raw === "phaseSummary" ? "phaseSummary" : "all";
    } catch {
      return "all";
    }
  });
  const [timeAxisMode, setTimeAxisMode] = useState<
    "dayCount" | "weeks" | "months" | "calendarDays" | "calendarWeeks" | "calendarMonths"
  >("dayCount");
  const [phaseLayout, setPhaseLayout] = useState<"linear" | "stacked">("stacked");
  const [barPadPx, setBarPadPx] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem("kanlytics.view.barPadPx");
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : 4;
    } catch {
      return 4;
    }
  });

  const [planId, setPlanId] = useState<string>("");
  const [layout, setLayout] = useState<GanttLayout | null>(null);

  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");

  const [githubModalOpen, setGithubModalOpen] = useState<boolean>(false);
  const [githubModalMode, setGithubModalMode] = useState<"connect" | "export">("connect");
  const [projectUrl, setProjectUrl] = useState<string>(() => {
    try {
      return window.localStorage.getItem("kanlytics.github.projectUrl") || "";
    } catch {
      return "";
    }
  });
  const [issueRepo, setIssueRepo] = useState<string>(() => {
    try {
      return window.localStorage.getItem("kanlytics.github.issueRepo") || "";
    } catch {
      return "";
    }
  });
  const [githubJobId, setGithubJobId] = useState<string>("");
  const [githubJobProgress, setGithubJobProgress] = useState<number>(0);
  const [githubJobMessage, setGithubJobMessage] = useState<string>("");
  const [githubJobState, setGithubJobState] = useState<"queued" | "running" | "completed" | "failed" | "">("");

  const hasCsv = useMemo(() => csvText.trim().length > 0, [csvText]);

  const secondaryButtonStyle: React.CSSProperties = useMemo(
    () => ({
      background: "var(--card)",
      color: "var(--text)",
      border: "1px solid var(--border-2)",
    }),
    []
  );

  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = darkMode ? "dark" : "light";
    try {
      window.localStorage.setItem("kanlytics.theme", darkMode ? "dark" : "light");
    } catch {
      // ignore
    }
  }, [darkMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem("kanlytics.view.pxPerDay", String(pxPerDay));
    } catch {
      // ignore
    }
  }, [pxPerDay]);

  useEffect(() => {
    try {
      window.localStorage.setItem("kanlytics.view.barPadPx", String(barPadPx));
    } catch {
      // ignore
    }
  }, [barPadPx]);

  useEffect(() => {
    try {
      window.localStorage.setItem("kanlytics.view.showCriticalPath", showCriticalPath ? "1" : "0");
    } catch {
      // ignore
    }
  }, [showCriticalPath]);

  useEffect(() => {
    try {
      window.localStorage.setItem("kanlytics.view.detailMode", detailMode);
    } catch {
      // ignore
    }
  }, [detailMode]);

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
    // Success toasts auto-dismiss; error toasts persist until manually closed.
    if (kind === "success") {
      toastTimerRef.current = window.setTimeout(() => {
        setMsg("");
        toastTimerRef.current = null;
      }, 3000);
    }
  }

  function openGithubModal(mode: "connect" | "export") {
    setGithubModalMode(mode);
    setGithubModalOpen(true);
  }

  function closeGithubModal() {
    setGithubModalOpen(false);
  }

  function resetGithubProgress() {
    setGithubJobId("");
    setGithubJobProgress(0);
    setGithubJobMessage("");
    setGithubJobState("");
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

  async function runGithubConnect() {
    const url = projectUrl.trim();
    if (!url) {
      showToast("error", "Please paste a GitHub Project URL.");
      return;
    }
    try {
      window.localStorage.setItem("kanlytics.github.projectUrl", url);
    } catch {
      // ignore
    }

    setBusy(true);
    setErr("");
    setMsg("");
    resetGithubProgress();
    try {
      setGithubJobMessage("Starting import…");
      const started = await startConnectProject(url);
      setGithubJobId(started.job_id);
    } catch (e: any) {
      showToast("error", e?.message || String(e));
      resetGithubProgress();
    } finally {
      setBusy(false);
    }
  }

  async function runGithubExport() {
    const url = projectUrl.trim();
    if (!url) {
      showToast("error", "Please paste a GitHub Project URL.");
      return;
    }
    if (!planId) {
      showToast("error", "No plan loaded. Load CSV or Connect first.");
      return;
    }
    try {
      window.localStorage.setItem("kanlytics.github.projectUrl", url);
    } catch {
      // ignore
    }
    try {
      window.localStorage.setItem("kanlytics.github.issueRepo", issueRepo.trim());
    } catch {
      // ignore
    }
    try {
      window.localStorage.setItem("kanlytics.projectName", projectName.trim());
    } catch {
      // ignore
    }

    setBusy(true);
    setErr("");
    setMsg("");
    resetGithubProgress();
    try {
      setGithubJobMessage("Starting export…");
      const started = await startExportProject({
        planId,
        projectUrl: url,
        issueRepo: issueRepo.trim() || undefined,
        projectName: projectName.trim() || undefined,
      });
      setGithubJobId(started.job_id);
    } catch (e: any) {
      showToast("error", e?.message || String(e));
      resetGithubProgress();
    } finally {
      setBusy(false);
    }
  }

  // Poll backend job status while Connect/Export is running, to drive progress UI.
  useEffect(() => {
    if (!githubJobId) return;

    let stopped = false;
    const tick = async () => {
      try {
        const st = await fetchJobStatus(githubJobId);
        if (stopped) return;

        setGithubJobState(st.state);
        setGithubJobProgress(st.progress ?? 0);
        setGithubJobMessage(st.message || "");

        if (st.state === "completed") {
          const mode = githubModalMode;
          const result = st.result || {};

          if (mode === "connect") {
            const csv = String((result as any).csv_text || "");
            const count = Number((result as any).task_count || 0);
            const projectStart = String((result as any).project_start_date || "").trim();
            closeGithubModal();
            setLayout(null);
            setPlanId("");
            setFileName("github-project.csv");
            if (projectStart) setStartDate(projectStart);
            if (csv.trim()) setCsvText(csv);
            showToast("success", `Connected. Imported ${count} items.`);
          } else {
            closeGithubModal();
            const updatedIssues = Number((result as any).updated_issues || 0);
            const updatedDrafts = Number((result as any).updated_draft_issues || 0);
            const createdDrafts = Number((result as any).created_draft_issues || 0);
            const addedIssues = Number((result as any).added_existing_issues || 0);
            const errors: string[] = Array.isArray((result as any).errors) ? (result as any).errors : [];

            const summary = `Exported. Updated issues=${updatedIssues}, updated drafts=${updatedDrafts}, created drafts=${createdDrafts}, added issues=${addedIssues}.`;
            if (errors.length) {
              showToast("error", `${summary} Errors: ${errors.slice(0, 2).join(" | ")}${errors.length > 2 ? " …" : ""}`);
            } else {
              showToast("success", summary);
            }
          }

          resetGithubProgress();
          return;
        }

        if (st.state === "failed") {
          const msg = st.error || "Export/import failed.";
          showToast("error", msg);
          resetGithubProgress();
          return;
        }
      } catch (e: any) {
        if (stopped) return;
        showToast("error", e?.message || String(e));
        resetGithubProgress();
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), 500);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubJobId]);

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
      const created = await createPlan(csvText, projectName.trim() || undefined);
      setPlanId(created.plan_id);
      // Replace template CSV with normalized/instantiated CSV (UUID Task IDs + remapped deps).
      if (created.normalized_csv_text && created.normalized_csv_text.trim().length > 0) {
        setCsvText(created.normalized_csv_text);
      }

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
                color: "var(--text)",
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

        {kanlyticsOpen ? <div style={{ height: 12 }} /> : null}

        {/* Panels (collapsible) */}
        {kanlyticsOpen ? (
          <>
            {/* Data panel */}
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 14,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <button
                type="button"
                onClick={() => setDataOpen((v) => !v)}
                aria-expanded={dataOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 700,
                  color: "var(--text)",
                  marginBottom: dataOpen ? 10 : 0,
                }}
                title={dataOpen ? "Collapse Data" : "Expand Data"}
              >
                <span className="mono" aria-hidden="true">
                  {dataOpen ? "▾" : "▸"}
                </span>
                <span>Data</span>
              </button>

              {dataOpen ? (
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

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                      gap: 16,
                      alignItems: "start",
                    }}
                  >
                    <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}>
                      <div style={{ fontWeight: 700, marginBottom: 10, color: "var(--text)" }}>CSV</div>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} style={secondaryButtonStyle}>
                          Import CSV
                        </button>
                        <button type="button" onClick={saveCsv} disabled={busy || !hasCsv} style={secondaryButtonStyle}>
                          Export CSV
                        </button>
                      </div>
                    </div>

                    <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}>
                      <div style={{ fontWeight: 700, marginBottom: 10, color: "var(--text)" }}>GitHub</div>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => openGithubModal("connect")} disabled={busy} style={secondaryButtonStyle}>
                          Pull
                        </button>
                        <button type="button" onClick={() => openGithubModal("export")} disabled={busy || !planId} style={secondaryButtonStyle}>
                          Push
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              ) : null}
            </div>

            {/* Project Settings panel */}
            <div
              style={{
                marginTop: 12,
                border: "1px solid var(--border)",
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
                  color: "var(--text)",
                  marginBottom: ganttSettingsOpen ? 10 : 0,
                }}
                title={ganttSettingsOpen ? "Collapse Gantt Settings" : "Expand Gantt Settings"}
              >
                <span className="mono" aria-hidden="true">
                  {ganttSettingsOpen ? "▾" : "▸"}
                </span>
                <span>Project Settings</span>
              </button>

              {ganttSettingsOpen ? (
                <div className="row">
                  <div style={{ minWidth: 260 }}>
                    <div className="label">Project name</div>
                    <input
                      value={projectName}
                      onChange={(e) => {
                        const v = e.target.value;
                        setProjectName(v);
                        try {
                          window.localStorage.setItem("kanlytics.projectName", v);
                        } catch {
                          // ignore
                        }
                      }}
                      placeholder="e.g. Client – Plant – Station"
                    />
                  </div>
                  <div style={{ minWidth: 170 }}>
                    <div className="label">Project start date</div>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  </div>
                  <div style={{ minWidth: 200 }}>
                    <div className="label">Working days</div>
                    <select value={workingDays ? "yes" : "no"} onChange={(e) => setWorkingDays(e.target.value === "yes")}>
                      <option value="no">Calendar days</option>
                      <option value="yes">Mon–Fri</option>
                    </select>
                  </div>
                </div>
              ) : null}
            </div>

            {/* View Options panel */}
            <div
              style={{
                marginTop: 12,
                border: "1px solid var(--border)",
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
                  color: "var(--text)",
                  marginBottom: viewOptionsOpen ? 10 : 0,
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
                    <div className="label">Zoom</div>
                    <select value={pxPerDay} onChange={(e) => setPxPerDay(Number(e.target.value))}>
                      {[10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80].map((v) => (
                        <option key={v} value={v}>
                          {v} px/
                          {timeAxisMode === "weeks" || timeAxisMode === "calendarWeeks"
                            ? "week"
                            : timeAxisMode === "calendarMonths" || timeAxisMode === "months"
                              ? "month"
                              : "day"}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="label">Task bar padding</div>
                    <select value={barPadPx} onChange={(e) => setBarPadPx(Number(e.target.value))}>
                      {[0, 1, 2, 3, 4, 6, 8, 10, 12].map((v) => (
                        <option key={v} value={v}>
                          {v}px
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="label">Detail</div>
                    <select value={detailMode} onChange={(e) => setDetailMode(e.target.value as any)}>
                      <option value="all">All tasks</option>
                      <option value="phaseSummary">Phase summary</option>
                    </select>
                  </div>

                  <div>
                    <div className="label">Time axis</div>
                    <select value={timeAxisMode} onChange={(e) => setTimeAxisMode(e.target.value as any)}>
                      <option value="dayCount">Days</option>
                      <option value="weeks">Weeks</option>
                      <option value="months">Months</option>
                      <option value="calendarDays">Calendar days</option>
                      <option value="calendarWeeks">Calendar weeks</option>
                      <option value="calendarMonths">Calendar months</option>
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

                  <div>
                    <div className="label">Critical path</div>
                    <select value={showCriticalPath ? "yes" : "no"} onChange={(e) => setShowCriticalPath(e.target.value === "yes")}>
                      <option value="yes">Highlight</option>
                      <option value="no">Off</option>
                    </select>
                  </div>

                  <div>
                    <div className="label">Dark mode</div>
                    <select value={darkMode ? "on" : "off"} onChange={(e) => setDarkMode(e.target.value === "on")}>
                      <option value="off">Off</option>
                      <option value="on">On</option>
                    </select>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {err || msg ? (
          <div style={{ marginTop: 12 }}>
            {err ? (
              <div className="error" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
                <div style={{ minWidth: 0, whiteSpace: "pre-wrap" }}>{err}</div>
                <button
                  type="button"
                  onClick={() => setErr("")}
                  aria-label="Dismiss error"
                  title="Dismiss"
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--border-2)",
                    background: "var(--card)",
                    color: "var(--text)",
                    lineHeight: 1,
                    flex: "0 0 auto",
                  }}
                >
                  ✕
                </button>
              </div>
            ) : null}
            {msg ? (
              <div className="success" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
                <div style={{ minWidth: 0, whiteSpace: "pre-wrap" }}>{msg}</div>
                <button
                  type="button"
                  onClick={() => setMsg("")}
                  aria-label="Dismiss message"
                  title="Dismiss"
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--border-2)",
                    background: "var(--card)",
                    color: "var(--text)",
                    lineHeight: 1,
                    flex: "0 0 auto",
                  }}
                >
                  ✕
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {githubModalOpen ? (
        <div
          className="modalBackdrop"
          role="dialog"
          aria-modal="true"
          aria-label={githubModalMode === "connect" ? "Connect to GitHub Project" : "Export to GitHub Project"}
          onClick={() => {
            // Don't allow backdrop-close while a job is running (prevents confusion).
            if (githubJobId) return;
            closeGithubModal();
          }}
        >
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {githubJobId ? <span className="spinner" aria-hidden="true" /> : null}
                <span>{githubModalMode === "connect" ? "Connect to GitHub Project" : "Export to GitHub Project"}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (githubJobId) return;
                  closeGithubModal();
                }}
                style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                aria-label="Close"
                disabled={Boolean(githubJobId)}
              >
                ✕
              </button>
            </div>

            <div className="label">Project Board URL</div>
            <input
              value={projectUrl}
              onChange={(e) => setProjectUrl(e.target.value)}
              placeholder="https://github.com/orgs/<org>/projects/<number>"
              disabled={Boolean(githubJobId)}
            />

            {githubModalMode === "export" ? (
              <div style={{ marginTop: 12 }}>
                <div className="label">Issue repo (optional)</div>
                <input
                  value={issueRepo}
                  onChange={(e) => setIssueRepo(e.target.value)}
                  placeholder="owner/repo or https://github.com/owner/repo"
                  disabled={Boolean(githubJobId)}
                />
                <div className="small" style={{ marginTop: 6 }}>
                  If provided, tasks without a GitHub issue URL will be created as real issues in this repo (instead of Draft Issues).
                </div>
              </div>
            ) : null}
            <div className="small" style={{ marginTop: 8 }}>
              {githubModalMode === "connect"
                ? "Connect will download the project items (issues + drafts), ensure each has a Task ID, and load them into Kanlytics."
                : "Export will update matching issues/drafts by Task ID, and create drafts for tasks without an issue URL."}
            </div>

            {githubJobId ? (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <div className="small">{githubJobMessage || "Working…"}</div>
                  <div className="mono small">{githubJobProgress}%</div>
                </div>
                <div className="progressTrack" style={{ marginTop: 8 }}>
                  <div className="progressFill" style={{ width: `${Math.max(0, Math.min(100, githubJobProgress))}%` }} />
                </div>
              </div>
            ) : null}

            <div className="modalActions">
              <button
                type="button"
                onClick={() => {
                  if (githubJobId) return;
                  closeGithubModal();
                }}
                style={secondaryButtonStyle}
                disabled={Boolean(githubJobId)}
              >
                Cancel
              </button>
              {githubModalMode === "connect" ? (
                <button type="button" onClick={() => void runGithubConnect()} disabled={busy || Boolean(githubJobId)} style={secondaryButtonStyle}>
                  Connect
                </button>
              ) : (
                <button type="button" onClick={() => void runGithubExport()} disabled={busy || !planId || Boolean(githubJobId)} style={secondaryButtonStyle}>
                  Export
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="card">
        {!layout ? (
          <div className="small">
            No project loaded yet. Use <b>Data</b> to import a CSV project or pull from GitHub to see the project view.
          </div>
        ) : (
          <div className="ganttShell">
            <GanttChart
              layout={layout}
              pxPerDay={pxPerDay}
              rowHeight={28}
              showDeps={showDeps}
              showDailyGrid={showDailyGrid}
              showCriticalPath={showCriticalPath}
              timeAxisMode={timeAxisMode}
              phaseLayout={phaseLayout}
              barPadPx={barPadPx}
              projectName={projectName}
              detailMode={detailMode}
            />
          </div>
        )}
      </div>
    </div>
  );
}
