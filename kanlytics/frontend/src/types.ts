export type LayoutMeta = {
  project_start: string;
  duration_mode: "wall" | "billable" | string;
  working_days: boolean;
  weekmask?: number[];
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
  phase: string;
  name: string;
  details?: string;
  milestone_or_output?: string;
  dependencies: string[];
  roles?: Record<string, unknown>;
  notes?: string;
  durations?: { wall: number; billable: number };
  schedule: TaskLayout;
};

export type Edge = { from: string; to: string };

export type GanttLayout = {
  meta: LayoutMeta;
  tasks: TaskItem[];
  edges: Edge[];
};

export type CreatePlanResponse = { plan_id: string; task_count: number };
export type ScheduleResponse = { plan_id: string; layout: GanttLayout };
export type LayoutResponse = { plan_id: string; layout: GanttLayout };
