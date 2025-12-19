import type {
  CreatePlanResponse,
  ScheduleResponse,
  LayoutResponse,
  ConnectProjectResponse,
  ExportProjectResponse,
  StartJobResponse,
  JobStatusResponse,
  LoadCsvPathResponse,
  SaveCsvPathResponse,
  SaveProjectResponse,
  LoadProjectResponse,
  AppendTaskResponse,
  UpdateTaskResponse,
  DeleteTaskResponse,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function createPlan(csvText: string, projectName?: string): Promise<CreatePlanResponse> {
  return postJson<CreatePlanResponse>("gantt.create_plan", { csv_text: csvText, project_name: projectName });
}

export async function loadCsvFromPath(csvPath: string): Promise<LoadCsvPathResponse> {
  return postJson<LoadCsvPathResponse>("csv.load_path", { csv_path: csvPath });
}

export async function saveCsvToPath(csvPath: string, csvText: string): Promise<SaveCsvPathResponse> {
  return postJson<SaveCsvPathResponse>("csv.save_path", { csv_path: csvPath, csv_text: csvText });
}

export async function saveProject(projectName: string, csvText: string): Promise<SaveProjectResponse> {
  return postJson<SaveProjectResponse>("projects.save", { project_name: projectName, csv_text: csvText });
}

export async function loadProject(projectName: string): Promise<LoadProjectResponse> {
  return postJson<LoadProjectResponse>("projects.load", { project_name: projectName });
}

export async function appendTask(params: {
  csvText: string;
  projectName?: string;
  phase: string;
  title: string;
  body?: string;
  acceptanceCriteria?: string;
  dependencies?: string[];
  wallDays?: number;
  billableDays?: number;
  phaseMajor?: number;
}): Promise<AppendTaskResponse> {
  return postJson<AppendTaskResponse>("gantt.append_task", {
    csv_text: params.csvText,
    project_name: params.projectName,
    phase: params.phase,
    title: params.title,
    body: params.body,
    acceptance_criteria: params.acceptanceCriteria,
    dependencies: params.dependencies || [],
    wall_days: params.wallDays ?? 1,
    billable_days: params.billableDays ?? 1,
    phase_major: params.phaseMajor,
  });
}

export async function updateTask(params: {
  csvText: string;
  taskId: string;
  title?: string;
  body?: string;
  acceptanceCriteria?: string;
  dependencies?: string[];
  wallDays?: number;
  billableDays?: number;
}): Promise<UpdateTaskResponse> {
  return postJson<UpdateTaskResponse>("gantt.update_task", {
    csv_text: params.csvText,
    task_id: params.taskId,
    title: params.title,
    body: params.body,
    acceptance_criteria: params.acceptanceCriteria,
    dependencies: params.dependencies,
    wall_days: params.wallDays,
    billable_days: params.billableDays,
  });
}

export async function deleteTask(params: { csvText: string; taskId: string }): Promise<DeleteTaskResponse> {
  return postJson<DeleteTaskResponse>("gantt.delete_task", { csv_text: params.csvText, task_id: params.taskId });
}

export async function schedulePlan(params: {
  planId: string;
  startDate: string;
  durationMode?: "wall" | "billable";
  workingDays?: boolean;
}): Promise<ScheduleResponse> {
  return postJson<ScheduleResponse>("gantt.schedule", {
    plan_id: params.planId,
    start_date: params.startDate,
    duration_mode: params.durationMode ?? "wall",
    working_days: params.workingDays ?? false,
  });
}

export async function fetchLayout(planId: string): Promise<LayoutResponse> {
  return postJson<LayoutResponse>("gantt.layout", { plan_id: planId });
}

export async function connectProject(projectUrl: string): Promise<ConnectProjectResponse> {
  return postJson<ConnectProjectResponse>("github.connect_project", { project_url: projectUrl });
}

export async function exportProject(params: { planId: string; projectUrl: string }): Promise<ExportProjectResponse> {
  return postJson<ExportProjectResponse>("github.export_project", {
    plan_id: params.planId,
    project_url: params.projectUrl,
  });
}

export async function startConnectProject(projectUrl: string): Promise<StartJobResponse> {
  return postJson<StartJobResponse>("github.connect_project_start", { project_url: projectUrl });
}

export async function startExportProject(params: { planId: string; projectUrl: string; issueRepo?: string; projectName?: string }): Promise<StartJobResponse> {
  return postJson<StartJobResponse>("github.export_project_start", {
    plan_id: params.planId,
    project_url: params.projectUrl,
    issue_repo: params.issueRepo,
    project_name: params.projectName,
  });
}

export async function fetchJobStatus(jobId: string): Promise<JobStatusResponse> {
  return postJson<JobStatusResponse>("github.job_status", { job_id: jobId });
}
