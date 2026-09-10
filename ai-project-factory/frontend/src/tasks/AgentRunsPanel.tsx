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
  draft: "未开始",
  pending: "未开始",
  queued: "排队中",
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
  onLegacy,
}: {
  projectId: string;
  launchEmployee?: { employee?: string; nonce: number };
  onLegacy?: (id: string) => void;
}) {
  const base = `/workspaces/${projectId}/agent-runs`;
  const [runs, setRuns] = useState<Run[]>([]),
    [legacy, setLegacy] = useState<WorkTask[]>([]);
  const [steps, setSteps] = useState<Step[]>([]),
    [members, setMembers] = useState<
      { key: string; name: string; kind: string }[]
    >([]);
  const [sources, setSources] = useState<
    { id: string; title: string; content: string; coverage: string }[]
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
  const [creating, setCreating] = useState(false),
    [rerun, setRerun] = useState<Run>(),
    [scope, setScope] = useState("workflow"),
    [node, setNode] = useState<string>();
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [inputText, setInputText] = useState(""),
    [acceptance, setAcceptance] = useState("");
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
    void api<
      { id: string; title: string; content: string; coverage: string }[]
    >(`/workspaces/${projectId}/sources`)
      .then((d) => alive && setSources(Array.isArray(d) ? d : []))
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
    setEditingDraft(undefined);
    setRerun(undefined);
    setTitle("");
    setDescription("");
    setInputText("");
    setAcceptance("");
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
  const history = runs.filter((r) => taskId(r) === selected);
  const run = history.find((r) => r.id === selectedRun) ?? history[0];
  const chosenNode = run && nodeKey ? run.state.nodes[nodeKey] : undefined;
  const active = run && ["running", "queued"].includes(run.status);
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
    const data = {
      title: title.trim() || description.trim().slice(0, 60),
      description,
      scope,
      node: scope === "node" ? node : null,
      input_text: inputText,
      acceptance,
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
    const payload = JSON.stringify(data);
    if (submission.current.payload !== payload)
      submission.current = { payload, requestId: crypto.randomUUID() };
    const result = await action(
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
      setTitle(run.title);
      setDescription(run.inputs?.description ?? "");
      setInputText(run.inputs?.input_text ?? "");
      setAcceptance(run.inputs?.acceptance ?? "");
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
                render: (_, r) => <Status status={r.status} />,
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
                      Object.values(r.run.state.nodes).find(
                        (n) => n.status === "running",
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
              !active && run.status !== "draft" ? (
                <Button disabled={busy} onClick={() => void again()}>
                  再次执行
                </Button>
              ) : undefined
            }
            nodes={run.state.nodes}
            status={run.status}
            busy={busy}
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
        title={editingDraft ? "编辑任务" : rerun ? "再次执行任务" : "新建任务"}
        open={creating}
        width="min(100vw, max(50vw, 520px))"
        onClose={() => !busy && setCreating(false)}
        footer={
          <Space>
            <Button disabled={busy} onClick={() => setCreating(false)}>
              取消
            </Button>
            {!rerun && (
              <Button
                disabled={busy || !(title.trim() || description.trim())}
                onClick={() => void submit(true)}
              >
                保存草稿
              </Button>
            )}
            <Button
              type="primary"
              loading={busy}
              disabled={
                !description.trim() ||
                !formSteps.length ||
                (scope === "workflow" && duplicateEmployees) ||
                (scope === "node" && !node)
              }
              onClick={() => void submit(!!editingDraft)}
            >
              {editingDraft ? "保存修改" : "开始执行"}
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
          <label>
            任务名称
            <Input
              aria-label="任务名称"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：8 月销售分析"
              maxLength={200}
            />
          </label>
          <label>
            执行范围
            <Select
              aria-label="运行范围"
              value={scope}
              disabled={!!rerun}
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
                      formMembers.find((m) => m.key === s.owner)?.kind === "ai",
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
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="说明本次要完成什么"
              maxLength={20000}
            />
          </label>
          <label>
            输入资料
            <Input.TextArea
              aria-label="输入资料"
              rows={4}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="补充原始数据、资料说明或上游结果"
              maxLength={20000}
            />
          </label>
          <Upload
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
          {attachments.map((f) => (
            <Tag
              closable
              onClose={() =>
                setAttachments((old) => old.filter((a) => a.name !== f.name))
              }
              key={f.name}
            >
              {f.name}
            </Tag>
          ))}
          <Select<string>
            aria-label="引用团队资料"
            placeholder="选择团队资料作为输入"
            value={undefined}
            options={sources.map((s) => ({ value: s.id, label: s.title }))}
            onChange={async (id) => {
              const source = sources.find((s) => s.id === id);
              if (!source) return;
              const name = `资料-${source.id.slice(-8)}.txt`;
              try {
                const data = await encodeFile(
                  new Blob([
                    `${source.title}\n资料覆盖范围：${source.coverage}\n\n${source.content}`,
                  ]),
                );
                setAttachments((old) => [
                  ...old.filter((f) => f.name !== name),
                  { name, data },
                ]);
              } catch (e) {
                setError(String(e));
              }
            }}
          />
          <Select<string>
            aria-label="引用已有成果"
            placeholder="选择已有执行成果作为输入"
            value={undefined}
            options={runs.flatMap((r) =>
              Object.values(r.state.nodes).flatMap((n) =>
                n.artifacts.map((f) => ({
                  value: JSON.stringify({ run: r.id, path: f.path }),
                  label: `${r.title} · ${n.employee.name} · ${f.path.split("/").pop()}`,
                })),
              ),
            )}
            onChange={async (value) => {
              try {
                const f = JSON.parse(value);
                const response = await fetch(
                  `/api${base}/${f.run}/artifact?path=${encodeURIComponent(f.path)}`,
                );
                if (!response.ok) throw new Error("成果读取失败");
                const data = await encodeFile(await response.blob());
                const name = `引用-${f.run.slice(-6)}-${f.path.split("/").pop()}`;
                setAttachments((old) => [
                  ...old.filter((a) => a.name !== name),
                  { name, data },
                ]);
              } catch (e) {
                setError(String(e));
              }
            }}
          />
          <label>
            验收要求
            <Input.TextArea
              aria-label="验收要求"
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              placeholder="什么结果才算完成"
              maxLength={10000}
            />
          </label>
          {rerun && (
            <Checkbox
              checked={useLatest}
              onChange={(e) => setUseLatest(e.target.checked)}
            >
              使用团队最新配置（默认沿用原执行配置）
            </Checkbox>
          )}
          <div className="task-brief">
            <strong>参与员工</strong>
            <p>
              {formSteps
                .filter(
                  (s) =>
                    scope === "workflow" || s.key === node || s.owner === node,
                )
                .filter(
                  (s, i, all) =>
                    all.findIndex((other) => other.owner === s.owner) === i,
                )
                .map(
                  (s) =>
                    formMembers.find((m) => m.key === s.owner)?.name ?? s.name,
                )
                .join("、") || "请先配置团队员工节点"}
            </p>
            <small>每名员工一个节点；本次配置和输入将在执行时固定。</small>
          </div>
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
