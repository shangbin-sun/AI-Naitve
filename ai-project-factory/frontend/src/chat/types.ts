import type { ChatAttachment } from "./attachments";
export type ChatMessage = {
  id: string;
  role: string;
  content: string;
  employee_reference?: { id: string; name: string } | null;
  attachments?: ChatAttachment[];
  timing?: {
    started_at: string;
    finished_at?: string | null;
    running?: boolean;
  } | null;
};
