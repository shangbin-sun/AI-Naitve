import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  useAuiState,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  MessageNotSentError,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Alert, Button, Image, Spin } from "antd";
import Markdown from "react-markdown";
import {
  ArrowUpOutlined,
  PictureOutlined,
  StopOutlined,
  ExperimentOutlined,
} from "@ant-design/icons";
import { createImageAdapter } from "./attachments";
import "./chat.css";

import type { ChatMessage } from "./types";
type Props = {
  workspaceId: string;
  draftText?: string;
  messages: ChatMessage[];
  busy: boolean;
  status?: string;
  failure?: string;
  canCancel: boolean;
  onSend: (text: string, attachmentIds: string[]) => Promise<boolean>;
  onCancel: () => Promise<void>;
  onBuild: (goal: string) => Promise<boolean>;
};

export function convertMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    attachments:
      message.role === "user"
        ? (message.attachments ?? []).map((image) => ({
            id: image.id,
            name: image.name,
            type: "image",
            contentType: image.content_type,
            status: { type: "complete" },
            content: [{ type: "image", image: image.url }],
          }))
        : undefined,
  };
}

function Attachment({ removable = false }: { removable?: boolean }) {
  const attachment = useAuiState((s) => s.attachment);
  const image = attachment.content?.find((part) => part.type === "image");
  return (
    <AttachmentPrimitive.Root className="factory-chat-attachment">
      {image?.type === "image" && (
        <Image src={image.image} alt={attachment.name} width={88} height={64} />
      )}
      <AttachmentPrimitive.Name />
      {removable && (
        <AttachmentPrimitive.Remove aria-label={`移除 ${attachment.name}`}>
          ×
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
}
const PendingImage = () => <Attachment removable />;
const SavedImage = () => <Attachment />;
const MarkdownText = ({ text }: { text: string }) => (
  <Markdown>{text}</Markdown>
);
function Message() {
  const role = useAuiState((s) => s.message.role);
  return (
    <MessagePrimitive.Root className={`factory-chat-message ${role}`}>
      <div className="factory-chat-author">
        {role === "user" ? "你" : "✳ 项目助手"}
      </div>
      <div className="factory-chat-body">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
      <div className="factory-chat-attachments">
        <MessagePrimitive.Attachments components={{ Attachment: SavedImage }} />
      </div>
    </MessagePrimitive.Root>
  );
}
function BuildButton({ onBuild, busy }: Pick<Props, "onBuild" | "busy">) {
  const text = useAuiState((s) => s.composer.text);
  const attachments = useAuiState((s) => s.composer.attachments);
  return (
    <Button
      type="text"
      size="small"
      icon={<ExperimentOutlined aria-hidden="true" />}
      className="factory-chat-build"
      disabled={busy || text.trim().length < 10 || attachments.length > 0}
      title={
        attachments.length ? "先发送图片并完善方案，再启动构建验证" : undefined
      }
      onClick={() => void onBuild(text)}
    >
      按原有测试构建并验证
    </Button>
  );
}

/** Business state stays with the host; assistant-ui owns only conversation interaction. */
export default function ProjectChat(props: Props) {
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const attachments = useMemo(
    () => createImageAdapter(props.workspaceId, setError),
    [props.workspaceId],
  );
  const runtime = useExternalStoreRuntime({
    messages: props.messages,
    convertMessage,
    isRunning: props.busy,
    adapters: { attachments },
    onNew: async (message) => {
      if (submitting.current || props.busy)
        throw new MessageNotSentError("请等待当前任务完成");
      const ids = (message.attachments ?? []).map((a) => a.id);
      if (ids.length > 4) {
        setError("每条消息最多发送 4 张图片，请移除多余图片");
        throw new MessageNotSentError();
      }
      submitting.current = true;
      setError("");
      try {
        const text = message.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        if (!(await props.onSend(text, ids))) throw new MessageNotSentError();
      } finally {
        submitting.current = false;
      }
    },
    onCancel: async () => {
      try {
        await props.onCancel();
      } catch (e) {
        setError((e as Error).message);
      }
    },
  });
  useEffect(() => {
    if (props.draftText !== undefined)
      runtime.thread.composer.setText(props.draftText);
  }, [props.draftText, runtime]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="factory-chat">
        <ThreadPrimitive.Viewport className="factory-chat-viewport">
          <ThreadPrimitive.Empty>
            <p className="factory-chat-empty">
              描述你的调整，或上传流程图、截图，一起完善当前项目。
            </p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ Message }} />
          {props.busy && (
            <div className="factory-chat-progress" role="status">
              <Spin size="small" />
              {props.status || "正在连接 Codex…"}
            </div>
          )}
          {props.failure && <Alert type="warning" message={props.failure} />}
        </ThreadPrimitive.Viewport>
        {error && (
          <Alert
            type="error"
            message={error}
            closable
            onClose={() => setError("")}
          />
        )}
        <div className="factory-chat-compose-area">
          <ComposerPrimitive.Root className="factory-chat-composer">
            <div className="factory-chat-attachments">
              <ComposerPrimitive.Attachments
                components={{ Attachment: PendingImage }}
              />
            </div>
            <ComposerPrimitive.Input
              aria-label="讨论当前项目"
              placeholder="描述工作流调整，也可以粘贴图片…"
              minRows={2}
              maxRows={7}
              maxLength={12000}
              disabled={props.busy}
              cancelOnEscape={false}
            />
            <div className="factory-chat-actions">
              <ComposerPrimitive.AddAttachment
                disabled={props.busy}
                className="factory-chat-button"
              >
                <PictureOutlined aria-hidden="true" /> 添加图片
              </ComposerPrimitive.AddAttachment>
              <span className="factory-chat-image-hint">支持粘贴截图</span>
              {props.busy ? (
                <ComposerPrimitive.Cancel
                  disabled={!props.canCancel}
                  className="factory-chat-button"
                >
                  <StopOutlined aria-hidden="true" /> 停止
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send className="factory-chat-button primary">
                  <ArrowUpOutlined aria-hidden="true" /> 发送
                </ComposerPrimitive.Send>
              )}
            </div>
          </ComposerPrimitive.Root>
          <div className="factory-chat-compose-footer">
            <span>Enter 发送 · Shift + Enter 换行 · 最多 4 张图片</span>
            <BuildButton
              busy={props.busy}
              onBuild={async (goal) => {
                if (await props.onBuild(goal)) {
                  runtime.thread.composer.setText("");
                  return true;
                }
                return false;
              }}
            />
          </div>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
