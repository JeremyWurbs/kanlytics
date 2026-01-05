import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import html2canvas from "html2canvas";
import {
  createPlan,
  schedulePlan,
  fetchJobStatus,
  startConnectProject,
  startExportProject,
  loadCsvFromPath,
  saveCsvToPath,
  saveProject,
  loadProject,
  appendTask,
  updateTask,
  deleteTask,
  getPhaseMeta,
  updatePhaseMeta,
  getPhaseMetaCsv,
  updatePhaseMetaCsv,
  fetchTimelineStatus,
  updateMetadata,
  getMetadata,
} from "./api";
import type { GanttLayout, TimelineStatusResponse, TaskTimelineStatus } from "./types";
import { GanttChart } from "./components/GanttChart";
import "./styles.css";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIsoDateUtc(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || "").trim());
  if (!m) return null;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  return Date.UTC(yy, mm - 1, dd);
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

function generateProjectHash(): string {
  try {
    // Modern browsers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyCrypto: any = (globalThis as any).crypto;
    if (anyCrypto?.randomUUID) return anyCrypto.randomUUID();
  } catch {
    // ignore
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Parse a GitHub issue body that may contain ### Description and ### Acceptance Criteria sections.
 * Returns { description, acceptanceCriteria } with the content extracted.
 * If sections are not found, returns the entire body as description.
 */
function parseIssueBody(body: string): { description: string; acceptanceCriteria: string } {
  const trimmed = (body || "").trim();
  if (!trimmed) {
    return { description: "", acceptanceCriteria: "" };
  }

  // Look for ### Description and ### Acceptance Criteria sections
  const descMatch = /^###\s+Description\s*\n(.*?)(?=^###\s+Acceptance\s+Criteria|$)/ims.exec(trimmed);
  const acceptMatch = /^###\s+Acceptance\s+Criteria\s*\n(.*?)$/ims.exec(trimmed);

  let description = "";
  let acceptanceCriteria = "";

  if (descMatch) {
    description = descMatch[1].trim();
  }
  if (acceptMatch) {
    acceptanceCriteria = acceptMatch[1].trim();
  }

  // If we found neither section, treat the entire body as description
  if (!descMatch && !acceptMatch) {
    description = trimmed;
  }

  return { description, acceptanceCriteria };
}

/**
 * Combine description and acceptance criteria into a GitHub issue body format
 * with ### Description and ### Acceptance Criteria sections.
 */
function combineIssueBody(description: string, acceptanceCriteria: string): string {
  const parts: string[] = [];
  
  if (description.trim()) {
    parts.push("### Description");
    parts.push("");
    parts.push(description.trim());
  }
  
  if (acceptanceCriteria.trim()) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push("### Acceptance Criteria");
    parts.push("");
    parts.push(acceptanceCriteria.trim());
  }
  
  return parts.join("\n");
}

type ProjectRecord = {
  id: string;
  name: string;
  startDate: string;
  workingDays: boolean;
  csvText: string;
  phases?: string[];
  phaseMajors?: Record<string, number>;
  fileName?: string;
  projectUrl?: string;
  issueRepo?: string;
  // Project metadata (stored in CSV headers)
  projectHash?: string;
  projectManager?: string;
  techLead?: string;
  client?: string;
};

export default function App() {
  const loadFileInputRef = useRef<HTMLInputElement | null>(null);
  const lastScheduleKeyRef = useRef<string>("");
  const suppressAutoScheduleRef = useRef<boolean>(false);
  const toastTimerRef = useRef<number | null>(null);
  const allProjectsExportRef = useRef<HTMLDivElement | null>(null);

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
  const [newProjectNameError, setNewProjectNameError] = useState<string>("");
  const [newProjectStartDate, setNewProjectStartDate] = useState<string>(todayISO());
  const [newProjectWorkingDays, setNewProjectWorkingDays] = useState<boolean>(false);
  const [newProjectDefaultRepo, setNewProjectDefaultRepo] = useState<string>("");
  const [newProjectDefaultRepoError, setNewProjectDefaultRepoError] = useState<string>("");
  const [newProjectHash, setNewProjectHash] = useState<string>("");
  const [newProjectManager, setNewProjectManager] = useState<string>("");
  const [newProjectTechLead, setNewProjectTechLead] = useState<string>("");
  const [newProjectClient, setNewProjectClient] = useState<string>("");
  const newProjectTemplateFileInputRef = useRef<HTMLInputElement | null>(null);
  const [newProjectTemplatePath, setNewProjectTemplatePath] = useState<string>("");
  const [newProjectTemplateCsvText, setNewProjectTemplateCsvText] = useState<string>("");
  const [newProjectTemplateFileName, setNewProjectTemplateFileName] = useState<string>("");
  const [editMetadataOpen, setEditMetadataOpen] = useState<boolean>(false);
  const [editMetadataHash, setEditMetadataHash] = useState<string>("");
  const [editMetadataManager, setEditMetadataManager] = useState<string>("");
  const [editMetadataTechLead, setEditMetadataTechLead] = useState<string>("");
  const [editMetadataClient, setEditMetadataClient] = useState<string>("");
  const [githubAutoConnect, setGithubAutoConnect] = useState<boolean>(false);
  const [githubAutoExport, setGithubAutoExport] = useState<boolean>(false);
  const [githubAutoExportPlanId, setGithubAutoExportPlanId] = useState<string>("");

  const [exportProjectOpen, setExportProjectOpen] = useState<boolean>(false);
  const [exportProjectQuery, setExportProjectQuery] = useState<string>("");
  const [exportProjectId, setExportProjectId] = useState<string>("");
  const [exportTarget, setExportTarget] = useState<string>("");
  const [exportingPng, setExportingPng] = useState<boolean>(false);
  
  // Panel export (Milestones / Critical Tasks)
  const [panelExportOpen, setPanelExportOpen] = useState<"milestones" | "criticalTasks" | "">("");
  const milestonesRef = useRef<HTMLDivElement>(null);
  const criticalTasksRef = useRef<HTMLDivElement>(null);

  // All Projects multi-view (read-only Gantt charts)
  const [allProjectsPickerOpen, setAllProjectsPickerOpen] = useState<boolean>(false);
  const [allProjectsQuery, setAllProjectsQuery] = useState<string>("");
  const [allProjectsSelectedIds, setAllProjectsSelectedIds] = useState<string[]>([]);
  const [allProjectsLayoutsById, setAllProjectsLayoutsById] = useState<Record<string, GanttLayout>>({});
  const [allProjectsScheduleKeyById, setAllProjectsScheduleKeyById] = useState<Record<string, string>>({});
  const [allProjectsErrorsById, setAllProjectsErrorsById] = useState<Record<string, string>>({});

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
  const [multiProjectSharedAxis, setMultiProjectSharedAxis] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("kanlytics.view.multiProjectSharedAxis") === "1";
    } catch {
      return false;
    }
  });
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
  const [timelineStatus, setTimelineStatus] = useState<TimelineStatusResponse | null>(null);

  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");

  const [phaseFilter, setPhaseFilter] = useState<string[]>([]);
  const [addPhaseOpen, setAddPhaseOpen] = useState<boolean>(false);
  const [addPhaseName, setAddPhaseName] = useState<string>("");
  const [addPhaseError, setAddPhaseError] = useState<string>("");

  const [createTaskOpen, setCreateTaskOpen] = useState<boolean>(false);
  const [createTaskPhase, setCreateTaskPhase] = useState<string>("");
  const [createTaskTitle, setCreateTaskTitle] = useState<string>("");
  const [createTaskTitleError, setCreateTaskTitleError] = useState<string>("");
  const [createTaskBody, setCreateTaskBody] = useState<string>("");
  const [createTaskBodyTab, setCreateTaskBodyTab] = useState<"write" | "preview">("write");
  const [createTaskAcceptance, setCreateTaskAcceptance] = useState<string>("");
  const [createTaskAcceptanceTab, setCreateTaskAcceptanceTab] = useState<"write" | "preview">("write");
  const [createTaskWallDays, setCreateTaskWallDays] = useState<number>(1);
  const [createTaskBillableDays, setCreateTaskBillableDays] = useState<number>(1);
  const [createTaskDepQuery, setCreateTaskDepQuery] = useState<string>("");
  const [createTaskDeps, setCreateTaskDeps] = useState<string[]>([]);
  const [createTaskPhaseMajor, setCreateTaskPhaseMajor] = useState<number | null>(null);
  const [createTaskMode, setCreateTaskMode] = useState<"create" | "edit">("create");
  const [editingTaskId, setEditingTaskId] = useState<string>("");
  const [createTaskRepo, setCreateTaskRepo] = useState<string>("");
  const [createTaskRepoError, setCreateTaskRepoError] = useState<string>("");

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
      setTimelineStatus(null);
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
      setTimelineStatus(null);
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
    setTimelineStatus(null);
    setPlanId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Extract metadata from CSV if project record is missing it
  // This handles cases where CSV has metadata but project record doesn't (e.g., after refresh)
  useEffect(() => {
    if (!activeProjectId || !csvText.trim()) return;
    const p = projects.find((x) => x.id === activeProjectId);
    if (!p) return;
    
    // Extract metadata asynchronously - always try to sync CSV metadata with project record
    // Use a ref to prevent multiple simultaneous extractions
    let cancelled = false;
    void (async () => {
      try {
        const metadata = await getMetadata(csvText);
        if (cancelled) return;
        if (metadata.metadata) {
          setProjects((prev) =>
            prev.map((x) =>
              x.id === activeProjectId
                ? {
                    ...x,
                    projectHash: metadata.metadata?.project_hash ?? x.projectHash,
                    projectManager: metadata.metadata?.project_manager ?? x.projectManager,
                    techLead: metadata.metadata?.tech_lead ?? x.techLead,
                    client: metadata.metadata?.client ?? x.client,
                  }
                : x
            )
          );
        }
      } catch {
        // Non-fatal: metadata extraction failed
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, csvText]);

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

  useEffect(() => {
    try {
      window.localStorage.setItem("kanlytics.view.multiProjectSharedAxis", multiProjectSharedAxis ? "1" : "0");
    } catch {
      // ignore
    }
  }, [multiProjectSharedAxis]);

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

  const filteredAllProjects = useMemo(() => {
    const q = allProjectsQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => (p.name || "").toLowerCase().includes(q));
  }, [projects, allProjectsQuery]);

  const allProjectsPickerLabel = useMemo(() => {
    const sel = allProjectsSelectedIds;
    if (!sel.length) return "Select projects…";
    if (sel.length === 1) return projects.find((p) => p.id === sel[0])?.name || "1 project";
    return `${sel.length} projects`;
  }, [allProjectsSelectedIds, projects]);

  const allProjectsSelectedIdsSorted = useMemo(() => {
    const ids = (allProjectsSelectedIds || []).slice();
    const items = ids
      .map((id) => {
        const p = projects.find((x) => x.id === id);
        const l = allProjectsLayoutsById[id];
        const sd = parseIsoDateUtc((p?.startDate || "").trim());
        const metaSd = l ? parseIsoDateUtc(l.meta.project_start) : null;
        const t = sd ?? metaSd ?? Number.POSITIVE_INFINITY;
        return { id, t, name: (p?.name || "").toLowerCase() };
      })
      .sort((a, b) => (a.t !== b.t ? a.t - b.t : a.name.localeCompare(b.name)));
    return items.map((x) => x.id);
  }, [allProjectsSelectedIds, projects, allProjectsLayoutsById]);

  const sharedAxis = useMemo(() => {
    if (!multiProjectSharedAxis) return null;
    if (!allProjectsSelectedIds.length) return null;
    const MS_DAY = 24 * 60 * 60 * 1000;

    let baseUtc: number | null = null;
    const tasks: { startUtc: number; endUtc: number; w: number }[] = [];

    for (const pid of allProjectsSelectedIdsSorted) {
      const l = allProjectsLayoutsById[pid];
      if (!l) continue;
      const metaBase = parseIsoDateUtc(l.meta.project_start);
      if (metaBase != null) baseUtc = baseUtc == null ? metaBase : Math.min(baseUtc, metaBase);
      for (const t of l.tasks || []) {
        const su = parseIsoDateUtc(t.schedule.start);
        const eu = parseIsoDateUtc(t.schedule.end);
        if (su == null || eu == null) continue;
        baseUtc = baseUtc == null ? su : Math.min(baseUtc, su);
        tasks.push({ startUtc: su, endUtc: eu, w: t.schedule.w ?? 0 });
      }
    }

    if (baseUtc == null) return null;

    let maxEndXDay = 0;
    for (const it of tasks) {
      const startDay = Math.max(0, Math.floor((it.startUtc - baseUtc) / MS_DAY));
      const daySpan = it.w === 0 ? 0 : Math.max(0, Math.floor((it.endUtc - it.startUtc) / MS_DAY) + 1);
      const endXDay = startDay + Math.max(1, daySpan);
      maxEndXDay = Math.max(maxEndXDay, endXDay);
    }

    const iso = new Date(baseUtc).toISOString().slice(0, 10);
    return { axisBaseDate: iso, axisMaxXDay: maxEndXDay };
  }, [multiProjectSharedAxis, allProjectsSelectedIdsSorted, allProjectsLayoutsById]);

  useEffect(() => {
    if (!allProjectsPickerOpen) return;
    const onDoc = () => setAllProjectsPickerOpen(false);
    window.addEventListener("click", onDoc);
    return () => window.removeEventListener("click", onDoc);
  }, [allProjectsPickerOpen]);

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
    setExportProjectId(activeProjectId || "");
    setExportTarget("");
    setExportProjectOpen(true);
  }

  function openAddPhaseModal() {
    setAddPhaseName("");
    setAddPhaseError("");
    setAddPhaseOpen(true);
  }

  function nextPhaseMajor(): number {
    let maxMajor = 0;

    const p = activeProjectId ? projects.find((x) => x.id === activeProjectId) : null;
    const majors = p?.phaseMajors || {};
    for (const v of Object.values(majors)) {
      if (typeof v === "number" && Number.isFinite(v)) maxMajor = Math.max(maxMajor, v);
    }

    // Also consider majors inferred from existing task display IDs.
    for (const t of layout?.tasks || []) {
      const disp = String((t.display_id || t.display_task_id || "") ?? "").trim();
      const m = /^(\d+)\.(\d+)$/.exec(disp);
      if (m) maxMajor = Math.max(maxMajor, Number(m[1]));
    }

    return maxMajor + 1;
  }

  function inferPhaseMajorMapFromTasks(): Record<string, number> {
    const byPhaseCounts = new Map<string, Map<number, number>>();
    for (const t of layout?.tasks || []) {
      const phase = (t.phase || "").trim();
      if (!phase) continue;
      const disp = String((t.display_id || t.display_task_id || "") ?? "").trim();
      const m = /^(\d+)\.(\d+)$/.exec(disp);
      if (!m) continue;
      const major = Number(m[1]);
      if (!Number.isFinite(major)) continue;
      if (!byPhaseCounts.has(phase)) byPhaseCounts.set(phase, new Map());
      const inner = byPhaseCounts.get(phase)!;
      inner.set(major, (inner.get(major) || 0) + 1);
    }
    const out: Record<string, number> = {};
    for (const [phase, counts] of byPhaseCounts.entries()) {
      // choose the most frequent major for that phase, tie -> smallest major
      let bestMajor = 0;
      let bestCount = -1;
      for (const [major, count] of counts.entries()) {
        if (count > bestCount || (count === bestCount && major < bestMajor)) {
          bestMajor = major;
          bestCount = count;
        }
      }
      if (bestCount >= 0) out[phase] = bestMajor;
    }
    return out;
  }

  function createPhase() {
    const name = addPhaseName.trim();
    if (!name) {
      setAddPhaseError("Phase name is required.");
      return;
    }

    if (!activeProjectId) {
      showToast("error", "No project selected.");
      return;
    }

    const existing = new Set<string>();
    const p = projects.find((x) => x.id === activeProjectId);
    for (const ph of p?.phases || []) existing.add(ph.toLowerCase());
    for (const t of (layout?.tasks || [])) existing.add((t.phase || "Unphased").toLowerCase());
    if (existing.has(name.toLowerCase())) {
      setAddPhaseError("A phase with this name already exists.");
      return;
    }

    setProjects((prev) =>
      prev.map((x) => {
        if (x.id !== activeProjectId) return x;
        const cur = Array.isArray(x.phases) ? x.phases : [];
        const inferred = inferPhaseMajorMapFromTasks();
        const phaseMajors = { ...(x.phaseMajors || {}), ...inferred };
        if (phaseMajors[name] == null) phaseMajors[name] = nextPhaseMajor();
        return { ...x, phases: [...cur, name], phaseMajors };
      }),
    );
    setPhaseFilter((prev) => (prev.length === 0 ? [name] : Array.from(new Set([...prev, name]))));
    setAddPhaseOpen(false);
  }

  function openCreateTaskModal(phase: string) {
    setCreateTaskMode("create");
    setEditingTaskId("");
    setCreateTaskPhase(phase);
    // Resolve major for this phase (existing mapping or inferred from tasks).
    const p = activeProjectId ? projects.find((x) => x.id === activeProjectId) : null;
    const inferred = inferPhaseMajorMapFromTasks();
    const major = (p?.phaseMajors && p.phaseMajors[phase] != null ? p.phaseMajors[phase] : inferred[phase]) ?? null;
    setCreateTaskPhaseMajor(major);
    setCreateTaskTitle("");
    setCreateTaskTitleError("");
    setCreateTaskRepo(issueRepo.trim());
    setCreateTaskRepoError("");
    setCreateTaskBody("");
    setCreateTaskBodyTab("write");
    setCreateTaskAcceptance("");
    setCreateTaskAcceptanceTab("write");
    setCreateTaskWallDays(1);
    setCreateTaskBillableDays(1);
    setCreateTaskDepQuery("");
    setCreateTaskDeps([]);
    setCreateTaskOpen(true);
  }

  function openEditTaskModal(taskId: string) {
    const t = (layout?.tasks || []).find((x) => x.id === taskId);
    if (!t) {
      showToast("error", "Task not found in current layout.");
      return;
    }
    const repoFromUrl = (() => {
      const u = String(t.url || "").trim();
      const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/i.exec(u);
      if (m) return `${m[1]}/${m[2]}`;
      return "";
    })();
    setCreateTaskMode("edit");
    setEditingTaskId(taskId);
    setCreateTaskPhase((t.phase || "").trim());
    setCreateTaskPhaseMajor(null);
    setCreateTaskTitle((t.title || t.name || "").trim());
    setCreateTaskTitleError("");
    setCreateTaskRepo(String((t as any).repo || "").trim() || repoFromUrl || issueRepo.trim());
    setCreateTaskRepoError("");
    
    // For existing GitHub issues (with URL), parse the body to extract description/acceptance criteria
    // For new tasks (no URL), use the separate fields
    const hasUrl = Boolean(t.url && String(t.url).trim());
    if (hasUrl) {
      // Existing GitHub issue: show entire body in one field
      const bodyText = String(t.body || t.details || "");
      setCreateTaskBody(bodyText);
      setCreateTaskAcceptance(""); // Not used for existing issues
    } else {
      // New task: use separate fields
      setCreateTaskBody(String(t.body || t.details || ""));
      setCreateTaskAcceptance(String((t as any).acceptance_criteria || ""));
    }
    setCreateTaskBodyTab("write");
    setCreateTaskAcceptanceTab("write");
    setCreateTaskWallDays(Number((t.durations?.wall ?? 1) as any) || 1);
    setCreateTaskBillableDays(Number((t.durations?.billable ?? 1) as any) || 1);
    setCreateTaskDepQuery("");
    setCreateTaskDeps(Array.isArray(t.dependencies) ? t.dependencies.slice() : []);
    setCreateTaskOpen(true);
  }

  const dependencyCandidates = useMemo(() => {
    const tasks = layout?.tasks || [];
    const q = createTaskDepQuery.trim().toLowerCase();
    return tasks
      .filter((t) => (t.id || "").trim() !== "")
      .filter((t) => {
        if (!q) return true;
        const key = t.display_id || t.display_task_id || t.id;
        const hay = `${key} ${t.title || t.name} ${(t.phase || "").trim()}`.toLowerCase();
        return hay.includes(q);
      })
      .slice()
      .sort((a, b) => {
        const ap = (a.phase || "").toLowerCase();
        const bp = (b.phase || "").toLowerCase();
        if (ap !== bp) return ap.localeCompare(bp);
        return (a.schedule?.row ?? 0) - (b.schedule?.row ?? 0);
      });
  }, [layout?.tasks, createTaskDepQuery]);

  async function createTask() {
    const title = createTaskTitle.trim();
    if (!title) {
      setCreateTaskTitleError("Title is required.");
      return;
    }
    const repo = createTaskRepo.trim();
    if (!repo) {
      setCreateTaskRepoError("Repo is required (owner/repo).");
      return;
    }
    if (!createTaskPhase.trim()) {
      showToast("error", "Phase is required.");
      return;
    }
    if (!csvText.trim()) {
      showToast("error", "No project CSV loaded.");
      return;
    }

    try {
      setBusy(true);
      const res = await appendTask({
        csvText,
        projectName: projectName.trim() || undefined,
        phase: createTaskPhase.trim(),
        title,
        repo,
        body: createTaskBody,
        acceptanceCriteria: createTaskAcceptance,
        dependencies: createTaskDeps,
        wallDays: Number.isFinite(createTaskWallDays) ? createTaskWallDays : 1,
        billableDays: Number.isFinite(createTaskBillableDays) ? createTaskBillableDays : 1,
        phaseMajor: createTaskPhaseMajor ?? undefined,
      });
      const nextCsv = String(res.csv_text || "");
      setCsvText(nextCsv);
      if (activeProjectId) {
        setProjects((prev) => prev.map((p) => (p.id === activeProjectId ? { ...p, csvText: nextCsv } : p)));
      }
      // Ensure the phase is visible in the current filter.
      setPhaseFilter((prev) => (prev.length === 0 ? [createTaskPhase] : Array.from(new Set([...prev, createTaskPhase]))));
      setCreateTaskOpen(false);
      showToast("success", "Task created.");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEditedTask() {
    const title = createTaskTitle.trim();
    if (!title) {
      setCreateTaskTitleError("Title is required.");
      return;
    }
    const repo = createTaskRepo.trim();
    if (!repo) {
      setCreateTaskRepoError("Repo is required (owner/repo).");
      return;
    }
    if (!editingTaskId) {
      showToast("error", "No task selected to edit.");
      return;
    }
    if (!csvText.trim()) {
      showToast("error", "No project CSV loaded.");
      return;
    }
    
    // Check if this is an existing GitHub issue
    const t = (layout?.tasks || []).find((x) => x.id === editingTaskId);
    const hasUrl = Boolean(t?.url && String(t.url).trim());
    
    try {
      setBusy(true);
      // For existing GitHub issues, save the body as-is (user edited the combined body)
      // For new tasks, save description and acceptance criteria separately
      const res = await updateTask({
        csvText,
        taskId: editingTaskId,
        title,
        repo,
        body: hasUrl ? createTaskBody : createTaskBody, // For existing issues, body is the full combined body
        acceptanceCriteria: hasUrl ? undefined : createTaskAcceptance, // For existing issues, don't update acceptance criteria separately
        dependencies: createTaskDeps,
        wallDays: Number.isFinite(createTaskWallDays) ? createTaskWallDays : 1,
        billableDays: Number.isFinite(createTaskBillableDays) ? createTaskBillableDays : 1,
      });
      const nextCsv = String(res.csv_text || "");
      setCsvText(nextCsv);
      if (activeProjectId) setProjects((prev) => prev.map((p) => (p.id === activeProjectId ? { ...p, csvText: nextCsv } : p)));
      setCreateTaskOpen(false);
      showToast("success", "Task updated.");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTaskAndReschedule(taskId: string) {
    if (!csvText.trim()) {
      showToast("error", "No project CSV loaded.");
      return;
    }
    try {
      setBusy(true);
      const res = await deleteTask({ csvText, taskId });
      const nextCsv = String(res.csv_text || "");
      setCsvText(nextCsv);
      if (activeProjectId) setProjects((prev) => prev.map((p) => (p.id === activeProjectId ? { ...p, csvText: nextCsv } : p)));
      showToast("success", "Task deleted (dependency references removed).");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deletePhaseAndReschedule(phase: string) {
    if (!csvText.trim()) {
      showToast("error", "No project CSV loaded.");
      return;
    }
    if (!layout) {
      showToast("error", "No layout available.");
      return;
    }
    // Find all task IDs in this phase
    const taskIdsToDelete = (layout.tasks || [])
      .filter((t) => (t.phase || "Unphased") === phase)
      .map((t) => t.id);
    
    if (taskIdsToDelete.length === 0) {
      // No tasks to delete, but still remove the phase from extraPhases
      if (activeProjectId) {
        setProjects((prev) =>
          prev.map((p) =>
            p.id === activeProjectId
              ? { ...p, phases: (p.phases || []).filter((ph) => ph !== phase) }
              : p
          )
        );
      }
      showToast("success", `Phase "${phase}" removed.`);
      return;
    }
    
    try {
      setBusy(true);
      let currentCsv = csvText;
      let deletedCount = 0;
      
      // Delete each task one by one
      for (const taskId of taskIdsToDelete) {
        try {
          const res = await deleteTask({ csvText: currentCsv, taskId });
          currentCsv = String(res.csv_text || "");
          deletedCount++;
        } catch {
          // Task may have already been deleted as a dependency cascade - continue
        }
      }
      
      // Also remove the phase from extraPhases if it exists
      if (activeProjectId) {
        setProjects((prev) =>
          prev.map((p) =>
            p.id === activeProjectId
              ? { ...p, phases: (p.phases || []).filter((ph) => ph !== phase), csvText: currentCsv }
              : p
          )
        );
      }
      
      // Update CSV and explicitly reschedule
      setCsvText(currentCsv);
      
      // Check if there are any tasks left
      const hasTasksLeft = currentCsv.trim().split("\n").length > 1;
      
      if (hasTasksLeft && startDate.trim()) {
        // Create a new plan and reschedule with the updated CSV
        const created = await createPlan(currentCsv, projectName.trim() || undefined);
        setPlanId(created.plan_id);
        
        const scheduled = await schedulePlan({
          planId: created.plan_id,
          startDate,
          durationMode,
          workingDays,
        });
        
        setLayout(scheduled.layout);
        
        // Update timeline status
        try {
          const tlStatus = await fetchTimelineStatus({ planId: created.plan_id });
          setTimelineStatus(tlStatus);
        } catch {
          setTimelineStatus(null);
        }
        
        lastScheduleKeyRef.current = JSON.stringify({
          planId: created.plan_id,
          startDate,
          durationMode,
          workingDays,
        });
      } else {
        // No tasks left - clear the layout
        setLayout(null);
        setTimelineStatus(null);
        setPlanId("");
      }
      
      showToast("success", `Deleted ${deletedCount} task(s) from phase "${phase}".`);
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openProjectById(pid: string) {
    const p = projects.find((x) => x.id === pid);
    if (!p) return;

    // Hydrate base project info immediately.
    setActiveProjectId(p.id);
    setProjectName(p.name || "");
    const sd = (p.startDate || todayISO()).trim();
    setStartDate(sd);
    setWorkingDays(Boolean(p.workingDays));
    setProjectUrl(p.projectUrl || "");
    setIssueRepo(p.issueRepo || "");
    setFileName(p.fileName || "");
    setActivePage("editProject");

    // We'll drive scheduling manually; don't rely on the csvText-change auto effect.
    suppressAutoScheduleRef.current = true;
    setLayout(null);
    setTimelineStatus(null);
    setPlanId("");

    try {
      setBusy(true);

      let csv = String(p.csvText || "");
      if (!csv.trim()) {
        const name = (p.name || "").trim();
        if (!name) throw new Error("Project has no name; cannot load from registry.");
        const loaded = await loadProject(name);
        csv = String(loaded.csv_text || "");
        setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, csvText: csv } : x)));
      }

      // Normalize/schedule now so the user doesn't have to refresh.
      const created = await createPlan(csv, (p.name || "").trim() || undefined);
      const normalized = created.normalized_csv_text && created.normalized_csv_text.trim() ? created.normalized_csv_text : csv;
      setCsvText(normalized);
      
      // Extract and update metadata from the CSV
      if (created.metadata) {
        setProjects((prev) =>
          prev.map((x) =>
            x.id === p.id
              ? {
                  ...x,
                  csvText: normalized,
                  projectHash: created.metadata?.project_hash ?? x.projectHash,
                  projectManager: created.metadata?.project_manager ?? x.projectManager,
                  techLead: created.metadata?.tech_lead ?? x.techLead,
                  client: created.metadata?.client ?? x.client,
                }
              : x
          )
        );
      } else {
        // If no metadata in createPlan response, try to extract from CSV
        try {
          const metadata = await getMetadata(normalized);
          if (metadata.metadata) {
            setProjects((prev) =>
              prev.map((x) =>
                x.id === p.id
                  ? {
                      ...x,
                      csvText: normalized,
                      projectHash: metadata.metadata?.project_hash ?? x.projectHash,
                      projectManager: metadata.metadata?.project_manager ?? x.projectManager,
                      techLead: metadata.metadata?.tech_lead ?? x.techLead,
                      client: metadata.metadata?.client ?? x.client,
                    }
                  : x
              )
            );
          } else {
            setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, csvText: normalized } : x)));
          }
        } catch {
          setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, csvText: normalized } : x)));
        }
      }

      const scheduled = await schedulePlan({
        planId: created.plan_id,
        startDate: sd,
        durationMode,
        workingDays: Boolean(p.workingDays),
      });
      setPlanId(created.plan_id);
      setLayout(scheduled.layout);

      // Fetch timeline status for the critical tasks panel
      try {
        const tlStatus = await fetchTimelineStatus({ planId: created.plan_id });
        setTimelineStatus(tlStatus);
      } catch {
        // Non-fatal: timeline status is supplementary
        setTimelineStatus(null);
      }

      lastScheduleKeyRef.current = JSON.stringify({
        planId: created.plan_id,
        startDate: sd,
        durationMode,
        workingDays: Boolean(p.workingDays),
      });
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      suppressAutoScheduleRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    // Drive All Projects multi-view: schedule selected projects in the background.
    let cancelled = false;
    const ids = (allProjectsSelectedIds || []).slice();
    if (ids.length === 0) return;

    void (async () => {
      for (const pid of ids) {
        if (cancelled) return;
        const p = projects.find((x) => x.id === pid);
        if (!p) continue;
        const key = JSON.stringify({
          pid,
          csvLen: (p.csvText || "").length,
          startDate: (p.startDate || "").trim(),
          workingDays: Boolean(p.workingDays),
          durationMode,
        });
        if (allProjectsScheduleKeyById[pid] === key && allProjectsLayoutsById[pid]) continue;

        try {
          setAllProjectsErrorsById((prev) => ({ ...prev, [pid]: "" }));

          // Ensure we have CSV (load from registry if needed)
          let csv = String(p.csvText || "");
          if (!csv.trim() && (p.name || "").trim()) {
            const loaded = await loadProject((p.name || "").trim());
            csv = String(loaded.csv_text || "");
            // cache into project record so we don't reload repeatedly
            setProjects((prev) => prev.map((x) => (x.id === pid ? { ...x, csvText: csv } : x)));
          }

          if (!csv.trim()) {
            setAllProjectsErrorsById((prev) => ({ ...prev, [pid]: "Project has no CSV yet." }));
            continue;
          }

          const created = await createPlan(csv, (p.name || "").trim() || undefined);
          const normalized = created.normalized_csv_text && created.normalized_csv_text.trim() ? created.normalized_csv_text : csv;
          if (normalized !== csv) {
            setProjects((prev) => prev.map((x) => (x.id === pid ? { ...x, csvText: normalized } : x)));
          }

          const scheduled = await schedulePlan({
            planId: created.plan_id,
            startDate: (p.startDate || todayISO()).trim(),
            durationMode,
            workingDays: Boolean(p.workingDays),
          });
          if (cancelled) return;
          setAllProjectsLayoutsById((prev) => ({ ...prev, [pid]: scheduled.layout }));
          setAllProjectsScheduleKeyById((prev) => ({ ...prev, [pid]: key }));
        } catch (e: any) {
          if (cancelled) return;
          setAllProjectsErrorsById((prev) => ({ ...prev, [pid]: e?.message || String(e) }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProjectsSelectedIds, projects, durationMode]);

  function ensureActiveProject(overrides?: Partial<ProjectRecord>): ProjectRecord {
    if (activeProjectId) {
      const existing = projects.find((p) => p.id === activeProjectId);
      if (existing) return existing;
    }
    const id = newProjectId();
    const name = (overrides?.name || projectName.trim() || fileName.trim() || "Untitled Project").trim();
    const p: ProjectRecord = {
      id,
      name,
      startDate: (overrides?.startDate ?? startDate).trim() || todayISO(),
      workingDays: overrides?.workingDays ?? Boolean(workingDays),
      csvText: overrides?.csvText ?? (csvText || ""),
      phases: overrides?.phases ?? [],
      fileName: overrides?.fileName ?? (fileName || ""),
      projectUrl: overrides?.projectUrl ?? (projectUrl || ""),
      issueRepo: overrides?.issueRepo ?? (issueRepo || ""),
    };
    setProjects((prev) => [p, ...prev]);
    setActiveProjectId(id);

    // Hydrate UI state immediately (otherwise imports create a project record but the header/settings look blank).
    setProjectName(p.name);
    setStartDate(p.startDate);
    setWorkingDays(Boolean(p.workingDays));
    setProjectUrl(p.projectUrl || "");
    setIssueRepo(p.issueRepo || "");
    setFileName(p.fileName || "");
    setCsvText(p.csvText || "");
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
          phases: p.phases,
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
    setNewProjectNameError("");
    setNewProjectStartDate(startDate);
    setNewProjectWorkingDays(workingDays);
    setNewProjectDefaultRepo(issueRepo);
    setNewProjectDefaultRepoError("");
    setNewProjectHash(generateProjectHash());
    setNewProjectManager("");
    setNewProjectTechLead("");
    setNewProjectClient("");
    setNewProjectTemplatePath("");
    setNewProjectTemplateCsvText("");
    setNewProjectTemplateFileName("");
    setNewProjectOpen(true);
  }

  async function createNewProject() {
    const pn = newProjectName.trim();
    const dr = newProjectDefaultRepo.trim();
    const pnErr = pn ? "" : "Project name is required.";
    const drErr = dr ? "" : "Default repo is required (owner/repo).";
    setNewProjectNameError(pnErr);
    setNewProjectDefaultRepoError(drErr);
    if (pnErr || drErr) return;

    const id = newProjectId();
    const p: ProjectRecord = {
      id,
      name: pn,
      startDate: (newProjectStartDate || todayISO()).trim(),
      workingDays: Boolean(newProjectWorkingDays),
      csvText: "",
      phases: [],
      fileName: "",
      projectUrl: "",
      issueRepo: dr,
    };

    setProjects((prev) => [p, ...prev]);
    setActiveProjectId(id);

    setProjectName(p.name);
    setStartDate(p.startDate);
    setWorkingDays(p.workingDays);
    setProjectUrl("");
    setIssueRepo(dr);
    setFileName("");
    setLayout(null);
    setTimelineStatus(null);
    setPlanId("");
    const emptyCsv = [
      [
        "Display Task ID",
        "Task ID",
        "url",
        "repo",
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
      ].join(","),
      "",
    ].join("\n");
    setCsvText(emptyCsv);

    setNewProjectOpen(false);
    setActivePage("editProject");

    // Optional template: either chosen from disk (csvText already loaded), or a local path to load.
    const templatePath = newProjectTemplatePath.trim();
    const templateInline = newProjectTemplateCsvText;
    let finalCsvText = emptyCsv;
    if (templateInline.trim() || templatePath) {
      try {
        setBusy(true);
        let tplText = templateInline;
        let tplName = newProjectTemplateFileName.trim();
        if (!tplText.trim() && templatePath) {
          const res = await loadCsvFromPath(templatePath);
          tplText = String(res.csv_text || "");
          tplName = (res.file_name || "").trim() || tplName;
        }
        if (tplName) setFileName(tplName);
        if (tplText.trim()) {
          finalCsvText = tplText;
          setCsvText(tplText);
        }
        showToast("success", "Project created from template.");
      } catch (e: any) {
        showToast("error", e?.message || String(e));
        setBusy(false);
        return;
      } finally {
        setBusy(false);
      }
    }

    // Update metadata with project hash, PM, TL, and Client
    try {
      setBusy(true);
      const metadataResult = await updateMetadata({
        csvText: finalCsvText,
        projectName: pn,
        projectHash: newProjectHash.trim() || undefined,
        projectManager: newProjectManager.trim() || undefined,
        techLead: newProjectTechLead.trim() || undefined,
        client: newProjectClient.trim() || undefined,
      });
      
      // Update CSV with metadata
      setCsvText(metadataResult.csv_text);
      
      // Force a re-read of metadata from the updated CSV to ensure consistency
      const updatedMetadata = await getMetadata(metadataResult.csv_text);
      
      // Update project record with metadata from the updated CSV
      if (updatedMetadata.metadata) {
        const meta = updatedMetadata.metadata;
        setProjects((prev) =>
          prev.map((proj) =>
            proj.id === id
              ? {
                  ...proj,
                  projectHash: meta.project_hash ?? proj.projectHash,
                  projectManager: meta.project_manager ?? undefined,
                  techLead: meta.tech_lead ?? undefined,
                  client: meta.client ?? undefined,
                  csvText: metadataResult.csv_text,
                }
              : proj
          )
        );
      }
    } catch (e: any) {
      // Non-fatal: metadata update failed, but project is still created
      console.error("Failed to update metadata:", e);
    } finally {
      setBusy(false);
    }

    if (!templateInline.trim() && !templatePath) {
      showToast("success", "Project created.");
    }
  }

  async function openEditMetadataModal() {
    if (!csvText.trim()) {
      showToast("error", "No project data available.");
      return;
    }
    try {
      setBusy(true);
      const metadata = await getMetadata(csvText);
      setEditMetadataHash(metadata.metadata?.project_hash || "");
      setEditMetadataManager(metadata.metadata?.project_manager || "");
      setEditMetadataTechLead(metadata.metadata?.tech_lead || "");
      setEditMetadataClient(metadata.metadata?.client || "");
      setEditMetadataOpen(true);
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveMetadata() {
    if (!csvText.trim()) {
      showToast("error", "No project data available.");
      return;
    }
    try {
      setBusy(true);
      const result = await updateMetadata({
        csvText,
        projectName: projectName.trim() || undefined,
        projectHash: editMetadataHash.trim() || undefined,
        projectManager: editMetadataManager.trim() || undefined,
        techLead: editMetadataTechLead.trim() || undefined,
        client: editMetadataClient.trim() || undefined,
      });
      
      // Force a re-read of metadata from the updated CSV to ensure consistency
      const updatedMetadata = await getMetadata(result.csv_text);
      
      // Update CSV with new metadata
      setCsvText(result.csv_text);
      
      // Update project record with metadata from the updated CSV
      if (activeProjectId) {
        const meta = updatedMetadata.metadata;
        setProjects((prev) =>
          prev.map((p) =>
            p.id === activeProjectId
              ? {
                  ...p,
                  projectHash: meta?.project_hash ?? p.projectHash,
                  projectManager: meta?.project_manager ?? undefined,
                  techLead: meta?.tech_lead ?? undefined,
                  client: meta?.client ?? undefined,
                  csvText: result.csv_text,
                }
              : p
          )
        );
      }
      
      setEditMetadataOpen(false);
      showToast("success", "Metadata updated.");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
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
    setTimelineStatus(null);
    setPlanId("");
    setFileName(file.name);
    const text = await file.text();
    // Ensure we have a project to associate this import with.
    const base = file.name.replace(/\.csv$/i, "");
    ensureActiveProject({ name: projectName.trim() || base || "Imported Project", fileName: file.name });
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
      // Ensure we have a project to associate this import with, and hydrate UI state now.
      let derivedName = projectName.trim();
      try {
        const u = new URL(raw);
        const parts = u.pathname.split("/").filter(Boolean);
        const orgIdx = parts.indexOf("orgs");
        const org = orgIdx >= 0 ? parts[orgIdx + 1] : "";
        const projIdx = parts.indexOf("projects");
        const num = projIdx >= 0 ? parts[projIdx + 1] : "";
        if (!derivedName) derivedName = `${org || "GitHub"} Project${num ? ` ${num}` : ""}`.trim();
      } catch {
        // ignore
      }
      ensureActiveProject({ name: derivedName || "GitHub Project", projectUrl: raw });
      setProjectUrl(raw);
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
      // Ensure we have a project to associate this import with, and hydrate UI state now.
      const fn = (res.file_name || "").trim();
      const fallbackName = fn ? fn.replace(/\.csv$/i, "") : projectName.trim() || "Imported Project";
      const project = ensureActiveProject({ name: projectName.trim() || fallbackName, fileName: fn || fileName });
      setLayout(null);
      setTimelineStatus(null);
      setPlanId("");
      if (fn) setFileName(fn);
      const csv = res.csv_text || "";
      setCsvText(csv);
      
      // Extract and update metadata from the CSV
      try {
        const metadata = await getMetadata(csv);
        if (metadata.metadata) {
          setProjects((prev) =>
            prev.map((x) =>
              x.id === project.id
                ? {
                    ...x,
                    csvText: csv,
                    projectHash: metadata.metadata?.project_hash ?? x.projectHash,
                    projectManager: metadata.metadata?.project_manager ?? x.projectManager,
                    techLead: metadata.metadata?.tech_lead ?? x.techLead,
                    client: metadata.metadata?.client ?? x.client,
                  }
                : x
            )
          );
        }
      } catch {
        // Non-fatal: metadata extraction failed, but CSV is still loaded
      }
      
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
    const pid = activeProjectId;
    const target = exportTarget.trim();
    if (!pid) {
      showToast("error", "No active project to export.");
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

  async function exportCurrentGanttAsPng() {
    if (!activeProjectId) {
      showToast("error", "No active project to export.");
      return;
    }
    const el = document.querySelector(
      `[data-kanlytics-gantt-export-root][data-kanlytics-gantt-export-id="${activeProjectId}"]`,
    ) as HTMLElement | null;
    if (!el) {
      showToast("error", "Gantt chart is not available to export yet.");
      return;
    }
    try {
      setBusy(true);
      setExportingPng(true);
      // Give React a tick to hide overlays.
      await new Promise((r) => window.setTimeout(r, 30));

      // Capture full scrollable width/height by cloning offscreen and expanding scroll containers.
      const wrapper = document.createElement("div");
      wrapper.style.position = "fixed";
      wrapper.style.left = "-100000px";
      wrapper.style.top = "0";
      wrapper.style.pointerEvents = "none";
      wrapper.style.opacity = "0";
      wrapper.style.background = "transparent";

      const clone = el.cloneNode(true) as HTMLElement;
      wrapper.appendChild(clone);
      document.body.appendChild(wrapper);

      // Expand any scroll containers inside the clone.
      const all = Array.from(clone.querySelectorAll<HTMLElement>("*"));
      for (const node of all) {
        // If it scrolls, expand it.
        const sw = node.scrollWidth;
        const sh = node.scrollHeight;
        if (sw > node.clientWidth + 1) node.style.width = `${sw}px`;
        if (sh > node.clientHeight + 1) node.style.height = `${sh}px`;
        const cs = window.getComputedStyle(node);
        if (cs.overflow === "auto" || cs.overflow === "scroll") node.style.overflow = "visible";
        if (cs.overflowX === "auto" || cs.overflowX === "scroll") node.style.overflowX = "visible";
        if (cs.overflowY === "auto" || cs.overflowY === "scroll") node.style.overflowY = "visible";
      }

      // Size wrapper to the clone's content.
      const fullW = Math.max(clone.scrollWidth, el.scrollWidth, el.clientWidth);
      const fullH = Math.max(clone.scrollHeight, el.scrollHeight, el.clientHeight);

      // Crop the right side to ~one tick beyond the right-most task bar.
      let captureW = fullW;
      try {
        const rootRect = clone.getBoundingClientRect();
        let maxRight = 0;
        const bars = Array.from(clone.querySelectorAll<HTMLElement>('[data-kanlytics-taskbar="1"]'));
        for (const b of bars) {
          const r = b.getBoundingClientRect();
          maxRight = Math.max(maxRight, r.right - rootRect.left);
        }
        if (maxRight > 0) {
          const tickPx = Math.max(40, pxPerDay); // one label interval minimum
          captureW = Math.min(fullW, Math.ceil(maxRight + tickPx + 20));
        }
      } catch {
        // ignore crop failures; fall back to full width
      }
      wrapper.style.width = `${fullW}px`;
      wrapper.style.height = `${fullH}px`;
      clone.style.width = `${fullW}px`;

      // Keep canvas dimensions in check for very large exports.
      const maxCanvasDim = 16000;
      const scale = Math.min(2, Math.max(0.5, maxCanvasDim / Math.max(1, fullW)));

      const canvas = await html2canvas(clone, {
        backgroundColor: null,
        scale,
        useCORS: true,
        logging: false,
        width: captureW,
        height: fullH,
        windowWidth: captureW,
        windowHeight: fullH,
      });
      wrapper.remove();
      const dataUrl = canvas.toDataURL("image/png");
      const name = (activeProject?.name || projectName || "gantt").trim().replace(/[^\w\- ]+/g, "_");
      const fname = `${name || "gantt"}.png`;
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setExportProjectOpen(false);
      showToast("success", "Exported PNG.");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setExportingPng(false);
      setBusy(false);
    }
  }

  async function exportJointProjectViewAsPng() {
    if (!allProjectsSelectedIds.length) {
      showToast("error", "Select one or more projects to export.");
      return;
    }
    const el = allProjectsExportRef.current;
    if (!el) {
      showToast("error", "Project view is not available to export yet.");
      return;
    }
    try {
      setBusy(true);
      setExportingPng(true);
      setAllProjectsPickerOpen(false);
      await new Promise((r) => window.setTimeout(r, 30));

      const wrapper = document.createElement("div");
      wrapper.style.position = "fixed";
      wrapper.style.left = "-100000px";
      wrapper.style.top = "0";
      wrapper.style.pointerEvents = "none";
      wrapper.style.opacity = "0";
      wrapper.style.background = "transparent";

      const clone = el.cloneNode(true) as HTMLElement;
      // Force a vertical layout in the exported image (top-to-bottom),
      // regardless of the responsive grid used on-screen.
      clone.style.display = "flex";
      clone.style.flexDirection = "column";
      clone.style.gap = "12px";
      clone.style.alignItems = "stretch";
      // Ensure children don't try to "grid" themselves.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (clone.style as any).gridTemplateColumns = "";
      wrapper.appendChild(clone);
      document.body.appendChild(wrapper);

      const all = Array.from(clone.querySelectorAll<HTMLElement>("*"));
      for (const node of all) {
        const sw = node.scrollWidth;
        const sh = node.scrollHeight;
        if (sw > node.clientWidth + 1) node.style.width = `${sw}px`;
        if (sh > node.clientHeight + 1) node.style.height = `${sh}px`;
        const cs = window.getComputedStyle(node);
        if (cs.overflow === "auto" || cs.overflow === "scroll") node.style.overflow = "visible";
        if (cs.overflowX === "auto" || cs.overflowX === "scroll") node.style.overflowX = "visible";
        if (cs.overflowY === "auto" || cs.overflowY === "scroll") node.style.overflowY = "visible";
      }

      // After forcing column layout, compute width as the maximum child width.
      let childMaxW = 0;
      for (const child of Array.from(clone.children) as HTMLElement[]) {
        childMaxW = Math.max(childMaxW, child.scrollWidth, child.clientWidth);
        child.style.width = "100%";
      }
      const fullW = Math.max(childMaxW, clone.scrollWidth, el.scrollWidth, el.clientWidth);
      const fullH = Math.max(clone.scrollHeight, el.scrollHeight, el.clientHeight);
      let captureW = fullW;
      try {
        const rootRect = clone.getBoundingClientRect();
        let maxRight = 0;
        const bars = Array.from(clone.querySelectorAll<HTMLElement>('[data-kanlytics-taskbar="1"]'));
        for (const b of bars) {
          const r = b.getBoundingClientRect();
          maxRight = Math.max(maxRight, r.right - rootRect.left);
        }
        if (maxRight > 0) {
          const tickPx = Math.max(40, pxPerDay);
          captureW = Math.min(fullW, Math.ceil(maxRight + tickPx + 20));
        }
      } catch {
        // ignore
      }
      wrapper.style.width = `${fullW}px`;
      wrapper.style.height = `${fullH}px`;
      clone.style.width = `${fullW}px`;

      const maxCanvasDim = 16000;
      const scale = Math.min(2, Math.max(0.5, maxCanvasDim / Math.max(1, fullW)));

      const canvas = await html2canvas(clone, {
        backgroundColor: null,
        scale,
        useCORS: true,
        logging: false,
        width: captureW,
        height: fullH,
        windowWidth: captureW,
        windowHeight: fullH,
      });
      wrapper.remove();
      const dataUrl = canvas.toDataURL("image/png");
      const fname = `projects-${allProjectsSelectedIds.length}.png`;
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast("success", "Exported PNG.");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setExportingPng(false);
      setBusy(false);
    }
  }

  async function exportPanelAsPng(panelType: "milestones" | "criticalTasks") {
    const ref = panelType === "milestones" ? milestonesRef : criticalTasksRef;
    const el = ref.current;
    if (!el) {
      showToast("error", "Panel is not available to export.");
      return;
    }
    try {
      setBusy(true);
      await new Promise((r) => window.setTimeout(r, 30));

      const clone = el.cloneNode(true) as HTMLElement;
      
      // Remove the ID column (first column) from the table
      const rows = clone.querySelectorAll("tr");
      for (const row of rows) {
        const firstCell = row.querySelector("th, td");
        if (firstCell) {
          firstCell.remove();
        }
      }
      
      const wrapper = document.createElement("div");
      wrapper.style.position = "fixed";
      wrapper.style.left = "-100000px";
      wrapper.style.top = "0";
      wrapper.style.pointerEvents = "none";
      wrapper.style.background = "var(--card)";
      wrapper.appendChild(clone);
      document.body.appendChild(wrapper);

      const fullW = clone.scrollWidth;
      const fullH = clone.scrollHeight;
      wrapper.style.width = `${fullW}px`;
      wrapper.style.height = `${fullH}px`;

      const canvas = await html2canvas(clone, {
        backgroundColor: null,
        scale: 2,
        useCORS: true,
        logging: false,
        width: fullW,
        height: fullH,
      });
      wrapper.remove();

      const dataUrl = canvas.toDataURL("image/png");
      const baseName = (activeProject?.name || projectName || "project").trim().replace(/[^\w\- ]+/g, "_");
      const fname = `${baseName}_${panelType === "milestones" ? "milestones" : "critical_tasks"}.png`;
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setPanelExportOpen("");
      showToast("success", "Exported PNG.");
    } catch (e: any) {
      showToast("error", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function exportPanelAsCsv(panelType: "milestones" | "criticalTasks") {
    if (!layout) {
      showToast("error", "No layout available.");
      return;
    }

    let csvContent = "";
    const baseName = (activeProject?.name || projectName || "project").trim().replace(/[^\w\- ]+/g, "_");
    let fname = "";

    if (panelType === "milestones") {
      const milestones = layout.tasks.filter(t => (t.durations?.wall ?? 1) === 0);
      if (milestones.length === 0) {
        showToast("error", "No milestones to export.");
        return;
      }
      milestones.sort((a, b) => (a.schedule.start || "").localeCompare(b.schedule.start || ""));
      
      csvContent = "ID,Milestone,Phase,Date\n";
      for (const m of milestones) {
        const id = (m.display_task_id || "").replace(/"/g, '""');
        const name = (m.name || m.title || "").replace(/"/g, '""');
        const phase = (m.phase || "").replace(/"/g, '""');
        const date = m.schedule.start || "";
        csvContent += `"${id}","${name}","${phase}","${date}"\n`;
      }
      fname = `${baseName}_milestones.csv`;
    } else {
      if (!timelineStatus) {
        showToast("error", "No timeline status available.");
        return;
      }
      const criticalTasks = timelineStatus.tasks.filter(t => 
        t.timeline_status === "Delayed" || t.timeline_status === "Critically Delayed"
      );
      if (criticalTasks.length === 0) {
        showToast("error", "No critical tasks to export.");
        return;
      }
      criticalTasks.sort((a, b) => {
        if (a.timeline_status === "Critically Delayed" && b.timeline_status !== "Critically Delayed") return -1;
        if (a.timeline_status !== "Critically Delayed" && b.timeline_status === "Critically Delayed") return 1;
        const aDeadline = a.deadline || a.end_date || "";
        const bDeadline = b.deadline || b.end_date || "";
        return aDeadline.localeCompare(bDeadline);
      });

      csvContent = "ID,Task,Phase,Status,Timeline Status,Deadline\n";
      for (const t of criticalTasks) {
        const id = (t.display_task_id || "").replace(/"/g, '""');
        const name = (t.name || "").replace(/"/g, '""');
        const phase = (t.phase || "").replace(/"/g, '""');
        const status = (t.status || "").replace(/"/g, '""');
        const timelineStatus = (t.timeline_status || "").replace(/"/g, '""');
        const deadline = t.deadline || t.end_date || "";
        csvContent += `"${id}","${name}","${phase}","${status}","${timelineStatus}","${deadline}"\n`;
      }
      fname = `${baseName}_critical_tasks.csv`;
    }

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setPanelExportOpen("");
    showToast("success", "Exported CSV.");
  }

  async function saveCurrentProject() {
    const name = projectName.trim();
    if (!name) {
      showToast("error", "No project selected.");
      return;
    }
    if (!csvText.trim()) {
      showToast("error", "No CSV loaded for this project.");
      return;
    }
    try {
      setBusy(true);
      const res = await saveProject(name, csvText);
      showToast("success", `Saved project as "${res.registry_name}".`);
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
            const projectTitle = String((result as any).project_title || "").trim();
            closeGithubModal();
            setLayout(null);
            setTimelineStatus(null);
            setPlanId("");
            setFileName("github-project.csv");
            if (projectStart) setStartDate(projectStart);
            if (csv.trim()) {
              setCsvText(csv);
              // Update project name with the GitHub project title if available
              if (projectTitle) {
                setProjectName(projectTitle);
                // Update the active project record with the new name
                if (activeProjectId) {
                  setProjects((prev) =>
                    prev.map((p) =>
                      p.id === activeProjectId
                        ? { ...p, name: projectTitle }
                        : p
                    )
                  );
                }
              }
            }
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
        // Also update the project record with the normalized CSV
        if (activeProjectId) {
          setProjects((prev) =>
            prev.map((p) =>
              p.id === activeProjectId ? { ...p, csvText: created.normalized_csv_text } : p
            )
          );
        }
      }

      // Update project metadata from CSV headers
      if (created.metadata && activeProjectId) {
        setProjects((prev) =>
          prev.map((p) =>
            p.id === activeProjectId
              ? {
                  ...p,
                  projectHash: created.metadata?.project_hash ?? p.projectHash,
                  projectManager: created.metadata?.project_manager ?? p.projectManager,
                  techLead: created.metadata?.tech_lead ?? p.techLead,
                  client: created.metadata?.client ?? p.client,
                }
              : p
          )
        );
      }

      const scheduled = await schedulePlan({
        planId: created.plan_id,
        startDate,
        durationMode,
        workingDays,
      });

      setLayout(scheduled.layout);

      // Fetch timeline status for the critical tasks panel
      try {
        const tlStatus = await fetchTimelineStatus({ planId: created.plan_id });
        setTimelineStatus(tlStatus);
      } catch {
        // Non-fatal: timeline status is supplementary
        setTimelineStatus(null);
      }

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

      // Fetch timeline status for the critical tasks panel
      try {
        const tlStatus = await fetchTimelineStatus({ planId });
        setTimelineStatus(tlStatus);
      } catch {
        // Non-fatal: timeline status is supplementary
        setTimelineStatus(null);
      }
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
    if (suppressAutoScheduleRef.current) return;
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
            title="Dashboard"
          >
            {!navCollapsed ? "Dashboard" : "Dash"}
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
          <button type="button" className="navItem" onClick={() => setViewOptionsModalOpen(true)} title="View Options">
            {!navCollapsed ? "View Options" : "Options"}
          </button>
        </div>
      </aside>

      <main className="appMain">
        {activePage === "editProject" ? (
          <div className="container">
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
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
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => void openEditMetadataModal()}
              disabled={busy || !csvText.trim()}
              style={secondaryButtonStyle}
              title="Edit project metadata"
            >
              Edit
            </button>
            <button type="button" onClick={() => void saveCurrentProject()} disabled={busy || !csvText.trim()} style={secondaryButtonStyle}>
              Save
            </button>
            <button type="button" onClick={openExportProjectModal} disabled={busy} style={secondaryButtonStyle}>
              Export
            </button>
          </div>
        </div>

        {kanlyticsOpen && (() => {
          // Collect all unique labels from tasks
          const allLabels = new Set<string>();
          if (layout?.tasks) {
            for (const t of layout.tasks) {
              if (t.labels) {
                for (const label of t.labels) {
                  allLabels.add(label);
                }
              }
            }
          }
          const sortedLabels = Array.from(allLabels).sort((a, b) => a.localeCompare(b));
          
          const labelStyle: React.CSSProperties = { padding: "4px 16px 4px 0", color: "var(--muted)", whiteSpace: "nowrap", verticalAlign: "top" };
          const valueStyle: React.CSSProperties = { padding: "4px 0" };
          
          return (
            <table style={{ marginTop: 12, borderCollapse: "collapse", fontSize: 14 }}>
              <tbody>
                <tr>
                  <td style={labelStyle}>Project Hash</td>
                  <td className="mono" style={{ ...valueStyle, fontSize: 12, color: "var(--muted)" }}>{activeProject?.projectHash || "—"}</td>
                </tr>
                <tr>
                  <td style={labelStyle}>Project Manager</td>
                  <td style={valueStyle}>{activeProject?.projectManager || "—"}</td>
                </tr>
                <tr>
                  <td style={labelStyle}>Tech Lead</td>
                  <td style={valueStyle}>{activeProject?.techLead || "—"}</td>
                </tr>
                <tr>
                  <td style={labelStyle}>Client</td>
                  <td style={valueStyle}>{activeProject?.client || "—"}</td>
                </tr>
                <tr>
                  <td style={labelStyle}>Start Date</td>
                  <td className="mono" style={valueStyle}>{startDate || "—"}</td>
                </tr>
                <tr>
                  <td style={labelStyle}>Schedule</td>
                  <td style={valueStyle}>{workingDays ? "Working days (Mon–Fri)" : "Calendar days"}</td>
                </tr>
                <tr>
                  <td style={labelStyle}>Labels</td>
                  <td style={valueStyle}>
                    {sortedLabels.length > 0 ? (
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {sortedLabels.map((label) => (
                          <span
                            key={label}
                            style={{
                              padding: "2px 8px",
                              borderRadius: 12,
                              background: "var(--bg)",
                              border: "1px solid var(--border)",
                              fontSize: 12,
                            }}
                          >
                            {label}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>—</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          );
        })()}

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

            {/* Milestones Panel */}
            {layout && (() => {
              const milestones = layout.tasks.filter(t => (t.durations?.wall ?? 1) === 0);
              if (milestones.length === 0) return null;
              milestones.sort((a, b) => (a.schedule.start || "").localeCompare(b.schedule.start || ""));
              return (
                <div className="card" style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>Milestones</div>
                    <button
                      type="button"
                      onClick={() => setPanelExportOpen("milestones")}
                      style={secondaryButtonStyle}
                    >
                      Export
                    </button>
                  </div>
                  <div ref={milestonesRef} style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
                          <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--muted-2)" }}>ID</th>
                          <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--muted-2)" }}>Milestone</th>
                          <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--muted-2)" }}>Phase</th>
                          <th style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: "var(--muted-2)" }}>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {milestones.map((m, idx) => (
                          <tr key={m.id} style={{ background: idx % 2 === 0 ? "var(--card)" : "var(--bg)", borderBottom: idx < milestones.length - 1 ? "1px solid var(--border)" : "none" }}>
                            <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>
                              <span style={{ marginRight: 6 }}>◆</span>
                              <span className="mono">{m.display_task_id || "—"}</span>
                            </td>
                            <td style={{ padding: "6px 10px", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {m.name || m.title || "(untitled)"}
                            </td>
                            <td style={{ padding: "6px 10px", color: "var(--muted)", whiteSpace: "nowrap" }}>{m.phase || "—"}</td>
                            <td className="mono" style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>{m.schedule.start || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* Critical Tasks Panel */}
            {layout && timelineStatus && (() => {
              // Filter tasks that are Delayed or Critically Delayed
              const criticalTasks = timelineStatus.tasks.filter(t => 
                t.timeline_status === "Delayed" || t.timeline_status === "Critically Delayed"
              );
              
              if (criticalTasks.length === 0) return null;
              
              // Sort: Critically Delayed first, then by deadline
              criticalTasks.sort((a, b) => {
                // Critically Delayed tasks first
                if (a.timeline_status === "Critically Delayed" && b.timeline_status !== "Critically Delayed") return -1;
                if (a.timeline_status !== "Critically Delayed" && b.timeline_status === "Critically Delayed") return 1;
                // Then by deadline
                const aDeadline = a.deadline || a.end_date || "";
                const bDeadline = b.deadline || b.end_date || "";
                return aDeadline.localeCompare(bDeadline);
              });
              
              const getTimelineStatusStyle = (status: string) => {
                switch (status) {
                  case "Critically Delayed":
                    return { color: "var(--gantt-critical)", fontWeight: 600 };
                  case "Delayed":
                    return { color: "var(--toast-error-text)" };
                  default:
                    return {};
                }
              };
              
              return (
                <div className="card" style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--gantt-critical)" }}>
                      Critical Tasks
                    </div>
                    <button
                      type="button"
                      onClick={() => setPanelExportOpen("criticalTasks")}
                      style={secondaryButtonStyle}
                    >
                      Export
                    </button>
                  </div>
                  <div ref={criticalTasksRef} style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
                          <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--muted-2)" }}>ID</th>
                          <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--muted-2)" }}>Task</th>
                          <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--muted-2)" }}>Phase</th>
                          <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--muted-2)" }}>Status</th>
                          <th style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--muted-2)" }}>Timeline Status</th>
                          <th style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: "var(--muted-2)" }}>Deadline</th>
                        </tr>
                      </thead>
                      <tbody>
                        {criticalTasks.map((t, idx) => {
                          const isCriticallyDelayed = t.timeline_status === "Critically Delayed";
                          
                          return (
                            <tr
                              key={t.task_id}
                              style={{
                                background: isCriticallyDelayed ? "var(--toast-error-bg)" : (idx % 2 === 0 ? "var(--card)" : "var(--bg)"),
                                borderBottom: idx < criticalTasks.length - 1 ? "1px solid var(--border)" : "none",
                              }}
                            >
                              <td className="mono" style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{t.display_task_id || "—"}</td>
                              <td style={{ padding: "6px 10px", maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {t.name || "(untitled)"}
                              </td>
                              <td style={{ padding: "6px 10px", color: "var(--muted)", whiteSpace: "nowrap" }}>{t.phase || "—"}</td>
                              <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{t.status || "Backlog"}</td>
                              <td style={{ padding: "6px 10px", whiteSpace: "nowrap", ...getTimelineStatusStyle(t.timeline_status) }}>
                                {t.timeline_status}
                              </td>
                              <td className="mono" style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap", color: isCriticallyDelayed ? "var(--toast-error-text)" : "inherit" }}>
                                {t.deadline || t.end_date || "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* Project Timeline */}
            <div className="card">
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Project Timeline</div>
              {!layout ? (
                <div className="small">
                  No project loaded yet. Use <b>Import Project</b> to load a CSV or pull from GitHub to see the project view.
                </div>
              ) : (
                <div className="ganttShell">
                  <GanttChart
                    layout={layout}
                    exportId={activeProjectId}
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
                    suppressInfoPanel={exportingPng}
                    phaseFilter={phaseFilter}
                    onPhaseFilterChange={setPhaseFilter}
                    extraPhases={activeProject?.phases || []}
                    phaseMajors={activeProject?.phaseMajors || {}}
                    onAddPhase={openAddPhaseModal}
                    onAddTask={openCreateTaskModal}
                    onEditTask={(taskId) => {
                      openEditTaskModal(taskId);
                    }}
                    onDeleteTask={(taskId) => {
                      void deleteTaskAndReschedule(taskId);
                    }}
                    onDeletePhase={(phase) => {
                      void deletePhaseAndReschedule(phase);
                    }}
                    onFetchPhaseMeta={async (phase) => {
                      const repo = (issueRepo || "").trim();
                      if (!repo) throw new Error("No default repo set for this project.");
                      const pn = (activeProject?.name || projectName || "").trim() || "Project";
                      if (projectUrl.trim()) {
                        return await getPhaseMeta({ projectUrl: projectUrl.trim(), phase, issueRepo: repo });
                      }
                      return await getPhaseMetaCsv({ repo, projectName: pn, csvText, phase });
                    }}
                    onSavePhaseMeta={async (phase, description) => {
                      const repo = (issueRepo || "").trim();
                      if (!repo) throw new Error("No default repo set for this project.");
                      const pn = (activeProject?.name || projectName || "").trim() || "Project";
                      if (projectUrl.trim()) {
                        return await updatePhaseMeta({
                          projectUrl: projectUrl.trim(),
                          phase,
                          description,
                          issueRepo: repo,
                        });
                      }
                      return await updatePhaseMetaCsv({ repo, projectName: pn, csvText, phase, description });
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="container">
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12 }}>
                <div style={{ fontSize: 18, fontWeight: 800 }}>All Projects</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button type="button" style={secondaryButtonStyle} onClick={() => openNewProjectModal()}>
                    New Project
                  </button>
                  <button type="button" style={secondaryButtonStyle} onClick={() => openLoadProjectModal()}>
                    Import Project
                  </button>
                </div>
              </div>
              {projects.length === 0 ? (
                <div className="small">No projects yet. Click "New Project" or "Import Project" to get started.</div>
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
                            onClick={() => {
                              void openProjectById(p.id);
                            }}
                            title="Open in Edit Project"
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            style={secondaryButtonStyle}
                            onClick={() => {
                              const name = p.name || "(untitled)";
                              const ok = window.confirm(`Delete project "${name}"? This cannot be undone.`);
                              if (!ok) return;
                              setProjects((prev) => prev.filter((x) => x.id !== p.id));
                              if (activeProjectId === p.id) {
                                setActiveProjectId("");
                                setProjectName("");
                                setFileName("");
                                setCsvText("");
                                setLayout(null);
                                setTimelineStatus(null);
                                setPlanId("");
                              }
                            }}
                            title="Delete project"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card" style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <div style={{ fontSize: 18, fontWeight: 800 }}>Project View</div>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => void exportJointProjectViewAsPng()}
                  disabled={busy || allProjectsSelectedIds.length === 0}
                  title="Export the combined view as PNG"
                >
                  Export PNG
                </button>
              </div>
              {projects.length === 0 ? (
                <div className="small">No projects to show yet.</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ position: "relative", minWidth: 320 }} onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => setAllProjectsPickerOpen((v) => !v)}
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
                        title={allProjectsPickerLabel}
                      >
                        {allProjectsPickerLabel}
                      </button>
                      {allProjectsPickerOpen ? (
                        <div
                          style={{
                            position: "absolute",
                            zIndex: 10,
                            top: 48,
                            left: 0,
                            right: 0,
                            background: "var(--card)",
                            border: "1px solid var(--border)",
                            borderRadius: 12,
                            padding: 10,
                            boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
                            maxHeight: 320,
                            overflow: "auto",
                          }}
                        >
                          <div className="label" style={{ marginBottom: 6 }}>
                            Filter
                          </div>
                          <input value={allProjectsQuery} onChange={(e) => setAllProjectsQuery(e.target.value)} placeholder="Type to filter projects…" />
                          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                            <button
                              type="button"
                              style={secondaryButtonStyle}
                              onClick={() => setAllProjectsSelectedIds(projects.map((p) => p.id))}
                            >
                              Select all
                            </button>
                            <button type="button" style={secondaryButtonStyle} onClick={() => setAllProjectsSelectedIds([])}>
                              Clear
                            </button>
                          </div>
                          <div style={{ height: 1, background: "var(--border)", margin: "10px 0" }} />
                          {filteredAllProjects.map((p) => {
                            const checked = allProjectsSelectedIds.includes(p.id);
                            return (
                              <label key={p.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 6px", cursor: "pointer" }}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setAllProjectsSelectedIds((prev) => {
                                      const next = prev.slice();
                                      const idx = next.indexOf(p.id);
                                      if (idx >= 0) next.splice(idx, 1);
                                      else next.push(p.id);
                                      return next;
                                    });
                                  }}
                                />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name || "(untitled)"}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {allProjectsSelectedIds.length === 0 ? (
                    <div className="small" style={{ marginTop: 10 }}>
                      Select one or more projects to render their Gantt charts below.
                    </div>
                  ) : (
                    <div
                      ref={allProjectsExportRef}
                      style={{
                        display: "grid",
                        gap: 12,
                        marginTop: 12,
                        gridTemplateColumns: "repeat(auto-fit, minmax(860px, 1fr))",
                        alignItems: "start",
                      }}
                    >
                      {allProjectsSelectedIdsSorted.map((pid) => {
                        const p = projects.find((x) => x.id === pid);
                        if (!p) return null;
                        const layout = allProjectsLayoutsById[pid];
                        const err = allProjectsErrorsById[pid];
                        return (
                          <div key={pid} style={{ minWidth: 0 }}>
                            {/* Don't duplicate the project title here; the chart's "Project" row already shows it. */}
                            {err ? (
                              <div className="small" style={{ marginTop: 8, color: "var(--toast-error-text)" }}>
                                {err}
                              </div>
                            ) : null}
                            {!layout ? (
                              <div className="small" style={{ marginTop: 8 }}>
                                Loading…
                              </div>
                            ) : (
                              <div className="ganttShell" style={{ marginTop: 8 }}>
                                <GanttChart
                                  layout={layout}
                                  exportId={pid}
                                  pxPerDay={pxPerDay}
                                  rowHeight={28}
                                  showDeps={showDeps}
                                  showDailyGrid={showDailyGrid}
                                  showCriticalPath={showCriticalPath}
                                  timeAxisMode={timeAxisMode}
                                  phaseLayout={phaseLayout}
                                  barPadPx={barPadPx}
                                  projectName={p.name}
                                  detailMode={detailMode}
                                  suppressInfoPanel={exportingPng}
                                  hideHeader={true}
                                  axisBaseDate={sharedAxis?.axisBaseDate}
                                  axisMaxXDay={sharedAxis?.axisMaxXDay}
                                  onFetchPhaseMeta={async (phase) => {
                                    const repo = (p.issueRepo || "").trim();
                                    if (!repo) throw new Error("No default repo set for this project.");
                                    const pn = (p.name || "").trim() || "Project";
                                    const csv = String((projects.find((x) => x.id === pid)?.csvText || "") ?? "");
                                    if ((p.projectUrl || "").trim()) {
                                      return await getPhaseMeta({ projectUrl: (p.projectUrl || "").trim(), phase, issueRepo: repo });
                                    }
                                    return await getPhaseMetaCsv({ repo, projectName: pn, csvText: csv, phase });
                                  }}
                                  onSavePhaseMeta={async (phase, description) => {
                                    const repo = (p.issueRepo || "").trim();
                                    if (!repo) throw new Error("No default repo set for this project.");
                                    const pn = (p.name || "").trim() || "Project";
                                    const csv = String((projects.find((x) => x.id === pid)?.csvText || "") ?? "");
                                    if ((p.projectUrl || "").trim()) {
                                      return await updatePhaseMeta({
                                        projectUrl: (p.projectUrl || "").trim(),
                                        phase,
                                        description,
                                        issueRepo: repo,
                                      });
                                    }
                                    return await updatePhaseMetaCsv({ repo, projectName: pn, csvText: csv, phase, description });
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
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

        {/* Panel Export Modal (Milestones / Critical Tasks) */}
        {panelExportOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label={`Export ${panelExportOpen === "milestones" ? "Milestones" : "Critical Tasks"}`}
            onClick={() => setPanelExportOpen("")}
          >
            <div className="modalCard" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
              <div className="modalHeader">
                <div>Export {panelExportOpen === "milestones" ? "Milestones" : "Critical Tasks"}</div>
                <button
                  type="button"
                  onClick={() => setPanelExportOpen("")}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <div style={{ padding: "8px 0" }}>
                <div className="small" style={{ marginBottom: 12 }}>
                  Choose export format:
                </div>
              </div>
              <div className="modalActions">
                <button type="button" onClick={() => setPanelExportOpen("")} style={secondaryButtonStyle}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void exportPanelAsPng(panelExportOpen)}
                  disabled={busy}
                  style={secondaryButtonStyle}
                >
                  PNG
                </button>
                <button
                  type="button"
                  onClick={() => exportPanelAsCsv(panelExportOpen)}
                  disabled={busy}
                  style={secondaryButtonStyle}
                >
                  CSV
                </button>
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
                    <div className="label">Project</div>
                    <input value={activeProject?.name || ""} disabled placeholder="No active project" />
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
                <button type="button" onClick={() => void exportCurrentGanttAsPng()} disabled={busy || !layout} style={secondaryButtonStyle}>
                  PNG
                </button>
                <button
                  type="button"
                  onClick={() => void runExportSelectedProject()}
                  disabled={busy || !activeProjectId || !exportTarget.trim()}
                  style={secondaryButtonStyle}
                >
                  Export
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {addPhaseOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Add phase"
            onClick={() => setAddPhaseOpen(false)}
          >
            <div className="modalCard" onClick={(e) => e.stopPropagation()}>
              <div className="modalHeader">
                <div>Add Phase</div>
                <button
                  type="button"
                  onClick={() => setAddPhaseOpen(false)}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div style={{ display: "grid", gap: 10 }}>
                <div>
                  <div className="label">Phase name</div>
                  <input
                    value={addPhaseName}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAddPhaseName(v);
                      if (addPhaseError && v.trim()) setAddPhaseError("");
                    }}
                    placeholder="e.g. Design, Build, Test…"
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      createPhase();
                    }}
                    style={addPhaseError ? { borderColor: "var(--toast-error-border)" } : undefined}
                  />
                  {addPhaseError ? (
                    <div className="small" style={{ marginTop: 6, color: "var(--toast-error-text)" }}>
                      {addPhaseError}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="modalActions">
                <button type="button" onClick={() => setAddPhaseOpen(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
                <button type="button" onClick={createPhase} style={secondaryButtonStyle}>
                  Add
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {createTaskOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Create task"
            onClick={() => setCreateTaskOpen(false)}
          >
            <div
              className="modalCard"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(1100px, 100%)",
                maxWidth: 1100,
                maxHeight: "calc(100vh - 36px)",
                overflow: "auto",
              }}
            >
              <div className="modalHeader">
                <div>Create new task</div>
                <button
                  type="button"
                  onClick={() => setCreateTaskOpen(false)}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div style={{ display: "grid", gap: 14 }}>
                <div>
                  <div className="label">Add a title *</div>
                  <input
                    value={createTaskTitle}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCreateTaskTitle(v);
                      if (createTaskTitleError && v.trim()) setCreateTaskTitleError("");
                    }}
                    placeholder="[Task] <Title of the task>"
                    style={createTaskTitleError ? { borderColor: "var(--toast-error-border)" } : undefined}
                  />
                  {createTaskTitleError ? (
                    <div className="small" style={{ marginTop: 6, color: "var(--toast-error-text)" }}>
                      {createTaskTitleError}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <div className="label">Phase</div>
                    <input value={createTaskPhase} disabled />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <div className="label">Wall days</div>
                      <input
                        type="text"
                        value={String(createTaskWallDays)}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) setCreateTaskWallDays(n);
                        }}
                      />
                    </div>
                    <div>
                      <div className="label">Billable days</div>
                      <input
                        type="text"
                        value={String(createTaskBillableDays)}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) setCreateTaskBillableDays(n);
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <div className="label">Repo *</div>
                  <input
                    value={createTaskRepo}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCreateTaskRepo(v);
                      if (createTaskRepoError && v.trim()) setCreateTaskRepoError("");
                    }}
                    placeholder="owner/repo (defaults to project default repo)"
                    style={createTaskRepoError ? { borderColor: "var(--toast-error-border)" } : undefined}
                  />
                  {createTaskRepoError ? (
                    <div className="small" style={{ marginTop: 6, color: "var(--toast-error-text)" }}>
                      {createTaskRepoError}
                    </div>
                  ) : null}
                  <div className="small" style={{ marginTop: 6, color: "var(--muted-2)" }}>
                    Used when creating issues on Push. For existing GitHub issues, repo is implied by the issue URL.
                  </div>
                </div>

                {(() => {
                  // Check if this is an existing GitHub issue (has URL)
                  const editingTask = editingTaskId ? (layout?.tasks || []).find((x) => x.id === editingTaskId) : null;
                  const hasUrl = Boolean(editingTask?.url && String(editingTask.url).trim());
                  const isExistingIssue = createTaskMode === "edit" && hasUrl;
                  
                  return (
                    <>
                      <div>
                        <div className="label">{isExistingIssue ? "Details" : "Description"}</div>
                        <div
                          style={{
                            border: "1px solid var(--border-2)",
                            borderRadius: 10,
                            overflow: "hidden",
                            background: "var(--input-bg)",
                          }}
                        >
                          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
                            <button
                              type="button"
                              onClick={() => setCreateTaskBodyTab("write")}
                              style={{
                                padding: "8px 10px",
                                border: "none",
                                background: createTaskBodyTab === "write" ? "var(--selected-row-bg)" : "transparent",
                                color: "var(--text)",
                                cursor: "pointer",
                                fontWeight: 700,
                              }}
                            >
                              Write
                            </button>
                            <button
                              type="button"
                              onClick={() => setCreateTaskBodyTab("preview")}
                              style={{
                                padding: "8px 10px",
                                border: "none",
                                background: createTaskBodyTab === "preview" ? "var(--selected-row-bg)" : "transparent",
                                color: "var(--text)",
                                cursor: "pointer",
                                fontWeight: 700,
                              }}
                            >
                              Preview
                            </button>
                          </div>
                          {createTaskBodyTab === "write" ? (
                            <textarea
                              value={createTaskBody}
                              onChange={(e) => setCreateTaskBody(e.target.value)}
                              placeholder={isExistingIssue ? "Edit the issue body directly. Use ### Description and ### Acceptance Criteria sections if needed." : "What needs to be done and why it matters. Include any relevant context or links."}
                              style={{
                                width: "100%",
                                minHeight: 320,
                                padding: 10,
                                border: "none",
                                outline: "none",
                                background: "transparent",
                                color: "var(--text)",
                                resize: "vertical",
                              }}
                            />
                          ) : (
                            <div style={{ padding: 10, minHeight: 320, overflow: "auto" }}>
                              {createTaskBody.trim() ? (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{createTaskBody}</ReactMarkdown>
                              ) : (
                                <div className="small">Nothing to preview.</div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {!isExistingIssue ? (
                        <div>
                          <div className="label">Acceptance Criteria</div>
                  <div
                    style={{
                      border: "1px solid var(--border-2)",
                      borderRadius: 10,
                      overflow: "hidden",
                      background: "var(--input-bg)",
                    }}
                  >
                    <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
                      <button
                        type="button"
                        onClick={() => setCreateTaskAcceptanceTab("write")}
                        style={{
                          padding: "8px 10px",
                          border: "none",
                          background: createTaskAcceptanceTab === "write" ? "var(--selected-row-bg)" : "transparent",
                          color: "var(--text)",
                          cursor: "pointer",
                          fontWeight: 700,
                        }}
                      >
                        Write
                      </button>
                      <button
                        type="button"
                        onClick={() => setCreateTaskAcceptanceTab("preview")}
                        style={{
                          padding: "8px 10px",
                          border: "none",
                          background: createTaskAcceptanceTab === "preview" ? "var(--selected-row-bg)" : "transparent",
                          color: "var(--text)",
                          cursor: "pointer",
                          fontWeight: 700,
                        }}
                      >
                        Preview
                      </button>
                    </div>
                    {createTaskAcceptanceTab === "write" ? (
                      <textarea
                        value={createTaskAcceptance}
                        onChange={(e) => setCreateTaskAcceptance(e.target.value)}
                        placeholder="- Condition 1\n- Condition 2"
                        style={{
                          width: "100%",
                          minHeight: 120,
                          padding: 10,
                          border: "none",
                          outline: "none",
                          background: "transparent",
                          color: "var(--text)",
                          resize: "vertical",
                        }}
                      />
                    ) : (
                      <div style={{ padding: 10, minHeight: 120, overflow: "auto" }}>
                        {createTaskAcceptance.trim() ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{createTaskAcceptance}</ReactMarkdown>
                        ) : (
                          <div className="small">Nothing to preview.</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                      ) : null}
                    </>
                  );
                })()}

                <div>
                  <div className="label">Dependencies</div>
                  <input
                    value={createTaskDepQuery}
                    onChange={(e) => setCreateTaskDepQuery(e.target.value)}
                    placeholder="Search tasks by ID/title/phase…"
                  />
                  <div style={{ marginTop: 10, maxHeight: 240, overflow: "auto", border: "1px solid var(--border)", borderRadius: 12 }}>
                    {dependencyCandidates.map((t) => {
                      const key = t.display_id || t.display_task_id || t.id;
                      const checked = createTaskDeps.includes(t.id);
                      return (
                        <label
                          key={t.id}
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                            padding: "8px 10px",
                            borderBottom: "1px solid var(--border)",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setCreateTaskDeps((prev) => {
                                const s = new Set(prev);
                                if (s.has(t.id)) s.delete(t.id);
                                else s.add(t.id);
                                return Array.from(s);
                              });
                            }}
                          />
                          <span className="mono" style={{ width: 64, flex: "0 0 auto", color: "var(--muted-2)" }}>
                            {key}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {(t.title || t.name) + (t.phase ? ` — ${t.phase}` : "")}
                          </span>
                        </label>
                      );
                    })}
                    {dependencyCandidates.length === 0 ? (
                      <div className="small" style={{ padding: 10 }}>
                        No tasks match.
                      </div>
                    ) : null}
                  </div>
                  <div className="small" style={{ marginTop: 8 }}>
                    Tip: dependencies are selected from existing tasks (by Task ID) so they sync cleanly with scheduling.
                  </div>
                </div>
              </div>

              <div className="modalActions">
                <button type="button" onClick={() => setCreateTaskOpen(false)} style={secondaryButtonStyle} disabled={busy}>
                  Cancel
                </button>
                {createTaskMode === "edit" ? (
                  <button type="button" onClick={() => void saveEditedTask()} style={secondaryButtonStyle} disabled={busy}>
                    Save
                  </button>
                ) : (
                  <button type="button" onClick={() => void createTask()} style={secondaryButtonStyle} disabled={busy}>
                    Create
                  </button>
                )}
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
                  <input
                    value={newProjectName}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNewProjectName(v);
                      if (newProjectNameError && v.trim()) setNewProjectNameError("");
                    }}
                    placeholder="e.g. Client – Plant – Station"
                    style={newProjectNameError ? { borderColor: "var(--toast-error-border)" } : undefined}
                  />
                  {newProjectNameError ? (
                    <div className="small" style={{ marginTop: 6, color: "var(--toast-error-text)" }}>
                      {newProjectNameError}
                    </div>
                  ) : null}
                </div>
                <div>
                  <div className="label">Project Hash</div>
                  <input
                    value={newProjectHash}
                    readOnly
                    className="mono"
                    style={{ fontSize: 12, color: "var(--muted)", backgroundColor: "var(--bg-2)" }}
                  />
                  <div className="small" style={{ marginTop: 6, color: "var(--muted-2)" }}>
                    Auto-generated unique identifier for this project.
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <div>
                    <div className="label">Project Manager (PM)</div>
                    <input
                      value={newProjectManager}
                      onChange={(e) => setNewProjectManager(e.target.value)}
                      placeholder="PM name"
                    />
                  </div>
                  <div>
                    <div className="label">Tech Lead (TL)</div>
                    <input
                      value={newProjectTechLead}
                      onChange={(e) => setNewProjectTechLead(e.target.value)}
                      placeholder="TL name"
                    />
                  </div>
                  <div>
                    <div className="label">Client</div>
                    <input
                      value={newProjectClient}
                      onChange={(e) => setNewProjectClient(e.target.value)}
                      placeholder="Client name"
                    />
                  </div>
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
                <div>
                  <div className="label">Default repo *</div>
                  <input
                    value={newProjectDefaultRepo}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNewProjectDefaultRepo(v);
                      if (newProjectDefaultRepoError && v.trim()) setNewProjectDefaultRepoError("");
                    }}
                    placeholder="owner/repo"
                    style={newProjectDefaultRepoError ? { borderColor: "var(--toast-error-border)" } : undefined}
                  />
                  {newProjectDefaultRepoError ? (
                    <div className="small" style={{ marginTop: 6, color: "var(--toast-error-text)" }}>
                      {newProjectDefaultRepoError}
                    </div>
                  ) : null}
                </div>
                <div>
                  <div className="label">Template CSV (optional)</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input
                      type="file"
                      ref={newProjectTemplateFileInputRef}
                      accept=".csv,text/csv"
                      disabled={busy}
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        void (async () => {
                          try {
                            setBusy(true);
                            const text = await f.text();
                            setNewProjectTemplateFileName(f.name);
                            setNewProjectTemplatePath(f.name);
                            setNewProjectTemplateCsvText(text);
                          } finally {
                            setBusy(false);
                          }
                        })();
                      }}
                    />
                    <input
                      value={newProjectTemplatePath}
                      onChange={(e) => {
                        setNewProjectTemplatePath(e.target.value);
                        setNewProjectTemplateCsvText("");
                        setNewProjectTemplateFileName("");
                      }}
                      placeholder="~/path/to/template.csv"
                      disabled={busy}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => newProjectTemplateFileInputRef.current?.click()}
                      disabled={busy}
                      style={{ ...secondaryButtonStyle, height: 44, paddingTop: 0, paddingBottom: 0 }}
                    >
                      Select File
                    </button>
                  </div>
                  <div className="small" style={{ marginTop: 6, color: "var(--muted-2)" }}>
                    If provided, the project will start with this CSV loaded. Otherwise you’ll start with an empty chart and can add phases/tasks.
                  </div>
                </div>
              </div>

              <div className="modalActions">
                <button type="button" onClick={() => setNewProjectOpen(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
                <button type="button" onClick={() => void createNewProject()} style={secondaryButtonStyle} disabled={busy}>
                  Create
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {editMetadataOpen ? (
          <div
            className="modalBackdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Edit project metadata"
            onClick={() => setEditMetadataOpen(false)}
          >
            <div className="modalCard" onClick={(e) => e.stopPropagation()}>
              <div className="modalHeader">
                <div>Edit Project Metadata</div>
                <button
                  type="button"
                  onClick={() => setEditMetadataOpen(false)}
                  style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--text)" }}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <div>
                    <div className="label">Project Manager (PM)</div>
                    <input
                      value={editMetadataManager}
                      onChange={(e) => setEditMetadataManager(e.target.value)}
                      placeholder="PM name"
                    />
                  </div>
                  <div>
                    <div className="label">Tech Lead (TL)</div>
                    <input
                      value={editMetadataTechLead}
                      onChange={(e) => setEditMetadataTechLead(e.target.value)}
                      placeholder="TL name"
                    />
                  </div>
                  <div>
                    <div className="label">Client</div>
                    <input
                      value={editMetadataClient}
                      onChange={(e) => setEditMetadataClient(e.target.value)}
                      placeholder="Client name"
                    />
                  </div>
                </div>
              </div>

              <div className="modalActions">
                <button type="button" onClick={() => setEditMetadataOpen(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
                <button type="button" onClick={() => void saveMetadata()} style={secondaryButtonStyle} disabled={busy}>
                  Save
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
                    if (selectProjectId) void openProjectById(selectProjectId);
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
                  <select value={timeAxisMode} onChange={(e) => {
                    const newMode = e.target.value as any;
                    console.log(`[App] Time axis changed: ${timeAxisMode} -> ${newMode}`);
                    setTimeAxisMode(newMode);
                  }}>
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
                  <div className="label">Multi-project time axis</div>
                  <select
                    value={multiProjectSharedAxis ? "shared" : "individual"}
                    onChange={(e) => setMultiProjectSharedAxis(e.target.value === "shared")}
                  >
                    <option value="individual">Individual axes</option>
                    <option value="shared">Shared axis</option>
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
