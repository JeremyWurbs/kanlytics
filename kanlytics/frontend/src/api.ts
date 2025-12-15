import type { CreatePlanResponse, ScheduleResponse, LayoutResponse } from "./types";

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

export async function createPlan(csvText: string): Promise<CreatePlanResponse> {
  return postJson<CreatePlanResponse>("gantt.create_plan", { csv_text: csvText });
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
