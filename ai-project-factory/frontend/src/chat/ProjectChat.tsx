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
  PaperClipOutlined,
  StopOutlined,
  ExperimentOutlined,
} from "@ant-design/icons";
import { createAttachmentAdapter } from "./attachments";
import "./chat.css";
import ProcessingTime from "./ProcessingTime";
import WorkspaceBrowser from "../WorkspaceBrowser";

import type { ChatMessage } from "./types";
type Props = {
  workspaceId: string;
  filesOpen?: boolean;
  employees?: { id: string; profile: { name: string } }[];
  employeeReference?: string;
  onReferenceChange?: (id: string) => void;
  jobId?: string;
  jobCreatedAt?: string;
  jobFinishedAt?: string | null;
  onSettled?: () => void;
  threadId?: string;
  draftText?: string;
  messages: ChatMessage[];
  busy: boolean;
  status?: string;
  failure?: string;
  canCancel: boolean;
  onSend: (text: string, attachmentIds: string[]) => Promise<boolean>;
  onCancel: () => Promise<void>;
  onBuild?: (goal: string) => Promise<boolean>;
};

export function convertMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    metadata: {
      custom: {
        timing: message.timing,
        employeeReference: message.employee_reference,
      },
    },
    attachments:
      message.role === "user"
        ? (message.attachments ?? []).map((image) => ({
            id: image.id,
            name: image.name,
            type: image.content_type.startsWith("image/") ? "image" : "file",
            contentType: image.content_type,
            status: { type: "complete" },
            content: image.content_type.startsWith("image/")
              ? [{ type: "image", image: image.url }]
              : [],
          }))
        : undefined,
  };
}

function Attachment({ removable = false }: { removable?: boolean }) {
  const attachment = useAuiState((s) => s.attachment);
  const image = attachment.contentType?.startsWith("image/")
    ? attachment.content?.find((part) => part.type === "image")
    : undefined;
  return (
    <AttachmentPrimitive.Root className="factory-chat-attachment">
      {image?.type === "image" && (
        <Image src={image.image} alt={attachment.name} width={88} height={64} />
      )}
      {!image && (
        <span aria-hidden="true" className="factory-chat-file-icon">
          📎
        </span>
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
const PendingAttachment = () => <Attachment removable />;
const SavedAttachment = () => <Attachment />;
const MarkdownText = ({ text }: { text: string }) => (
  <Markdown>{text}</Markdown>
);
function Message() {
  const role = useAuiState((s) => s.message.role);
  const employeeReference = useAuiState(
    (s) => s.message.metadata.custom?.employeeReference,
  ) as ChatMessage["employee_reference"];
  const timing = useAuiState(
    (s) => s.message.metadata.custom?.timing,
  ) as ChatMessage["timing"];
  return (
    <MessagePrimitive.Root className={`factory-chat-message ${role}`}>
      <div className="factory-chat-author">
        <span>{role === "user" ? "你" : "✳ AI 团队助手"}</span>
        {role === "assistant" && timing && (
          <ProcessingTime
            startedAt={timing.started_at}
            finishedAt={timing.finished_at}
            running={Boolean(timing.running)}
          />
        )}
      </div>
      {employeeReference && (
        <div className="factory-chat-reference">
          引用员工 · {employeeReference.name}
        </div>
      )}
      <div className="factory-chat-body">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
      <div className="factory-chat-attachments">
        <MessagePrimitive.Attachments
          components={{ Attachment: SavedAttachment }}
        />
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
      aria-label="按原有测试构建并验证"
      disabled={busy || text.trim().length < 10 || attachments.length > 0}
      title={
        attachments.length ? "先发送附件并完善方案，再启动构建验证" : undefined
      }
      onClick={() => void onBuild?.(text)}
    >
      构建验证
    </Button>
  );
}

/** Business state stays with the host; assistant-ui owns only conversation interaction. */
export default function ProjectChat(props: Props) {
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const attachments = useMemo(
    () => createAttachmentAdapter(props.workspaceId, setError),
    [props.workspaceId],
  );
  const [stream, setStream] = useState<{
    id: string;
    reply: string;
    status: string;
    message: string;
  } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const settledRef = useRef(props.onSettled);
  settledRef.current = props.onSettled;
  useEffect(() => {
    setStream(null);
    setReconnecting(false);
    if (!props.jobId) return;
    const connectedAt = performance.now();
    let measured = false;
    let frame = 0;
    const report = (event: string) => {
      // Two small, content-free samples per connection, never per text delta.
      navigator.sendBeacon?.(
        `/api/jobs/${props.jobId}/browser-timing`,
        new Blob(
          [
            JSON.stringify({
              event,
              elapsed_ms: performance.now() - connectedAt,
            }),
          ],
          { type: "application/json" },
        ),
      );
    };
    const source = new EventSource(`/api/jobs/${props.jobId}/events`);
    source.onmessage = (event) => {
      const snapshot = JSON.parse(event.data);
      setStream(snapshot);
      setReconnecting(false);
      if (snapshot.reply && !measured) {
        measured = true;
        report("first_reply_received");
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => report("frame_after_reply"));
        });
      }
      if (!["queued", "running"].includes(snapshot.status)) {
        source.close();
        settledRef.current?.();
      }
    };
    source.onerror = () => setReconnecting(true);
    return () => {
      source.close();
      cancelAnimationFrame(frame);
    };
  }, [props.jobId]);
  const current = stream?.id === props.jobId ? stream : null;
  const lastMessage = props.messages.at(-1);
  const alreadySaved =
    current?.status === "completed" &&
    lastMessage?.role === "assistant" &&
    lastMessage.content === current.reply;
  // Create the current turn before its first text delta, so its author and
  // timer use the same header throughout waiting, streaming and persistence.
  const preview = !alreadySaved && (props.busy || Boolean(current?.reply));
  const messages = preview
    ? [
        ...props.messages,
        {
          id: `stream-${props.jobId}`,
          role: "assistant",
          content: current?.reply ?? "",
          timing: props.jobCreatedAt
            ? {
                started_at: props.jobCreatedAt,
                finished_at: props.jobFinishedAt,
                running: props.busy,
              }
            : undefined,
        },
      ]
    : props.messages;
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning: props.busy,
    adapters: { attachments },
    onNew: async (message) => {
      if (submitting.current || props.busy)
        throw new MessageNotSentError("请等待当前任务完成");
      const ids = (message.attachments ?? []).map((a) => a.id);
      if (ids.length > 4) {
        setError("每条消息最多发送 4 个附件，请移除多余附件");
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
      <div className="conversation-workspace">
        <ThreadPrimitive.Root className="factory-chat">
          <ThreadPrimitive.Viewport className="factory-chat-viewport">
            <ThreadPrimitive.Empty>
              <div className="factory-chat-empty">
                <span aria-hidden="true" className="factory-chat-empty-mark">
                  ✳
                </span>
                <h2>从一个想法开始</h2>
                <p>聊聊你想做什么，我们一起把它变成可以执行的AI 团队。</p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ Message }} />
            {props.busy && (
              <div className="factory-chat-progress" role="status">
                <Spin size="small" />
                {reconnecting
                  ? "连接中断，正在重连…"
                  : current?.message || props.status || "正在连接 Codex…"}
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
                  components={{ Attachment: PendingAttachment }}
                />
              </div>
              {props.employeeReference && (
                <div className="factory-chat-reference-picker">
                  <span>
                    引用员工 ·{" "}
                    {props.employees?.find(
                      (employee) => employee.id === props.employeeReference,
                    )?.profile.name ?? "当前员工"}
                  </span>
                  {props.onReferenceChange && (
                    <button
                      type="button"
                      aria-label="移除员工引用"
                      disabled={props.busy}
                      onClick={() => props.onReferenceChange?.("")}
                    >
                      ×
                    </button>
                  )}
                </div>
              )}
              <ComposerPrimitive.Input
                aria-label="讨论当前AI 团队"
                placeholder="直接与 Codex 对话，也可以添加文件或粘贴图片…"
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
                  aria-label="添加附件"
                  title="添加图片或文件，最多 4 个；也可直接粘贴图片"
                >
                  <PaperClipOutlined aria-hidden="true" /> 附件
                </ComposerPrimitive.AddAttachment>
                <span className="factory-chat-image-hint" />
                {props.busy ? (
                  <ComposerPrimitive.Cancel
                    disabled={!props.canCancel}
                    className="factory-chat-button factory-chat-submit"
                    aria-label="停止"
                    title="停止生成"
                  >
                    <StopOutlined aria-hidden="true" />
                  </ComposerPrimitive.Cancel>
                ) : (
                  <ComposerPrimitive.Send
                    className="factory-chat-button primary factory-chat-submit"
                    aria-label="发送"
                    title="Enter 发送 · Shift + Enter 换行"
                  >
                    <ArrowUpOutlined aria-hidden="true" />
                  </ComposerPrimitive.Send>
                )}
              </div>
            </ComposerPrimitive.Root>
            {props.onBuild && <div className="factory-chat-compose-footer">
              {props.onBuild && <BuildButton
                busy={props.busy}
                onBuild={async (goal) => {
                  if (await props.onBuild?.(goal)) {
                    runtime.thread.composer.setText("");
                    return true;
                  }
                  return false;
                }}
              />}
            </div>}
          </div>
        </ThreadPrimitive.Root>
        {props.filesOpen && <WorkspaceBrowser
          key={props.workspaceId}
          projectId={props.workspaceId}
        />}
      </div>
    </AssistantRuntimeProvider>
  );
}
