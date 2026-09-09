import type { DeliveryAttempt } from "../DeliveryPanel";
export type TaskDefinition = {
  title: string;
  description: string;
  acceptance: string;
  code_source_id: string | null;
};
export type TaskRun = {
  id: string;
  status: string;
  design_version: number;
  created_at: string;
  error: string;
  inputs: {
    task_snapshot?: TaskDefinition & { version: number };
    team_snapshot?: {
      key: string;
      version: number;
      profile?: { name?: string };
    }[];
    employees?: { key: string; version: number; profile?: { name?: string } }[];
    previous_plan?: unknown;
    code_source_id?: string;
    resume_run_id?: string;
  };
  result: {
    stage?: string;
    summary?: string;
    events?: string[];
    attempts?: (DeliveryAttempt & {
      artifacts?: { path: string; content: string }[];
    })[];
    reference_tests?: Record<string, string>;
    plan?: unknown;
    planning_usage?: unknown;
    artifacts?: { path: string; content: string }[];
    workspace?: string;
  };
};
export type WorkTask = TaskDefinition & {
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
  run_count?: number;
  latest_run?: { status: string; stage?: string; summary?: string } | null;
  runs?: TaskRun[];
};
export type TaskSource = { id: string; title: string; kind: string };
