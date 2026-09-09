import type { AttachmentAdapter } from "@assistant-ui/react";
import { api } from "../api";

export type ChatImage = {
  id: string;
  name: string;
  content_type: string;
  url: string;
};
const accepted = ["image/png", "image/jpeg", "image/webp"];

/** The UI only handles IDs and preview URLs; binary files belong to the server. */
export function createImageAdapter(
  workspaceId: string,
  onError: (message: string) => void,
): AttachmentAdapter {
  return {
    accept: accepted.join(","),
    async add({ file }) {
      try {
        if (!accepted.includes(file.type) || file.size > 5 * 1024 * 1024)
          throw new Error("支持 PNG、JPEG、WebP 图片，每张不超过 5 MB");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error("图片读取失败，请重新选择"));
          reader.readAsDataURL(file);
        });
        const uploaded = await api<ChatImage>(
          `/workspaces/${workspaceId}/chat-attachments`,
          {
            method: "POST",
            body: JSON.stringify({ name: file.name, data }),
          },
        );
        return {
          id: uploaded.id,
          type: "image",
          name: uploaded.name,
          contentType: uploaded.content_type,
          file,
          content: [{ type: "image", image: uploaded.url }],
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
