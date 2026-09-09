export type Member = {
  key: string;
  name: string;
  role: string;
  kind: "ai" | "human";
  responsibilities: string[];
  instructions: string;
  skills: string[];
  inputs: string[];
  outputs: string[];
};
export type Step = {
  key: string;
  name: string;
  owner: string;
  kind: "work" | "review" | "approval";
  depends_on: string[];
  input: string;
  output: string;
  acceptance: string;
};
export type Draft = {
  human_routing?: {
    default_owner?: string | null;
    assignments?: Record<string, string>;
  } | null;
  name: string;
  goal: string;
  members: Member[];
  workflow: Step[];
  requirements: { name: string; description: string; blocking: boolean }[];
  assumptions: string[];
  questions: string[];
  ready: boolean;
};
export type Job = {
  created_at?: string;
  finished_at?: string | null;
  id: string;
  status: string;
  error: string;
  logs: { at: string; message: string }[];
  usage: Record<string, number>;
  proposal?: { reply: string; draft: Draft | null };
};
export type Employee = {
  id: string;
  design_id: string;
  key: string;
  profile: Member;
  files: Record<string, string>;
  version: number;
  active: boolean;
};
export type Design = {
  id: string;
  title: string;
  version: number;
  draft: Partial<Draft>;
  updated_at: string;
  codex_conversation?: { thread_id: string; imported_messages: number } | null;
  messages?: import("./chat/types").ChatMessage[];
  jobs?: Job[];
  employees?: Employee[];
};
export type Project = {
  id: string;
  design_id: string;
  title: string;
  status: string;
  design_version: number;
  snapshot: {
    team: Draft;
    employees: Pick<Employee, "id" | "version" | "profile" | "files">[];
  };
  created_at: string;
};
export type Runtime = {
  available: boolean;
  logged_in: boolean;
  version: string;
  login: string;
};
