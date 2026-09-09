import type { ChatImage } from "./attachments";
export type ChatMessage = {
  id: string;
  role: string;
  content: string;
  attachments?: ChatImage[];
};
