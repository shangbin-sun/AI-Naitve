import TaskScheduleFields, {
  emptySchedule,
  schedulePayload,
} from "./TaskScheduleFields";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Upload,
} from "antd";
import {
  ArrowLeftOutlined,
  DownloadOutlined,
  PlusOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import WorkspaceBrowser from "../WorkspaceBrowser";
import type { WorkTask } from "./types";
import "./task-center.css";
import ExecutionOutput from "./ExecutionOutput";
import ExecutionWorkflow from "./ExecutionWorkflow";
import AgentActivity from "./AgentActivity";
import type { EmployeeConversation } from "./EmployeeTuning";

type Artifact = {
  path: string;
  description?: string;
  size?: number;
  sha256?: string;
};
type Node = {
  step: {
    key: string;
    owner: string;
    name: string;
    depends_on?: string[];
    input?: string;
    output?: string;
    acceptance?: string;
  };
  employee: { key?: string; name: string; kind?: string };
  status: string;
  question?: string;
  answer?: string;
  activity?: string;
  error?: string;
  verification?: string;
  summary?: string;
  started_at?: string;
  finished_at?: string;
  artifacts: Artifact[];
  attempts?: Node[];
  attempt?: string;
};
type Inputs = {
  description?: string;
  node?: string;
  input_text?: string;
  acceptance?: string;
  require_review?: boolean;
  attachments?: { name: string; path: string; size: number }[];
};
type Run = {
  id: string;
  task_id?: string;
  title: string;
  scope: string;
  status: string;
  thread_id?: string;
  created_at?: string;
  updated_at?: string;
  inputs?: Inputs;
  snapshot: { version: number };
  directory?: string;
  state: {
    nodes: Record<string, Node>;
    reply?: string;
    error?: string;
    started_at?: string;
    finished_at?: string;
    messages?: { role: string; content: string }[];
    events?: {
      at: string;
      tool: string;
      node?: string;
      note?: string;
      kind?: string;
    }[];
    reviews?: { approved: boolean; note: string; at: string }[];
    request_id?: string;
  };
};
type Step = {
  key: string;
  owner?: string;
  name: string;
  input?: string;
  depends_on?: string[];
};
type Attachment = { name: string; data: string };
const labels: Record<string, string> = {
  scheduled: "等待定时执行",
  draft: "未开始",
  pending: "未开始",
  queued: "排队中",
  preparing: "准备中",
  running: "执行中",
  waiting_human: "待处理",
  skipped: "无需处理",
  awaiting_review: "待验收",
  completed: "已完成",
  failed: "执行失败",
  interrupted: "已中断",
  cancelled: "已停止",
};
const colors: Record<string, string> = {
  preparing: "processing",
  running: "processing",
  waiting_human: "orange",
  skipped: "default",
  awaiting_review: "gold",
  completed: "success",
  failed: "error",
  interrupted: "warning",
};
const stamp = (value?: string) =>
  value ? new Date(value).toLocaleString() : "—";
const taskId = (run: Run) => run.task_id ?? run.id;
function elapsed(run: Run) {
  if (!run.state.started_at) return "尚未开始";
  const seconds = Math.max(
    0,
    Math.floor(
      (new Date(run.state.finished_at ?? new Date()).getTime() -
        new Date(run.state.started_at).getTime()) /
        1000,
    ),
  );
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function Status({ status }: { status: string }) {
  return <Tag color={colors[status]}>{labels[status] ?? status}</Tag>;
}
function encodeFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function AgentRunsPanel({
  projectId,
  launchEmployee,
  initialRun,
  onLegacy,
  onEmployeeChat,
}: {
  projectId: string;
  initialRun?: string;
  launchEmployee?: { employee?: string; nonce: number };
  onLegacy?: (id: string) => void;
  onEmployeeChat?: (conversation: EmployeeConversation) => void;
}) {
  const base = `/workspaces/${projectId}/agent-runs`;
  const [runs, setRuns] = useState<Run[]>([]),
    [legacy, setLegacy] = useState<WorkTask[]>([]);
  const [steps, setSteps] = useState<Step[]>([]),
    [members, setMembers] = useState<
      { key: string; name: string; kind: string }[]
    >([]);
  const [selected, setSelected] = useState<string>(),
    [selectedRun, setSelectedRun] = useState<string>();
  const [dataView, setDataView] = useState<"inputs" | "outputs">();
  const [filter, setFilter] = useState("all"),
    [scopeFilter, setScopeFilter] = useState("all"),
    [search, setSearch] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [schedule, setSchedule] = useState({ ...emptySchedule });
  const [schedules, setSchedules] = useState<
    {
      id: string;
      task_id: string;
      status: string;
      next_at: string;
      iterations: number;
      spec: { kind: string };
      state: { reason?: string; judgment?: { reason: string } };
    }[]
  >([]);
  const [creating, setCreating] = useState(false),
    [rerun, setRerun] = useState<Run>(),
    [scope, setScope] = useState("workflow"),
    [node, setNode] = useState<string>();
  const [activityNode, setActivityNode] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const restoreVersion = useRef(0);
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]),
    [useLatest, setUseLatest] = useState(false);
  const [restartNode, setRestartNode] = useState<string>();
  const [restartNote, setRestartNote] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [nodeKey, setNodeKey] = useState<string>();
  const [preview, setPreview] = useState<{
    name: string;
    text: string | null;
    reason?: string;
    url: string;
  }>();
  const [editingDraft, setEditingDraft] = useState<Run>();
  const [showFiles, setShowFiles] = useState(false);
  const submission = useRef({ payload: "", requestId: "" }),
    mounted = useRef(true);
  const refresh = useCallback(async () => {
    const data = await api<Run[]>(base);
    if (!Array.isArray(data)) throw new Error("状态更新失败，请刷新重试");
    if (mounted.current) setRuns(data);
    const plans = await api<typeof schedules>(
      `/workspaces/${projectId}/task-schedules`,
    );
    if (mounted.current)
      setSchedules(Array.isArray(plans) ? plans.filter((p) => !!p.spec) : []);
  }, [base]);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    void api<{ draft: { workflow?: Step[]; members?: typeof members } }>(
      `/workspaces/${projectId}`,
    )
      .then((d) => {
        if (alive) {
          setSteps(d.draft.workflow ?? []);
          setMembers(d.draft.members ?? []);
        }
      })
      .catch((e) => alive && setError(String(e)));
    if (onLegacy)
      void api<WorkTask[]>(`/workspaces/${projectId}/tasks`)
        .then((d) => alive && setLegacy(Array.isArray(d) ? d : []))
        .catch((e) => alive && setError(String(e)));
    const poll = async () => {
      try {
        await refresh();
      } catch (e) {
        if (alive) setError(`状态更新中断：${String(e)}`);
      } finally {
        if (alive) {
          setLoading(false);
          timer = setTimeout(poll, 2500);
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [projectId, refresh]);
  function newTask(employee?: string) {
    setSchedule({ ...emptySchedule });
    setEditingDraft(undefined);
    setRerun(undefined);
    setDescription("");
    setAttachments([]);
    setScope(employee ? "node" : "workflow");
    setNode(employee);
    setCreating(true);
    setError("");
    submission.current = { payload: "", requestId: "" };
  }
  useEffect(() => {
    if (launchEmployee) newTask(launchEmployee.employee);
  }, [launchEmployee?.nonce]);
  useEffect(() => {
    if (launchEmployee && steps.length)
      setNode(
        steps.find((s) => s.owner === launchEmployee.employee)?.key ??
          launchEmployee.employee,
      );
  }, [steps, launchEmployee]);
  async function readInputFile(
    source: Run,
    file: NonNullable<Inputs["attachments"]>[number],
  ): Promise<Attachment> {
    const response = await fetch(
      `/api/workspaces/${projectId}/file?run_id=${source.id}&path=${encodeURIComponent(file.path)}&download=true`,
    );
    if (!response.ok) throw new Error(`无法读取已上传文件：${file.name}`);
    return { name: file.name, data: await encodeFile(await response.blob()) };
  }
  useEffect(() => {
    if (!creating || loading || rerun || editingDraft) return;
    const version = ++restoreVersion.current;
    const owner =
      steps.find((s) => s.key === node || s.owner === node)?.owner ?? node;
    const previous = runs.find(
      (r) =>
        r.scope === scope &&
        (scope === "workflow" ||
          (owner &&
            Object.values(r.state.nodes).some(
              (n) => n.step.owner === owner || n.employee.key === owner,
            ))),
    );
    setDescription(
      [previous?.inputs?.description, previous?.inputs?.input_text]
        .filter(Boolean)
        .join("\n\n"),
    );
    setAttachments([]);
    if (!previous?.inputs?.attachments?.length) {
      setRestoring(false);
      return;
    }
    setRestoring(true);
    void Promise.all(
      previous.inputs.attachments.map((f) => readInputFile(previous, f)),
    )
      .then((files) => {
        if (restoreVersion.current === version) setAttachments(files);
      })
      .catch((e) => {
        if (restoreVersion.current === version) setError(String(e));
      })
      .finally(() => {
        if (restoreVersion.current === version) setRestoring(false);
      });
    return () => {
      restoreVersion.current++;
    };
  }, [creating, loading, scope, node, rerun, editingDraft]);
  const formSteps =
    rerun && !useLatest
      ? Object.values(rerun.state.nodes).map((n) => n.step)
      : steps;
  const formMembers =
    rerun && !useLatest
      ? Object.values(rerun.state.nodes).map((n) => n.employee)
      : members;
  const duplicateEmployees =
    new Set(formSteps.map((s) => s.owner)).size !== formSteps.length;
  const openedRun = useRef<string | undefined>(undefined);
  useEffect(() => {
    const match = runs.find((r) => r.id === initialRun);
    if (match && openedRun.current !== initialRun) {
      openedRun.current = initialRun;
      setSelected(taskId(match));
      setSelectedRun(match.id);
    }
  }, [runs, initialRun]);
  const history = runs.filter((r) => taskId(r) === selected);
  const run = history.find((r) => r.id === selectedRun) ?? history[0];
  const chosenNode = run && nodeKey ? run.state.nodes[nodeKey] : undefined;
  const active = run && ["running", "queued"].includes(run.status);
  function openEmployeeChat(key: string) {
    if (run)
      onEmployeeChat?.({
        projectId,
        runId: run.id,
        nodeKey: key,
        name: run.state.nodes[key].employee.name,
        problem: run.state.nodes[key].question || run.state.nodes[key].error,
      });
  }
  async function action(path: string, body?: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      const result = await api<Run>(base + path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      await refresh();
      return result;
    } catch (e) {
      setError(String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function submit(draft = false) {
    let automation;
    try {
      automation =
        !rerun && !editingDraft ? schedulePayload(schedule) : undefined;
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (automation && draft) {
      setError("自动执行任务请直接创建，不能保存草稿");
      return;
    }
    const data = {
      title: (editingDraft || rerun)?.title || description.trim().slice(0, 60),
      description,
      scope,
      node: scope === "node" ? node : null,
      input_text: (editingDraft || rerun)?.inputs?.input_text ?? "",
      acceptance: (editingDraft || rerun)?.inputs?.acceptance ?? "",
      attachments,
      save_draft: draft,
      ...(rerun
        ? {
            task_id: taskId(rerun),
            source_run: rerun.id,
            use_latest: useLatest,
          }
        : {}),
    };
    const payload = JSON.stringify({ data, automation });
    if (submission.current.payload !== payload)
      submission.current = { payload, requestId: crypto.randomUUID() };
    let result: Run | undefined;
    if (automation) {
      setBusy(true);
      setError("");
      try {
        result = await api<Run>(`/workspaces/${projectId}/task-schedules`, {
          method: "POST",
          body: JSON.stringify({
            task: { ...data, request_id: submission.current.requestId },
            schedule: automation,
          }),
        });
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    } else
      result = await action(
        editingDraft ? `/${editingDraft.id}` : "",
        {
          ...data,
          request_id: submission.current.requestId,
          ...(editingDraft
            ? { expected_updated_at: editingDraft.updated_at }
            : {}),
        },
        editingDraft ? "PUT" : "POST",
      );
    if (result?.id) {
      setSelected(taskId(result));
      setSelectedRun(result.id);
      setCreating(false);
      setSchedule({ ...emptySchedule });
      submission.current = { payload: "", requestId: "" };
    }
  }
  async function again(edit = false) {
    if (!run) return;
    setEditingDraft(edit ? run : undefined);
    setBusy(true);
    try {
      const files: Attachment[] = [];
      for (const file of run.inputs?.attachments ?? []) {
        const response = await fetch(
          `/api/workspaces/${projectId}/file?run_id=${run.id}&path=${encodeURIComponent(file.path)}&download=true`,
        );
        if (!response.ok) throw new Error("原输入读取失败");
        files.push({
          name: file.name,
          data: await encodeFile(await response.blob()),
        });
      }
      setRerun(edit ? undefined : run);
      setScope(run.scope);
      setNode(run.inputs?.node);
      setDescription(run.inputs?.description ?? "");
      setAttachments(files);
      setUseLatest(false);
      setCreating(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function openFile(path: string) {
    if (!run) return;
    try {
      const value = await api<{
        name: string;
        text: string | null;
        reason?: string;
      }>(
        `/workspaces/${projectId}/file?run_id=${run.id}&path=${encodeURIComponent(path)}`,
      );
      setPreview({
        ...value,
        url: `/api/workspaces/${projectId}/file?run_id=${run.id}&path=${encodeURIComponent(path)}&download=true`,
      });
    } catch (e) {
      setError(String(e));
    }
  }
  const artifact = (file: Artifact) => (
    <Button
      type="link"
      key={file.path}
      onClick={() => void openFile(file.path)}
    >
      {file.path.split("/").pop()}
    </Button>
  );
  const latest = Object.values(
    runs.reduce<Record<string, Run>>((all, r) => {
      if (!all[taskId(r)]) all[taskId(r)] = r;
      return all;
    }, {}),
  );
  const rows = [
    ...latest.map((r) => ({
      id: taskId(r),
      title: r.title,
      scope: r.scope,
      status: r.status,
      date: r.updated_at ?? r.created_at,
      run: r,
      legacy: false,
    })),
    ...legacy.map((t) => ({
      id: t.id,
      title: t.title,
      scope: "workflow",
      status: t.latest_run?.status ?? "draft",
      date: t.updated_at,
      run: undefined,
      legacy: true,
    })),
  ]
    .sort(
      (a, b) =>
        new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime(),
    )
    .filter(
      (r) =>
        (filter === "all" ||
          (filter === "attention"
            ? r.status === "waiting_human"
            : filter === "abnormal"
              ? ["failed", "interrupted", "cancelled"].includes(r.status)
              : filter === "running"
                ? ["running", "queued"].includes(r.status)
                : r.status === filter)) &&
        (scopeFilter === "all" || r.scope === scopeFilter) &&
        r.title.toLowerCase().includes(search.toLowerCase()),
    );
  return (
    <section className="task-center">
      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError("")}
        />
      )}
      {!run ? (
        <>
          <div className="task-center-heading">
            <div>
              <h2>任务中心</h2>
              <p>选择员工或整个团队，完成一次具体工作。</p>
            </div>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => newTask()}
            >
              新建任务
            </Button>
          </div>
          <div className="task-center-filters">
            <Input.Search
              aria-label="搜索任务"
              placeholder="搜索任务名称"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              aria-label="执行范围筛选"
              value={scopeFilter}
              onChange={setScopeFilter}
              options={[
                { value: "all", label: "所有范围" },
                { value: "node", label: "单员工" },
                { value: "workflow", label: "团队" },
              ]}
            />
          </div>
          <Tabs
            activeKey={filter}
            onChange={setFilter}
            items={[
              { key: "all", label: "全部" },
              { key: "running", label: "执行中" },
              {
                key: "attention",
                label: `待处理 ${latest.filter((r) => r.status === "waiting_human").length}`,
              },
              { key: "completed", label: "已完成" },
              { key: "abnormal", label: "异常／已停止" },
            ]}
          />
          <Table
            loading={loading}
            rowKey="id"
            dataSource={rows}
            pagination={{ pageSize: 10 }}
            locale={{
              emptyText: <Empty description="暂无任务，创建任务开始执行" />,
            }}
            columns={[
              {
                title: "任务名称",
                key: "title",
                render: (_, r) => (
                  <Button
                    type="link"
                    onClick={() => {
                      if (r.legacy) onLegacy?.(r.id);
                      else {
                        setSelected(r.id);
                        setSelectedRun(r.run?.id);
                      }
                    }}
                  >
                    {r.title}
                  </Button>
                ),
              },
              {
                title: "范围",
                key: "scope",
                render: (_, r) => (
                  <span>
                    {r.scope === "node" ? "单员工" : "团队"}
                    {r.legacy && <Tag>历史</Tag>}
                  </span>
                ),
              },
              {
                title: "状态",
                key: "status",
                render: (_, r) => (
                  <Space wrap>
                    <Status status={r.status} />
                    {schedules
                      .filter((p) => p.task_id === r.id)
                      .map((p) => (
                        <Tag key={p.id}>
                          {p.spec.kind === "loop" ? "条件循环" : "定时执行"} ·{" "}
                          {p.status === "active"
                            ? "已开启"
                            : p.status === "paused"
                              ? "已暂停"
                              : "已结束"}
                        </Tag>
                      ))}
                  </Space>
                ),
              },
              {
                title: "员工进度",
                key: "progress",
                render: (_, r) =>
                  r.run
                    ? `${Object.values(r.run.state.nodes).filter((n) => n.status === "completed").length}/${Object.keys(r.run.state.nodes).length}`
                    : "—",
              },
              {
                title: "当前事项",
                key: "activity",
                render: (_, r) =>
                  r.run
                    ? (Object.values(r.run.state.nodes).find(
                        (n) => n.question && !n.answer,
                      )?.question ??
                      Object.values(r.run.state.nodes).find((n) =>
                        ["preparing", "running"].includes(n.status),
                      )?.activity ??
                      labels[r.status])
                    : "查看历史成果",
              },
              {
                title: "最近活动",
                key: "date",
                render: (_, r) => stamp(r.date),
              },
            ]}
          />
        </>
      ) : (
        <>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => {
              setSelected(undefined);
              setNodeKey(undefined);
              setPreview(undefined);
            }}
          >
            返回任务中心
          </Button>
          <div className="task-center-heading">
            <div>
              <h2>{run.title}</h2>
              <Space wrap>
                <Status status={run.status} />
                <span>{run.scope === "node" ? "单员工执行" : "团队执行"}</span>
                <span>耗时 {elapsed(run)}</span>
                <span>团队版本 {run.snapshot.version}</span>
              </Space>
            </div>
            <Space wrap>
              {schedules
                .filter((p) => p.task_id === taskId(run))
                .map((p) => (
                  <Space key={p.id} wrap>
                    <Tag>
                      {p.spec.kind === "loop" ? "条件循环" : "定时执行"} ·{" "}
                      {p.iterations} 次 ·{" "}
                      {p.status === "active"
                        ? "已开启"
                        : p.status === "paused"
                          ? "已暂停"
                          : "已结束"}
                    </Tag>
                    {p.status === "active" && (
                      <small>计划时间：{stamp(p.next_at)}</small>
                    )}
                    {p.state.reason && <small>{p.state.reason}</small>}
                    {p.state.judgment && (
                      <small>{p.state.judgment.reason}</small>
                    )}
                    {p.status !== "completed" && (
                      <Button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await api(
                              `/workspaces/${projectId}/task-schedules/${p.id}/${p.status === "active" ? "pause" : "resume"}`,
                              { method: "POST" },
                            );
                            await refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {p.status === "active"
                          ? "暂停自动执行"
                          : "恢复自动执行"}
                      </Button>
                    )}
                  </Space>
                ))}
              {run.status === "draft" && (
                <Button disabled={busy} onClick={() => void again(true)}>
                  编辑任务
                </Button>
              )}
              {run.status === "draft" && (
                <Button
                  type="primary"
                  disabled={busy}
                  onClick={() => void action(`/${run.id}/start`)}
                >
                  开始执行
                </Button>
              )}
              {active && (
                <Button
                  danger
                  disabled={busy}
                  onClick={() => void action(`/${run.id}/stop`)}
                >
                  停止执行
                </Button>
              )}
              {["interrupted", "cancelled", "waiting_human", "failed"].includes(
                run.status,
              ) && (
                <Button
                  disabled={
                    busy ||
                    Object.values(run.state.nodes).some(
                      (n) => n.status === "waiting_human",
                    )
                  }
                  onClick={() => void action(`/${run.id}/resume`)}
                >
                  恢复执行
                </Button>
              )}
            </Space>
          </div>
          <Select
            aria-label="执行批次"
            value={run.id}
            onChange={(value) => {
              setSelectedRun(value);
              setDataView(undefined);
              setShowFiles(false);
              setNodeKey(undefined);
              setPreview(undefined);
            }}
            options={history.map((r, i) => ({
              value: r.id,
              label: `第 ${history.length - i} 次执行 · ${labels[r.status] ?? r.status} · ${stamp(r.created_at)}`,
            }))}
          />
          {run.state.error && (
            <Alert type="warning" message={run.state.error} />
          )}
          <ExecutionWorkflow
            actions={
              <Space>
                {!active && run.status !== "draft" && (
                  <Button disabled={busy} onClick={() => void again()}>
                    再次执行
                  </Button>
                )}
              </Space>
            }
            nodes={run.state.nodes}
            status={run.status}
            busy={busy}
            onLogs={setActivityNode}
            onTune={onEmployeeChat ? openEmployeeChat : undefined}
            onOpen={setNodeKey}
            onData={setDataView}
            onRestart={(key) => {
              setRestartNode(key);
              setRestartNote("");
            }}
          />
          {Object.entries(run.state.nodes)
            .filter(([, n]) => n.status === "waiting_human")
            .map(([key, n]) => (
              <div className="task-attention" key={key}>
                <h3>{n.employee.name}需要你处理</h3>
                <p>{n.question}</p>
                <Input.TextArea
                  aria-label={`答复${n.step.name}`}
                  value={answers[key] ?? ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [key]: e.target.value })
                  }
                />
                <Space size={12} wrap>
                  <Button
                    disabled={
                      busy ||
                      !["waiting_human", "interrupted", "cancelled"].includes(
                        run.status,
                      ) ||
                      !answers[key]?.trim()
                    }
                    onClick={() =>
                      void action(`/${run.id}/answer`, {
                        node: key,
                        answer: answers[key],
                      })
                    }
                  >
                    提交答复
                  </Button>
                  {onEmployeeChat && n.employee.kind !== "human" && (
                    <Button onClick={() => openEmployeeChat(key)}>
                      与员工对话
                    </Button>
                  )}
                </Space>
                <small>所有问题答复后，可恢复执行。</small>
              </div>
            ))}
          {run.status !== "draft" && (
            <div className="task-data-group">
              <ExecutionOutput
                key={`main-${run.id}`}
                projectId={projectId}
                runId={run.id}
                root={run.directory!}
                status={run.status}
                summary={run.state.reply}
                error={run.state.error}
                files={Object.values(run.state.nodes).flatMap(
                  (n) => n.artifacts,
                )}
              />
            </div>
          )}
        </>
      )}
      <Drawer
        rootClassName="task-create-drawer"
        title={
          <div className="task-create-title">
            <strong>
              {editingDraft ? "编辑任务" : rerun ? "再次执行任务" : "新建任务"}
            </strong>
            <span>明确交付目标，让 AI 团队开始工作</span>
          </div>
        }
        open={creating}
        width="min(100vw, 760px)"
        onClose={() => !busy && setCreating(false)}
        footer={
          <Space className="task-create-actions">
            <Button disabled={busy} onClick={() => setCreating(false)}>
              取消
            </Button>
            {!rerun && !schedule.timed && !schedule.loop && (
              <Button
                disabled={busy || restoring || !description.trim()}
                onClick={() => void submit(true)}
              >
                保存草稿
              </Button>
            )}
            <Button
              type="primary"
              loading={busy}
              disabled={
                busy ||
                restoring ||
                !description.trim() ||
                !formSteps.length ||
                (scope === "workflow" && duplicateEmployees) ||
                (scope === "node" && !node)
              }
              onClick={() => void submit(!!editingDraft)}
            >
              {editingDraft
                ? "保存修改"
                : !rerun && (schedule.timed || schedule.loop)
                  ? "创建自动任务"
                  : "开始执行"}
            </Button>
          </Space>
        }
      >
        {error && <Alert type="error" message={error} />}
        {scope === "workflow" && duplicateEmployees && (
          <Alert
            type="warning"
            message="当前方案包含同一员工的多个节点，请先在团队中合并为一个员工一个节点。"
          />
        )}
        <div className="task-create-form">
          <section className="task-brief-section">
            <div className="task-section-heading">
              <span>01</span>
              <div>
                <h3>任务内容</h3>
                <p>描述期望的结果，并提供需要的资料。</p>
              </div>
            </div>
            <label>
              执行范围
              <Select
                aria-label="运行范围"
                value={scope}
                disabled={!!rerun || restoring}
                onChange={setScope}
                options={[
                  { value: "workflow", label: "团队执行" },
                  { value: "node", label: "单员工执行" },
                ]}
              />
            </label>
            {scope === "node" && (
              <label>
                执行员工
                <Select
                  aria-label="选择员工"
                  disabled={restoring}
                  value={node}
                  onChange={setNode}
                  options={formSteps
                    .filter(
                      (s, i, all) =>
                        all.findIndex((other) => other.owner === s.owner) === i,
                    )
                    .filter(
                      (s) =>
                        !formMembers.length ||
                        formMembers.find((m) => m.key === s.owner)?.kind ===
                          "ai",
                    )
                    .map((s) => ({
                      value: s.key,
                      label:
                        formMembers.find((m) => m.key === s.owner)?.name ??
                        s.name,
                    }))}
                />
                <small>
                  只执行这名员工；缺少的上游输入请在下方补充，不会自动运行其他员工。
                </small>
              </label>
            )}
            <label>
              工作要求
              <Input.TextArea
                aria-label="任务输入"
                disabled={restoring}
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="说明本次要完成什么"
                maxLength={20000}
              />
            </label>
            <div className="task-upload-area">
              <div>
                <strong>输入文件</strong>
                <small>
                  可选 · 补充文档、图片或原始数据，单个文件不超过 10 MB
                </small>
              </div>
              <Upload
                disabled={restoring}
                multiple
                showUploadList={false}
                beforeUpload={async (file) => {
                  try {
                    if (file.size > 10_000_000)
                      throw new Error("单个文件不能超过10MB");
                    const data = await encodeFile(file);
                    setAttachments((old) => [
                      ...old.filter((f) => f.name !== file.name),
                      { name: file.name, data },
                    ]);
                  } catch (e) {
                    setError(String(e));
                  }
                  return false;
                }}
              >
                <Button icon={<UploadOutlined />}>上传输入文件</Button>
              </Upload>
            </div>
            <div className="task-upload-files">
              {attachments.map((f) => (
                <Tag
                  closable={!restoring}
                  onClose={() =>
                    setAttachments((old) =>
                      old.filter((a) => a.name !== f.name),
                    )
                  }
                  key={f.name}
                >
                  {f.name}
                </Tag>
              ))}
            </div>
          </section>
          {!rerun && !editingDraft && (
            <TaskScheduleFields value={schedule} onChange={setSchedule} />
          )}
          {rerun && (
            <Checkbox
              checked={useLatest}
              onChange={(e) => setUseLatest(e.target.checked)}
            >
              使用团队最新配置（默认沿用原执行配置）
            </Checkbox>
          )}
        </div>
      </Drawer>
      <Drawer
        title="修改并从这里执行"
        open={!!restartNode}
        onClose={() => !busy && setRestartNode(undefined)}
        width="min(100vw, max(50vw, 520px))"
      >
        <p>
          从 {restartNode && run?.state.nodes[restartNode]?.employee.name}{" "}
          开始重做，保留上游成果。依赖该节点的下游也会重新执行，原尝试保留在历史中。
        </p>
        <Input.TextArea
          aria-label="修改要求"
          value={restartNote}
          onChange={(e) => setRestartNote(e.target.value)}
          placeholder="说明本次需要修改什么"
          rows={5}
        />
        <Button
          type="primary"
          loading={busy}
          disabled={!restartNote.trim()}
          onClick={async () => {
            if (
              run &&
              (await action(`/${run.id}/rework`, {
                node: restartNode,
                reason: restartNote,
              }))
            )
              setRestartNode(undefined);
          }}
        >
          从修改点执行
        </Button>
      </Drawer>
      <Drawer
        title={dataView === "inputs" ? "输入资料" : "执行成果"}
        open={!!dataView}
        onClose={() => setDataView(undefined)}
        width="min(100vw, max(50vw, 520px))"
      >
        {run &&
          (dataView === "inputs" ? (
            <>
              <p className="task-text">
                {run.inputs?.input_text || "未提供额外文本资料"}
              </p>
              {run.inputs?.attachments?.map(artifact)}
            </>
          ) : (
            <>
              <ExecutionOutput
                key={run.id}
                projectId={projectId}
                runId={run.id}
                root={run.directory!}
                status={run.status}
                summary={run.state.reply}
                error={run.state.error}
                files={Object.values(run.state.nodes).flatMap(
                  (n) => n.artifacts,
                )}
              />
              {run.state.reviews?.map((v, i) => (
                <p key={i}>
                  {v.approved ? "验收通过" : "已退回"} · {stamp(v.at)} ·{" "}
                  {v.note}
                </p>
              ))}
            </>
          ))}
        <Button
          onClick={() => {
            setDataView(undefined);
            setShowFiles(true);
          }}
        >
          浏览执行文件
        </Button>
      </Drawer>
      <Drawer
        title={chosenNode?.employee.name}
        open={!!chosenNode}
        onClose={() => setNodeKey(undefined)}
        width="min(100vw, max(50vw, 520px))"
      >
        {chosenNode && run && (
          <>
            <ExecutionOutput
              key={`${run.id}-${nodeKey}`}
              projectId={projectId}
              runId={run.id}
              root={run.directory!}
              editorRoot={
                chosenNode.attempt && run.directory
                  ? `${run.directory}/nodes/${nodeKey}/attempts/${chosenNode.attempt}`
                  : null
              }
              status={chosenNode.status}
              summary={chosenNode.summary || chosenNode.verification}
              error={chosenNode.error}
              files={chosenNode.artifacts}
            />
            {["failed", "interrupted", "cancelled"].includes(run.status) &&
              chosenNode.status !== "completed" && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(`/${run.id}/retry`, { node: nodeKey })
                  }
                >
                  重试此员工
                </Button>
              )}
          </>
        )}
      </Drawer>
      <Drawer
        title={preview?.name}
        open={!!preview}
        width="min(100vw, max(50vw, 520px))"
        onClose={() => setPreview(undefined)}
      >
        <Button href={preview?.url} icon={<DownloadOutlined />}>
          下载文件
        </Button>
        <pre className="task-file-preview">
          {preview?.text ?? preview?.reason}
        </pre>
      </Drawer>
      <Drawer
        title="Agent 日志"
        open={activityNode !== undefined && !!run}
        onClose={() => setActivityNode(undefined)}
        width="min(100vw, max(50vw, 520px))"
        destroyOnHidden
      >
        {activityNode !== undefined && run && (
          <AgentActivity
            key={`${run.id}-${activityNode}`}
            projectId={projectId}
            runId={run.id}
            nodes={run.state.nodes}
            initialNode={activityNode}
          />
        )}
      </Drawer>
      <Drawer
        title="执行文件"
        open={showFiles}
        width="min(100vw, max(50vw, 520px))"
        onClose={() => setShowFiles(false)}
      >
        {run && (
          <WorkspaceBrowser key={run.id} projectId={projectId} runId={run.id} />
        )}
      </Drawer>
    </section>
  );
}
