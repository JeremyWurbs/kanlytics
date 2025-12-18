import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPlan, schedulePlan, fetchJobStatus, startConnectProject, startExportProject, loadCsvFromPath, saveCsvToPath } from "./api";
import type { GanttLayout } from "./types";
import { GanttChart } from "./components/GanttChart";
import "./styles.css";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function newProjectId(): string {
  try {
    // Modern browsers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyCrypto: any = (globalThis as any).crypto;
    if (anyCrypto?.randomUUID) return anyCrypto.randomUUID();
  } catch {
    // ignore
  }
  return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

type ProjectRecord = {
  id: string;
  name: string;
  startDate: string;
  workingDays: boolean;
  csvText: string;
  fileName?: string;
  projectUrl?: string;
  issueRepo?: string;
};

export default function App() {
  const loadFileInputRef = useRef<HTMLInputElement | null>(null);
  const lastScheduleKeyRef = useRef<string>("");
  const toastTimerRef = useRef<number | null>(null);

  // Sidebar should default to expanded on first load (and on refresh).
  // We intentionally do not persist this preference so the user always lands
  // with navigation visible when first visiting the app URL.
  const [navCollapsed, setNavCollapsed] = useState<boolean>(false);
  const [activePage, setActivePage] = useState<"editProject" | "viewProjects">(() => {
    try {
      const v = window.localStorage.getItem("kanlytics.nav.activePage");
      return v === "editProject" ? "editProject" : "viewProjects";
    } catch {
      return "viewProjects";
    }
  });
  const [projects, setProjects] = useState<ProjectRecord[]>(() => {
    try {
      const raw = window.localStorage.getItem("kanlytics.projects.v1");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as ProjectRecord[]) : [];
    } catch {
      return [];
    }
  });
  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    try {
      return window.localStorage.getItem("kanlytics.project.activeId") || "";
    } catch {
      return "";
    }
  });
  const [selectProjectOpen, setSelectProjectOpen] = useState<boolean>(false);
  const [selectProjectQuery, setSelectProjectQuery] = useState<string>("");
  const [selectProjectId, setSelectProjectId] = useState<string>("");
  const [loadProjectOpen, setLoadProjectOpen] = useState<boolean>(false);
  const [importProjectValue, setImportProjectValue] = useState<string>("");
  const [newProjectOpen, setNewProjectOpen] = useState<boolean>(false);
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [newProjectStartDate, setNewProjectStartDate] = useState<string>(todayISO());
  const [newProjectWorkingDays, setNewProjectWorkingDays] = useState<boolean>(false);
  const [githubAutoConnect, setGithubAutoConnect] = useState<boolean>(false);
  const [githubAutoExport, setGithubAutoExport] = useState<boolean>(false);
  const [githubAutoExportPlanId, setGithubAutoExportPlanId] = useState<string>("");

  const [exportProjectOpen, setExportProjectOpen] = useState<boolean>(false);
  const [exportProjectQuery, setExportProjectQuery] = useState<string>("");
  const [exportProjectId, setExportProjectId] = useState<string>("");
  const [exportTarget, setExportTarget] = useState<string>("");

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("kanlytics.theme") === "dark";
    } catch {
      return false;
    }
  });

  const [kanlyticsOpen, setKanlyticsOpen] = useState<boolean>(true);
  const [viewOptionsModalOpen, setViewOptionsModalOpen] = useState<boolean>(false);
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
      window.localStorage.setItem("kanlytics.nav.activePage", activePage);
    } catch {
      // ignore
    }
  }, [activePage]);

  // Persist projects + active project selection.
  useEffect(() => {
    try {
      window.localStorage.setItem("kanlytics.projects.v1", JSON.stringify(projects));
    } catch {
      // ignore
    }
  }, [projects]);
  useEffect(() => {
    try {
      window.localStorage.setItem("kanlytics.project.activeId", activeProjectId);
    } catch {
      // ignore
    }
  }, [activeProjectId]);

  // Rehydrate the active project into UI state on load.
  // This avoids showing stale header/settings (from older single-project caching)
  // when no CSV/layout is actually loaded into the editor.
  useEffect(() => {
    if (!activeProjectId) {
      // No project selected: clear editor state so header + chart match.
      setProjectName("");
      setFileName("");
      setCsvText("");
      setLayout(null);
      setPlanId("");
      return;
    }

    const p = projects.find((x) => x.id === activeProjectId);
    if (!p) {
      // Active pointer is stale; clear it.
      setActiveProjectId("");
      setProjectName("");
      setFileName("");
      setCsvText("");
      setLayout(null);
      setPlanId("");
      return;
    }

    // Hydrate project settings + content.
    setProjectName(p.name || "");
    setStartDate((p.startDate || todayISO()).trim());
    setWorkingDays(Boolean(p.workingDays));
    setProjectUrl(p.projectUrl || "");
    setIssueRepo(p.issueRepo || "");
    setFileName(p.fileName || "");
    setCsvText(p.csvText || "");
    setLayout(null);
    setPlanId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const activeProject = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId) || null;
  }, [projects, activeProjectId]);

  const filteredProjects = useMemo(() => {
    const q = selectProjectQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => (p.name || "").toLowerCase().includes(q));
  }, [projects, selectProjectQuery]);

  const filteredExportProjects = useMemo(() => {
    const q = exportProjectQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => (p.name || "").toLowerCase().includes(q));
  }, [projects, exportProjectQuery]);

  function openSelectProjectModal() {
    setSelectProjectQuery("");
    const first = projects[0]?.id || "";
    setSelectProjectId(activeProjectId || first);
    setSelectProjectOpen(true);
  }

  function openExportProjectModal() {
    setExportProjectQuery("");
    const first = projects[0]?.id || "";
    setExportProjectId(activeProjectId || first);
    setExportTarget("");
    setExportProjectOpen(true);
  }

  function loadProjectById(pid: string) {
    const p = projects.find((x) => x.id === pid);
    if (!p) return;
    setActiveProjectId(p.id);
    setProjectName(p.name || "");
    setStartDate((p.startDate || todayISO()).trim());
    setWorkingDays(Boolean(p.workingDays));
    setProjectUrl(p.projectUrl || "");
    setIssueRepo(p.issueRepo || "");
    setFileName(p.fileName || "");
    setLayout(null);
    setPlanId("");
    setCsvText(p.csvText || "");
    setActivePage("editProject");
  }

  function ensureActiveProject(): ProjectRecord {
    if (activeProjectId) {
      const existing = projects.find((p) => p.id === activeProjectId);
      if (existing) return existing;
    }
    const id = newProjectId();
    const name = projectName.trim() || fileName.trim() || "Untitled Project";
    const p: ProjectRecord = {
      id,
      name,
      startDate: startDate.trim() || todayISO(),
      workingDays: Boolean(workingDays),
      csvText: csvText || "",
      fileName: fileName || "",
      projectUrl: projectUrl || "",
      issueRepo: issueRepo || "",
    };
    setProjects((prev) => [p, ...prev]);
    setActiveProjectId(id);
    return p;
  }

  // Keep the active project record in sync with edits (name/settings/csv).
  useEffect(() => {
    if (!activeProjectId) return;
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== activeProjectId) return p;
        return {
          ...p,
          name: projectName,
          startDate,
          workingDays,
          csvText,
          fileName,
          projectUrl,
          issueRepo,
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, projectName, startDate, workingDays, csvText, fileName, projectUrl, issueRepo]);

  function openLoadProjectModal() {
    // Default to the last GitHub URL (lets you paste/replace quickly).
    setImportProjectValue(projectUrl);
    setLoadProjectOpen(true);
  }

  function openNewProjectModal() {
    setNewProjectName(projectName);
    setNewProjectStartDate(startDate);
    setNewProjectWorkingDays(workingDays);
    setNewProjectOpen(true);
  }

  function createNewProject() {
    const pn = newProjectName.trim() || "Untitled Project";
    const id = newProjectId();
    const p: ProjectRecord = {
      id,
      name: pn,
      startDate: (newProjectStartDate || todayISO()).trim(),
      workingDays: Boolean(newProjectWorkingDays),
      csvText: "",
      fileName: "",
      projectUrl: "",
      issueRepo: "",
    };

    setProjects((prev) => [p, ...prev]);
    setActiveProjectId(id);

    setProjectName(p.name);
    setStartDate(p.startDate);
    setWorkingDays(p.workingDays);
    setProjectUrl("");
    setIssueRepo("");
    setFileName("");
    setLayout(null);
    setPlanId("");
    setCsvText("");

    setNewProjectOpen(false);
    setActivePage("editProject");
    showToast("success", "Project created. Import a CSV or GitHub URL to load tasks.");
  }

  function openGithubModal(mode: "connect" | "export") {
    setGithubModalMode(mode);
    setGithubModalOpen(true);
  }

  function closeGithubModal() {
    setGithubModalOpen(false);
    setGithubAutoConnect(false);
    setGithubAutoExport(false);
    setGithubAutoExportPlanId("");
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
    // Ensure we have a project to associate this import with.
    ensureActiveProject();
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

  // If Import Project launches the GitHub connect modal, auto-start the download (no second click).
  useEffect(() => {
    if (!githubModalOpen) return;
    if (githubModalMode !== "connect") return;
    if (!githubAutoConnect) return;
    if (githubJobId) return;
    setGithubAutoConnect(false);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    runGithubConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubModalOpen, githubModalMode, githubAutoConnect, githubJobId]);

  // If Export Project launches the GitHub export modal, auto-start the upload (no second click).
  useEffect(() => {
    if (!githubModalOpen) return;
    if (githubModalMode !== "export") return;
    if (!githubAutoExport) return;
    if (githubJobId) return;
    setGithubAutoExport(false);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    runGithubExport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubModalOpen, githubModalMode, githubAutoExport, githubJobId]);

  async function runImportProject() {
    const raw = importProjectValue.trim();
    if (!raw) {
      showToast("error", "Paste a CSV file path or a GitHub Project URL.");
      return;
    }

    // URL → GitHub connect flow (auto-start).
    if (/^https?:\/\//i.test(raw)) {
      setProjectUrl(raw);
      // Ensure we have a project to associate this import with.
      ensureActiveProject();
      setLoadProjectOpen(false);
      setGithubAutoConnect(true);
      openGithubModal("connect");
      return;
    }

    // Otherwise treat as a local CSV path (read by backend).
    try {
      setBusy(true);
      const res = await loadCsvFromPath(raw);
      setLoadProjectOpen(false);
      setActivePage("editProject");
      ensureActiveProject();
      setLayout(null);
      setPlanId("");
      const fn = (res.file_name || "").trim();
      if (fn) setFileName(fn);
      setCsvText(res.csv_text || "");
      showToast("success", "Imported CSV.");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
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
    const effectivePlanId = githubAutoExportPlanId || planId;
    if (!effectivePlanId) {
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
        planId: effectivePlanId,
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

  async function runExportSelectedProject() {
    const pid = exportProjectId;
    const target = exportTarget.trim();
    if (!pid) {
      showToast("error", "Select a project to export.");
      return;
    }
    if (!target) {
      showToast("error", "Enter an export destination (CSV path or GitHub Project URL).");
      return;
    }
    const p = projects.find((x) => x.id === pid);
    if (!p) {
      showToast("error", "Unknown project.");
      return;
    }
    if (!p.csvText.trim()) {
      showToast("error", "Selected project has no CSV loaded yet.");
      return;
    }

    try {
      setBusy(true);

      // Normalize the CSV (fills Task IDs / dependency UUIDs).
      const created = await createPlan(p.csvText, p.name);
      const normalized = created.normalized_csv_text || p.csvText;

      // Persist normalized CSV back into the project record (keeps Task IDs stable).
      setProjects((prev) => prev.map((x) => (x.id === pid ? { ...x, csvText: normalized } : x)));

      if (/^https?:\/\//i.test(target)) {
        // GitHub export requires schedule (Start/End Dates).
        await schedulePlan({
          planId: created.plan_id,
          startDate: (p.startDate || todayISO()).trim(),
          durationMode,
          workingDays: Boolean(p.workingDays),
        });

        setProjectUrl(target);
        setIssueRepo(p.issueRepo || "");
        setProjectName(p.name || "");
        setStartDate((p.startDate || todayISO()).trim());
        setWorkingDays(Boolean(p.workingDays));

        setGithubAutoExportPlanId(created.plan_id);
        setExportProjectOpen(false);
        setGithubAutoExport(true);
        setGithubModalMode("export");
        setGithubModalOpen(true);
        return;
      }

      // Local CSV export (writes on backend; intended for local dev).
      await saveCsvToPath(target, normalized);
      setExportProjectOpen(false);
      showToast("success", "Exported CSV.");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
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
    <div className="appShell">
      <aside className={`navSidebar ${navCollapsed ? "isCollapsed" : ""}`}>
        <div className="navTop">
          <button
            type="button"
            className="navIconBtn"
            onClick={() => setNavCollapsed((v) => !v)}
            aria-label={navCollapsed ? "Expand navigation" : "Collapse navigation"}
            title={navCollapsed ? "Expand navigation" : "Collapse navigation"}
          >
            ☰
          </button>
          {!navCollapsed ? <div className="navBrand">Kanlytics</div> : null}
        </div>

        <div className="navItems">
          <button
            type="button"
            className={`navItem ${activePage === "viewProjects" ? "isActive" : ""}`}
            onClick={() => setActivePage("viewProjects")}
            title="All Projects"
          >
            {!navCollapsed ? "All Projects" : "All"}
          </button>
          <button
            type="button"
            className="navItem"
            onClick={() => {
              openNewProjectModal();
            }}
            title="New Project"
          >
            {!navCollapsed ? "New Project" : "New"}
          </button>
          <button
            type="button"
            className={`navItem ${activePage === "editProject" ? "isActive" : ""}`}
            onClick={() => {
              setActivePage("editProject");
              if (!activeProjectId) openSelectProjectModal();
            }}
            title="Edit Project"
          >
            {!navCollapsed ? "Edit Project" : "Edit"}
          </button>
          <button
            type="button"
            className="navItem"
            onClick={() => {
              openLoadProjectModal();
            }}
            title="Import Project"
          >
            {!navCollapsed ? "Import Project" : "Import"}
          </button>
          <button
            type="button"
            className="navItem"
            onClick={() => {
              openExportProjectModal();
            }}
            title="Export Project"
          >
            {!navCollapsed ? "Export Project" : "Export"}
          </button>
        </div>

        <div className="navBottom">
          <button type="button" className="navItem" onClick={() => setViewOptionsModalOpen(true)} title="View Options">
            {!navCollapsed ? "View Options" : "Options"}
          </button>
        </div>
      </aside>

      <main className="appMain">
        {activePage === "editProject" ? (
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
              <span>{projectName.trim() ? projectName.trim() : "Edit Project"}</span>
            </button>
            <div className="small" style={{ marginTop: 6 }}>
              <span className="mono">{startDate || "—"}</span>
              <span style={{ margin: "0 8px" }}>•</span>
              <span>{workingDays ? "Working days (Mon–Fri)" : "Calendar days"}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          </div>
        </div>

        {kanlyticsOpen ? <div style={{ height: 12 }} /> : null}

        {/* Panels (collapsible) */}
        {kanlyticsOpen ? null : null}

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

            <div className="card">
              {!layout ? (
                <div className="small">
                  No project loaded yet. Use <b>Import Project</b> to load a CSV or pull from GitHub to see the project view.
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
        ) : (
          <div className="container">
            <div className="card">
              <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>All Projects</div>
              {projects.length === 0 ? (
                <div className="small">No projects yet. Use New Project or Import Project to get started.</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {projects.map((p) => {
                    const hasCsvLocal = Boolean((p.csvText || "").trim());
                    const subtitle = `${p.startDate || "—"} • ${p.workingDays ? "Mon–Fri" : "Calendar"} • ${hasCsvLocal ? "CSV loaded" : "No CSV"}`;
                    return (
                      <div
                        key={p.id}
                        style={{
                          display: "flex",
                          gap: 12,
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: 12,
                          border: "1px solid var(--border)",
                          borderRadius: 12,
                          background: "var(--card)",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 800, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {p.name || "(untitled)"}
                          </div>
                          <div className="small" style={{ marginTop: 4 }}>
                            {subtitle}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, flex: "0 0 auto" }}>
                          <button
                            type="button"
                            style={secondaryButtonStyle}
                            onClick={() => loadProjectById(p.id)}
                            title="Open in Edit Project"
                          >
                            Open
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Global modals (must render regardless of active page) */}
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
                  <button
                    type="button"
                    onClick={() => void runGithubExport()}
                    disabled={busy || (!planId && !githubAutoExportPlanId) || Boolean(githubJobId)}
                    style={secondaryButtonStyle}
                  >
                    Export
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {loadProjectOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Import project"
            onClick={() => setLoadProjectOpen(false)}
          >
            <div className="modalCard" onClick={(e) => e.stopPropagation()}>
              <div className="modalHeader">
                <div>Import Project</div>
                <button
                  type="button"
                  onClick={() => setLoadProjectOpen(false)}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  ref={loadFileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  disabled={busy}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setLoadProjectOpen(false);
                    void handleFile(f);
                    setActivePage("editProject");
                  }}
                />
                <input
                  value={importProjectValue}
                  onChange={(e) => setImportProjectValue(e.target.value)}
                  placeholder="~/path/to/project.csv  or  https://github.com/orgs/<org>/projects/<number>"
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    void runImportProject();
                  }}
                  style={{ flex: 1 }}
                />
                {importProjectValue.trim() ? (
                  <button
                    type="button"
                    onClick={() => void runImportProject()}
                    disabled={busy}
                    style={{ ...secondaryButtonStyle, height: 44, paddingTop: 0, paddingBottom: 0 }}
                  >
                    Import
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => loadFileInputRef.current?.click()}
                    disabled={busy}
                    style={{ ...secondaryButtonStyle, height: 44, paddingTop: 0, paddingBottom: 0 }}
                  >
                    Select File
                  </button>
                )}
              </div>

            </div>
          </div>
        ) : null}

        {exportProjectOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Export project"
            onClick={() => setExportProjectOpen(false)}
          >
            <div className="modalCard" onClick={(e) => e.stopPropagation()}>
              <div className="modalHeader">
                <div>Export Project</div>
                <button
                  type="button"
                  onClick={() => setExportProjectOpen(false)}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              {projects.length === 0 ? (
                <div className="small">No projects loaded yet. Import or create a project first.</div>
              ) : (
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    <div className="label">Filter</div>
                    <input value={exportProjectQuery} onChange={(e) => setExportProjectQuery(e.target.value)} placeholder="Type to filter projects…" />
                  </div>
                  <div>
                    <div className="label">Project</div>
                    <select value={exportProjectId} onChange={(e) => setExportProjectId(e.target.value)}>
                      {filteredExportProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name || "(untitled)"}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="label">Destination</div>
                    <input
                      value={exportTarget}
                      onChange={(e) => setExportTarget(e.target.value)}
                      placeholder="~/path/to/export.csv  or  https://github.com/orgs/<org>/projects/<number>"
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        void runExportSelectedProject();
                      }}
                    />
                    <div className="small" style={{ marginTop: 6 }}>
                      CSV paths are written by the backend (local dev). GitHub URLs export to a Project board.
                    </div>
                  </div>
                </div>
              )}

              <div className="modalActions">
                <button type="button" onClick={() => setExportProjectOpen(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void runExportSelectedProject()}
                  disabled={busy || !exportProjectId || !exportTarget.trim()}
                  style={secondaryButtonStyle}
                >
                  Export
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {newProjectOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label="New project"
            onClick={() => setNewProjectOpen(false)}
          >
            <div className="modalCard" onClick={(e) => e.stopPropagation()}>
              <div className="modalHeader">
                <div>New Project</div>
                <button
                  type="button"
                  onClick={() => setNewProjectOpen(false)}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <div className="label">Project name</div>
                  <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="e.g. Client – Plant – Station" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <div className="label">Project start date</div>
                    <input type="date" value={newProjectStartDate} onChange={(e) => setNewProjectStartDate(e.target.value)} />
                  </div>
                  <div>
                    <div className="label">Working days</div>
                    <select value={newProjectWorkingDays ? "yes" : "no"} onChange={(e) => setNewProjectWorkingDays(e.target.value === "yes")}>
                      <option value="no">Calendar days</option>
                      <option value="yes">Mon–Fri</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="modalActions">
                <button type="button" onClick={() => setNewProjectOpen(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
                <button type="button" onClick={createNewProject} style={secondaryButtonStyle}>
                  Create
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {selectProjectOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Select project"
            onClick={() => setSelectProjectOpen(false)}
          >
            <div className="modalCard" onClick={(e) => e.stopPropagation()}>
              <div className="modalHeader">
                <div>Select Project</div>
                <button
                  type="button"
                  onClick={() => setSelectProjectOpen(false)}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              {projects.length === 0 ? (
                <div className="small">No projects yet. Create a new project or import one.</div>
              ) : (
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    <div className="label">Filter</div>
                    <input value={selectProjectQuery} onChange={(e) => setSelectProjectQuery(e.target.value)} placeholder="Type to filter projects…" />
                  </div>
                  <div>
                    <div className="label">Project</div>
                    <select value={selectProjectId} onChange={(e) => setSelectProjectId(e.target.value)}>
                      {filteredProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name || "(untitled)"}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div className="modalActions">
                <button type="button" onClick={() => setSelectProjectOpen(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (selectProjectId) loadProjectById(selectProjectId);
                    setSelectProjectOpen(false);
                  }}
                  disabled={!selectProjectId}
                  style={secondaryButtonStyle}
                >
                  Load
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {viewOptionsModalOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label="View options"
            onClick={() => setViewOptionsModalOpen(false)}
          >
            <div className="modalCard" onClick={(e) => e.stopPropagation()}>
              <div className="modalHeader">
                <div>View Options</div>
                <button
                  type="button"
                  onClick={() => setViewOptionsModalOpen(false)}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
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
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
