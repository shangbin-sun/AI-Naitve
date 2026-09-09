import type { AttachmentAdapter } from "@assistant-ui/react";
import { api } from "../api";

export type ChatAttachment = {
  id: string;
  name: string;
  content_type: string;
  url: string;
};
const accepted = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const textTypes: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
};

/** The UI only handles IDs and preview URLs; binary files belong to the server. */
export function createAttachmentAdapter(
  workspaceId: string,
  onError: (message: string) => void,
): AttachmentAdapter {
  return {
    accept: [...accepted, ".md", ".markdown", ".txt", ".csv", ".json"].join(
      ",",
    ),
    async add({ file }) {
      try {
        const contentType =
          textTypes[file.name.split(".").at(-1)?.toLowerCase() || ""] ||
          file.type;
        if (!accepted.includes(contentType) || file.size > 5 * 1024 * 1024)
          throw new Error(
            "支持图片、PDF、Word、Excel、CSV、JSON 等文件，每个不超过 5 MB",
          );
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error("附件读取失败，请重新选择"));
          reader.readAsDataURL(file);
        });
        const uploaded = await api<ChatAttachment>(
          `/workspaces/${workspaceId}/chat-attachments`,
          {
            method: "POST",
            body: JSON.stringify({
              name: file.name,
              data,
              content_type: contentType,
            }),
          },
        );
        return {
          id: uploaded.id,
          type: uploaded.content_type.startsWith("image/") ? "image" : "file",
          name: uploaded.name,
          contentType: uploaded.content_type,
          file,
          content: uploaded.content_type.startsWith("image/")
            ? [{ type: "image", image: uploaded.url }]
            : [],
          status: { type: "requires-action", reason: "composer-send" },
        };
      } catch (error) {
        onError((error as Error).message);
        throw error;
      }
    },
    async send(attachment) {
      return {
        ...attachment,
        status: { type: "complete" },
        content: attachment.content ?? [],
      };
    },
    async remove(attachment) {
      try {
        await api(
          `/workspaces/${workspaceId}/chat-attachments/${attachment.id}`,
          { method: "DELETE" },
        );
      } catch (error) {
        onError((error as Error).message);
        throw error;
      }
    },
  };
}
