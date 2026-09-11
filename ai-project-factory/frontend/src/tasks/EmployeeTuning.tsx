import { useEffect, useRef, useState } from "react";
import { Alert, Button, Collapse, Modal, Space, Tag } from "antd";
import Markdown from "react-markdown";
import { CloseOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { api } from "../api";
import "./task-center.css";
import ProjectChat from "../chat/ProjectChat";
import type { ChatMessage } from "../chat/types";
import EmployeeAbilityActions from "./EmployeeAbilityActions";
import AgentActivity from "./AgentActivity";

export type EmployeeConversation = {
  projectId: string;
  runId: string;
  nodeKey: string;
  name: string;
  problem?: string;
};
type Tuning = {
  purpose?: "repair" | "ability";
  context?: {
    status: string;
    summary: string;
    problem: string;
    verification: string;
  };
  status: string;
  started_at?: string;
  finished_at?: string;
  messages: (Omit<ChatMessage, "id"> & { id?: string })[];
  reply?: string;
  error?: string;
  session_mode?: string;
  read_only: boolean;
  can_start: boolean;
  can_continue?: boolean;
  employee_version?: number;
  continued_at?: string;
  report?: { passed: boolean; verification: string; skill?: unknown };
  skills?: { name: string; version: number }[];
};
export default function EmployeeTuning({
  projectId,
  runId,
  nodeKey,
  name,
  problem,
  onClose,
  onContinue,
}: EmployeeConversation & {
  onClose: () => void;
  onContinue: (runId?: string) => void;
}) {
  const base = `/workspaces/${projectId}/agent-runs/${runId}/nodes/${encodeURIComponent(nodeKey)}/tuning`;
  const [data, setData] = useState<Tuning>();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyRetry, setHistoryRetry] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [newSession, setNewSession] = useState(false);
  const request = useRef({ body: "", id: "" });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<Tuning>(base);
        if (live) setData(value);
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [base]);
  const running = ["queued", "running"].includes(data?.status ?? "");
  const historyLive = running || !!data?.read_only;
  useEffect(() => {
    setHistory([]);
    setHistoryError("");
  }, [base]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api<{ messages: ChatMessage[] }>(
          base + "/history",
        );
        if (live) {
          setHistory(result.messages ?? []);
          setHistoryError("");
        }
      } catch (e) {
        if (live) setHistoryError((e as Error).message);
      } finally {
        if (live && historyLive) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [base, historyLive, historyRetry]);
  async function action(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(base + path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      setData(await api<Tuning>(base));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const messages: ChatMessage[] = [
    ...history,
    ...(data?.messages ?? []).map((m, i) => ({
      ...m,
      id: m.id ?? `${runId}-${nodeKey}-${i}`,
    })),
  ];
  if (data?.reply && !running)
    messages.push({ id: "partial", role: "assistant", content: data.reply });
  return (
    <section className="employee-conversation-page">
      <div className="employee-conversation-header">
        <Space>
          <strong>{name}</strong>
          <Tag>{running ? "调优中" : "员工对话"}</Tag>
        </Space>
        <Space className="employee-conversation-toolbar" size={10}>
          <EmployeeAbilityActions
            base={base}
            disabled={!data || busy || running || !!data?.read_only}
            running={running && data?.purpose === "ability"}
            onGenerate={() =>
              action("", {
                purpose: "ability",
                auto_apply: true,
                content:
                  "根据当前聊天、修复过程和用户要求整理并保存员工能力更新，保留无关规则和文件。",
                request_id: crypto.randomUUID(),
              })
            }
            onVerify={onContinue}
          >
            <Button
              className="employee-toolbar-files"
              icon={<FolderOpenOutlined aria-hidden="true" />}
              aria-pressed={filesOpen}
              type="default"
              disabled={!data?.can_start && !filesOpen}
              onClick={() => setFilesOpen(!filesOpen)}
            >
              文件
            </Button>
          </EmployeeAbilityActions>
          <Button
            className="employee-toolbar-close"
            type="text"
            aria-label="关闭对话"
            title="关闭对话"
            icon={<CloseOutlined />}
            onClick={onClose}
          />
        </Space>
      </div>
      <ProjectChat
        workspaceId={projectId}
        filesOpen={filesOpen}
        fileScope={{ runId, node: nodeKey }}
        assistantName={name}
        messages={messages}
        liveReply={data?.reply}
        busy={running}
        jobCreatedAt={data?.started_at}
        jobFinishedAt={data?.finished_at}
        readOnly={busy || !!data?.read_only || !data?.can_start}
        canCancel={running}
        emptyTitle={`与${name}一起解决问题`}
        emptyDescription="独立员工会话保留聊天历史，直接提问，或说明需要修复的问题。"
        status="员工正在处理，离开对话后仍会继续"
        failure={
          error ||
          (data?.error === "Codex 请求失败；请检查会话、登录或模型配置后重试"
            ? "上次消息未能启动，请重新发送消息继续。"
            : data?.error)
        }
        onCancel={async () => {
          await action("/stop");
        }}
        onSend={async (content, attachmentIds) => {
          const body = {
            content,
            attachment_ids: attachmentIds,
            new_session: newSession,
          };
          const signature = JSON.stringify(body);
          if (request.current.body !== signature)
            request.current = { body: signature, id: crypto.randomUUID() };
          const success = await action("", {
            ...body,
            request_id: request.current.id,
          });
          if (success) {
            request.current = { body: "", id: "" };
            setNewSession(false);
          }
          return success;
        }}
        contextPanel={
          <Collapse
            ghost
            items={[
              {
                key: "problem",
                label: "当前进展",
                children: (
                  <div className="employee-context-summary">
                    <section>
                      <strong>1. 当前结果</strong>
                      <Markdown>
                        {data?.context?.summary || "当前还没有执行总结。"}
                      </Markdown>
                    </section>
                    {(data?.context ? data.context.problem : problem) && (
                      <section>
                        <strong>2. 需要解决的问题</strong>
                        <Markdown>
                          {data?.context?.problem || problem || ""}
                        </Markdown>
                      </section>
                    )}
                    {data?.context?.verification && (
                      <section>
                        <strong>已经做过的检查</strong>
                        <Markdown>{data.context.verification}</Markdown>
                      </section>
                    )}
                    <section>
                      <strong>接下来</strong>
                      <p>
                        {running
                          ? "员工正在处理，完成后会在对话中说明结果。"
                          : data?.read_only
                            ? "任务仍在执行。可以先查看进展，等待结束后继续对话。"
                            : "可以在下方直接描述你的要求、补充信息或上传截图，员工会结合已有记录继续处理。"}
                      </p>
                    </section>
                    <Button
                      type="text"
                      size="small"
                      onClick={() => setLogsOpen(true)}
                    >
                      查看技术日志
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        }
        controls={
          <div className="employee-conversation-controls">
            {historyError && (
              <Alert
                type="warning"
                message={historyError}
                action={
                  <Button
                    size="small"
                    onClick={() => setHistoryRetry((v) => v + 1)}
                  >
                    重试读取
                  </Button>
                }
              />
            )}
            {data && !data.can_start && (
              <small>员工尚未开始执行，请先从任务节点启动。</small>
            )}
            {data?.read_only && (
              <small>任务执行中，暂时只读；停止执行后可调优。</small>
            )}
            {data?.continued_at && (
              <small>修复已交回任务；任务停止后可以继续对话调优。</small>
            )}
            {!!data?.skills?.length && (
              <small>
                已保存技能：
                {data.skills
                  .map((s) => `${s.name} · 员工版本 ${s.version}`)
                  .join("、")}
              </small>
            )}
            {data?.report?.passed && !running && (
              <Space wrap>
                {data.can_continue && (
                  <Button
                    type="primary"
                    disabled={busy || !!data.continued_at || data.read_only}
                    onClick={async () => {
                      if (await action("/continue")) onContinue();
                    }}
                  >
                    继续任务
                  </Button>
                )}
              </Space>
            )}
            {data?.status === "interrupted" && (
              <Button
                type={newSession ? "primary" : "text"}
                disabled={busy || data.read_only}
                onClick={() => setNewSession(!newSession)}
              >
                {newSession ? "下一条消息重建独立会话" : "重建独立会话"}
              </Button>
            )}
          </div>
        }
      />

      <Modal
        title="技术日志"
        width={850}
        open={logsOpen}
        onCancel={() => setLogsOpen(false)}
        footer={null}
        destroyOnHidden
      >
        {logsOpen && (
          <AgentActivity
            projectId={projectId}
            runId={runId}
            nodes={{ [nodeKey]: { employee: { name } } }}
            initialNode={nodeKey}
            tuning
          />
        )}
      </Modal>
    </section>
  );
}
