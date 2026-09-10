import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Select, Space, Tag } from "antd";
import { api } from "../api";
import WorkspaceBrowser from "../WorkspaceBrowser";

type Node = {
  step: { name: string };
  employee: { name: string };
  status: string;
  thread_id?: string;
  question?: string;
  answer?: string;
  artifacts: { path: string }[];
};
type Run = {
  id: string;
  title: string;
  scope: string;
  status: string;
  thread_id?: string;
  snapshot: { version: number };
  state: {
    nodes: Record<string, Node>;
    reply?: string;
    error?: string;
    messages?: { role: string; content: string }[];
  };
};
const labels: Record<string, string> = {
  pending: "未开始",
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  waiting_human: "等待人工处理",
  interrupted: "运行中断",
  cancelled: "已停止",
};

export default function AgentRunsPanel({ projectId }: { projectId: string }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [steps, setSteps] = useState<{ key: string; name: string }[]>([]);
  const [scope, setScope] = useState("workflow"),
    [node, setNode] = useState<string>();
  const [description, setDescription] = useState(""),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string>();
  const [question, setQuestion] = useState("");
  const submission = useRef({ payload: "", requestId: "" });
  const base = `/workspaces/${projectId}/agent-runs`;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    void api<{ draft: { workflow?: typeof steps } }>(`/workspaces/${projectId}`)
      .then((project) => {
        if (alive) setSteps(project.draft.workflow ?? []);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    const refresh = async () => {
      try {
        const history = await api<Run[]>(base);
        if (!Array.isArray(history)) throw new Error("运行记录格式异常");
        if (alive) {
          setRuns(history);
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) timer = setTimeout(refresh, 2500);
      }
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [base, projectId]);
  async function action(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const response = await api<{ id?: string }>(base + path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      const history = await api<Run[]>(base);
      if (!Array.isArray(history)) throw new Error("运行记录格式异常");
      setRuns(history);
      if (!path && response.id) setSelected(response.id);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const run = runs.find((r) => r.id === selected) ?? runs[0];
  async function start() {
    const data = {
      title: description.trim().slice(0, 60),
      description,
      scope,
      node: scope === "node" ? node : null,
    };
    const payload = JSON.stringify(data);
    if (submission.current.payload !== payload)
      submission.current = { payload, requestId: crypto.randomUUID() };
    if (await action("", { ...data, request_id: submission.current.requestId }))
      submission.current = { payload: "", requestId: "" };
  }
  return (
    <section className="agent-run-panel">
      <h3>智能体任务</h3>
      <p>主智能体调度员工协作。每次运行独立保存输入、冻结的AI 团队定义和成果。</p>
      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError("")}
        />
      )}
      <Space wrap>
        <Select
          aria-label="运行范围"
          value={scope}
          onChange={setScope}
          options={[
            { value: "workflow", label: "整个工作流" },
            { value: "node", label: "单节点运行" },
          ]}
        />
        {scope === "node" && (
          <Select
            aria-label="选择节点"
            placeholder="选择工作节点"
            style={{ minWidth: 180 }}
            value={node}
            onChange={setNode}
            options={steps.map((s) => ({ value: s.key, label: s.name }))}
          />
        )}
      </Space>
      <Input.TextArea
        aria-label="任务输入"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        maxLength={20000}
        placeholder="输入本次任务、原始数据和验收要求；单节点运行需提供上游输入。"
        style={{ margin: "12px 0" }}
      />
      <Button
        type="primary"
        loading={busy}
        disabled={
          !description.trim() || !steps.length || (scope === "node" && !node)
        }
        onClick={start}
      >
        开始运行
      </Button>
      {!!runs.length && (
        <Select
          aria-label="运行历史"
          style={{ width: "100%", margin: "16px 0" }}
          value={run?.id}
          onChange={setSelected}
          options={runs.map((r) => ({
            value: r.id,
            label: `${r.title} · ${labels[r.status] ?? r.status}`,
          }))}
        />
      )}
      {run && (
        <div className="run-workspace-layout">
          <div>
            <Space wrap>
              <Tag>{labels[run.status]}</Tag>
              <span>
                定义版本 {run.snapshot.version} ·{" "}
                {run.scope === "node" ? "单节点" : "完整工作流"}
              </span>
              {["running", "queued"].includes(run.status) && (
                <Button
                  disabled={busy}
                  onClick={() => action(`/${run.id}/stop`)}
                >
                  停止
                </Button>
              )}
              {["interrupted", "cancelled", "waiting_human"].includes(
                run.status,
              ) && (
                <Button
                  disabled={
                    busy ||
                    Object.values(run.state.nodes).some(
                      (n) => n.status === "waiting_human",
                    )
                  }
                  onClick={() => action(`/${run.id}/resume`)}
                >
                  继续原运行
                </Button>
              )}
            </Space>
            {run.state.error && (
              <Alert type="warning" message={run.state.error} />
            )}
            {Object.entries(run.state.nodes).map(([key, n]) => (
              <div
                key={key}
                style={{
                  borderBottom: "1px solid var(--border, #e3e7f2)",
                  padding: "14px 0",
                }}
              >
                <Space>
                  <strong>{n.step.name}</strong>
                  <span>{n.employee.name}</span>
                  <Tag>{labels[n.status]}</Tag>
                </Space>
                {n.status === "waiting_human" && (
                  <div>
                    <p>{n.question}</p>
                    <Input.TextArea
                      aria-label={`答复${n.step.name}`}
                      value={answers[key] ?? ""}
                      onChange={(e) =>
                        setAnswers({ ...answers, [key]: e.target.value })
                      }
                    />
                    <Button
                      disabled={
                        busy ||
                        run.status !== "waiting_human" ||
                        !answers[key]?.trim()
                      }
                      onClick={() =>
                        action(`/${run.id}/answer`, {
                          node: key,
                          answer: answers[key],
                        })
                      }
                    >
                      提交答复
                    </Button>
                  </div>
                )}
                {n.answer && <p>人工答复：{n.answer}</p>}
                {n.artifacts.map((a) => (
                  <div key={a.path}>
                    <a
                      href={`/api${base}/${run.id}/artifact?path=${encodeURIComponent(a.path)}`}
                    >
                      下载 {a.path.split("/").pop()}
                    </a>
                  </div>
                ))}
              </div>
            ))}
            {run.state.messages?.map((message, index) => (
              <p key={index} style={{ whiteSpace: "pre-wrap" }}>
                <strong>{message.role === "user" ? "你" : "任务助手"}：</strong>
                {message.content}
              </p>
            ))}
            {run.state.reply && (
              <p style={{ whiteSpace: "pre-wrap" }}>{run.state.reply}</p>
            )}
            <details>
              <summary>运行记录</summary>
              <p>主会话：{run.thread_id ?? "尚未连接"}</p>
              {Object.entries(run.state.nodes).map(([key, n]) => (
                <p key={key}>
                  {n.employee.name}：{n.thread_id ?? "尚未创建子会话"}
                </p>
              ))}
            </details>
            <Input.TextArea
              aria-label="讨论当前运行"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="就本次任务继续提问，沿用原会话和工作空间…"
              rows={2}
            />
            <Button
              disabled={
                busy ||
                !run.thread_id ||
                ["running", "queued"].includes(run.status) ||
                !question.trim()
              }
              onClick={async () => {
                if (await action(`/${run.id}/messages`, { content: question }))
                  setQuestion("");
              }}
            >
              发送问题
            </Button>
          </div>
          <WorkspaceBrowser key={run.id} projectId={projectId} runId={run.id} />
        </div>
      )}
    </section>
  );
}
