export type LayoutMeta = {
  project_start: string;
  duration_mode: "wall" | "billable" | string;
  working_days: boolean;
  weekmask?: number[];
  critical_path?: string[];
};

export type TaskLayout = {
  start: string;
  end: string;
  row: number;
  x: number;
  w: number;
};

export type TaskItem = {
  id: string;
  display_id?: string;
  display_task_id?: string | null;
  task_id?: string | null;
  url?: string | null;
  number?: number | null;
  state?: string | null;
  labels?: string[];
  assignees?: string[];
  phase: string;
  status?: string | null;
  name: string;
  title?: string;
  details?: string;
  body?: string;
  milestone_or_output?: string;
  acceptance_criteria?: string;
  dependencies: string[];
  roles?: Record<string, unknown>;
  notes?: string;
  durations?: { wall: number; billable: number };
  start_date?: string | null;
  end_date?: string | null;
  slack_days?: number;
  is_critical?: boolean;
  schedule: TaskLayout;
};

export type Edge = { from: string; to: string };

export type GanttLayout = {
  meta: LayoutMeta;
  tasks: TaskItem[];
  edges: Edge[];
};

export type CreatePlanResponse = { plan_id: string; task_count: number; normalized_csv_text: string };
export type ScheduleResponse = { plan_id: string; layout: GanttLayout };
export type LayoutResponse = { plan_id: string; layout: GanttLayout };

export type ConnectProjectResponse = { task_count: number; csv_text: string; project_start_date?: string | null };

export type LoadCsvPathResponse = { csv_text: string; file_name?: string | null };

export type SaveCsvPathResponse = { csv_path: string; bytes_written: number };

export type SaveProjectResponse = { project_name: string; registry_name: string };

export type LoadProjectResponse = { project_name: string; registry_name: string; csv_text: string; csv_path: string };

export type AppendTaskResponse = { csv_text: string; task_id: string };

export type UpdateTaskResponse = { csv_text: string };
export type DeleteTaskResponse = { csv_text: string; removed_task_ids: string[] };

export type ExportProjectResponse = {
  updated_issues: number;
  updated_draft_issues: number;
  created_draft_issues: number;
  added_existing_issues: number;
  errors: string[];
};

export type StartJobResponse = { job_id: string };

export type JobStatusResponse = {
  job_id: string;
  state: "queued" | "running" | "completed" | "failed";
  progress: number;
  message: string;
  result?: Record<string, any> | null;
  error?: string | null;
};
