import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Tabs,
} from "antd";
import { api } from "../api";
import RunFlow, { type NodeAction } from "./RunFlow";
import OutputChain from "./EmployeeOutputChain";
import { DeliveryResults } from "../DeliveryPanel";
import type { TaskDefinition, TaskRun, TaskSource, WorkTask } from "./types";
import "./tasks.css";
import AgentRunsPanel from "./AgentRunsPanel";

export default function TasksPanel(props: {
  projectId: string;
  onSources: () => void;
}) {
  return (
    <Tabs
      items={[
        {
          key: "agents",
          label: "智能体任务",
          children: (
            <AgentRunsPanel key={props.projectId} projectId={props.projectId} />
          ),
        },
        {
          key: "code",
          label: "代码交付与历史记录",
          children: <LegacyTasksPanel {...props} />,
        },
      ]}
    />
  );
}
const statuses: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  completed: "参考测试通过",
  blocked: "需要处理",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "运行中断",
};
const stages: Record<string, string> = {
  baseline: "基线测试",
  environment: "准备环境",
  analyze: "需求与架构",
  develop: "开发修复",
  test: "测试验证",
  complete: "验证完成",
  blocked: "执行受阻",
};
const empty: TaskDefinition = {
  title: "",
  description: "",
  acceptance: "",
  code_source_id: null,
};
const isActive = (status?: string) =>
  ["queued", "running"].includes(status ?? "");

function RunDetails({
  run,
  runs,
  exportUrl,
  activeTab,
  onTab,
}: {
  run: TaskRun;
  runs: TaskRun[];
  exportUrl: string;
  activeTab: string;
  onTab: (key: string) => void;
}) {
  return (
    <div className="task-run-detail" id="task-run-evidence">
      <div className="task-run-meta">
        <Tag>{statuses[run.status] ?? run.status}</Tag>
        <span>
          团队修订 {run.design_version} · 任务修订{" "}
          {run.inputs.task_snapshot?.version ?? "—"}
        </span>
        <Button href={exportUrl}>下载运行记录</Button>
      </div>
      <p>
        {run.result.summary ||
          run.error ||
          stages[run.result.stage ?? ""] ||
          "等待执行器开始工作"}
      </p>
      <Tabs
        activeKey={activeTab}
        onChange={onTab}
        items={[
          {
            key: "outputs",
            label: "员工产出链",
            children: (
              <OutputChain
                run={run}
                runs={runs}
                workspaceBase={
                  exportUrl.slice(0, exportUrl.lastIndexOf("/runs/")) + "/runs"
                }
              />
            ),
          },
          {
            key: "results",
            label: "测试与运行详情",
            children: (
              <>
                <Alert
                  type="info"
                  showIcon
                  message="当前执行需求/架构分析、源码修复与参考测试；部署尚未接通。测试通过不代表已部署。"
                />
                <DeliveryResults
                  attempts={run.result.attempts ?? []}
                  referenceFiles={
                    Object.keys(run.result.reference_tests ?? {}).length
                  }
                />
                {run.result.plan != null && (
                  <details>
                    <summary>需求与架构文档</summary>
                    <pre>{JSON.stringify(run.result.plan, null, 2)}</pre>
                  </details>
                )}
                {(run.result.artifacts ?? []).map((file) => (
                  <details key={file.path}>
                    <summary>{file.path}</summary>
                    <pre>{file.content}</pre>
                  </details>
                ))}
                {run.result.workspace && (
                  <p>
                    服务端产物目录：<code>{run.result.workspace}</code>
                  </p>
                )}
              </>
            ),
          },
          {
            key: "input",
            label: "本轮输入",
            children: (
              <>
                <h4>冻结的任务说明</h4>
                <p>{run.inputs.task_snapshot?.description}</p>
                <h4>验收要求</h4>
                <p>
                  {run.inputs.task_snapshot?.acceptance || "按参考测试验收"}
                </p>
                <p>源码快照：{run.inputs.code_source_id}</p>
                <p>继续自：{run.inputs.resume_run_id ?? "原始输入基线"}</p>
                <h4>员工版本</h4>
                {run.inputs.team_snapshot?.map((e) => (
                  <Tag key={e.key}>
                    {e.key} · v{e.version}
                  </Tag>
                ))}
              </>
            ),
          },
          {
            key: "logs",
            label: "执行日志",
            children: (
              <pre>
                {run.result.events?.join("\n") || run.error || "暂无日志"}
              </pre>
            ),
          },
        ]}
      />
    </div>
  );
}

export function LegacyTasksPanel({
  projectId,
  onSources,
}: {
  projectId: string;
  onSources: () => void;
}) {
  const [tasks, setTasks] = useState<WorkTask[]>([]),
    [sources, setSources] = useState<TaskSource[]>([]);
  const [selected, setSelected] = useState<string | null>(() =>
      window.location.hash.startsWith(`#/projects/${projectId}/tasks`)
        ? new URLSearchParams(window.location.hash.split("?")[1]).get("task")
        : null,
    ),
    [detail, setDetail] = useState<WorkTask | null>(null);
  const [editing, setEditing] = useState(false),
    [form] = Form.useForm<TaskDefinition>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [attempts, setAttempts] = useState(2);
  const [activeTab, setActiveTab] = useState("outputs");
  const [runId, setRunId] = useState<string | null>(null);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const prefix = `/workspaces/${projectId}/tasks`;
  function selectTask(id: string | null) {
    setSelected(id);
    selectedRef.current = id;
    if (window.location.hash.startsWith(`#/projects/${projectId}/tasks`)) {
      window.history.replaceState(
        null,
        "",
        `#/projects/${projectId}/tasks${id ? `?task=${encodeURIComponent(id)}` : ""}`,
      );
    }
  }
  const [syncError, setSyncError] = useState("");
  const refresh = useCallback(async () => {
    const [list, sourceList] = await Promise.all([
      api<WorkTask[]>(prefix),
      api<TaskSource[]>(`/workspaces/${projectId}/task-sources`),
    ]);
    setTasks(list);
    setSources(sourceList.filter((s) => s.kind === "code"));
    const id = selectedRef.current;
    if (id) {
      const task = await api<WorkTask>(`${prefix}/${id}`);
      if (selectedRef.current === id) setDetail(task);
    }
    setSyncError("");
  }, [prefix, projectId]);
  useEffect(() => {
    void refresh().catch((e) => setSyncError(e.message));
    let pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        await refresh();
      } catch (e) {
        setSyncError((e as Error).message);
      } finally {
        pending = false;
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [refresh]);
  async function open(task: WorkTask) {
    selectTask(task.id);
    setDetail(null);
    setEditing(false);
    setRunId(null);
    setError("");
    try {
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save(values: TaskDefinition) {
    setBusy(true);
    setError("");
    try {
      const result = await api<WorkTask>(
        selected ? `${prefix}/${selected}` : prefix,
        {
          method: selected ? "PUT" : "POST",
          body: JSON.stringify({
            ...values,
            code_source_id: values.code_source_id || null,
            ...(selected ? { expected_version: editVersion.current } : {}),
          }),
        },
      );
      setEditing(false);
      selectTask(result.id);
      setDetail(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const editVersion = useRef(0);
  function edit(task?: WorkTask) {
    setError("");
    editVersion.current = task?.version ?? 0;
    if (!task) {
      selectTask(null);
      setDetail(null);
    }
    form.setFieldsValue(task ?? empty);
    setEditing(true);
  }
  async function start(resume?: string, action?: NodeAction) {
    if (!detail) return;
    setBusy(true);
    setError("");
    const signature = JSON.stringify([
      detail.id,
      detail.version,
      resume,
      attempts,
      action,
    ]);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      const run = await api<TaskRun>(`${prefix}/${detail.id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          expected_version: detail.version,
          request_id: request.current.id,
          resume_run_id: resume ?? null,
          max_attempts: attempts,
          offline: false,
          ...action,
        }),
      });
      request.current = null;
      setRunId(run.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(run: TaskRun) {
    setBusy(true);
    setError("");
    try {
      await api(`/evaluations/${run.id}/cancel`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const runs = detail?.runs ?? [],
    run = runs.find((r) => r.id === runId) ?? runs[0];
  const projectBusy = tasks.some((t) => isActive(t.latest_run?.status));
  return (
    <section className="tasks-panel">
      <div className="tasks-header">
        <div>
          <h2>任务与运行</h2>
          <p>
            同一支团队，持续交付不同任务。每次运行独立保存输入、版本与产出。
          </p>
        </div>
        <Space>
          <Button onClick={onSources}>管理输入资料</Button>
          <Button type="primary" disabled={busy} onClick={() => edit()}>
            新建任务
          </Button>
        </Space>
      </div>
      {(error || syncError) && (
        <Alert
          type="error"
          message={error || syncError}
          closable
          onClose={() => {
            setError("");
            setSyncError("");
          }}
        />
      )}
      {editing ? (
        <div className="task-editor">
          <h3>{selected ? "修改任务输入" : "新建任务，例如开发 Agent1"}</h3>
          <Form
            form={form}
            layout="vertical"
            initialValues={empty}
            onFinish={save}
          >
            <Form.Item
              name="title"
              label="任务名称"
              rules={[{ required: true, whitespace: true }]}
            >
              <Input maxLength={200} placeholder="例如：开发 Agent1" />
            </Form.Item>
            <Form.Item
              name="description"
              label="任务说明"
              rules={[
                {
                  required: true,
                  min: 10,
                  message: "请填写至少 10 字的任务说明",
                },
              ]}
            >
              <Input.TextArea
                rows={4}
                maxLength={4000}
                placeholder="说明输入、需要完成的工作和交付目标"
              />
            </Form.Item>
            <Form.Item name="code_source_id" label="输入源码与测试快照">
              <Select
                allowClear
                placeholder="选择此任务使用的源码快照，可稍后补充"
                options={sources.map((s) => ({ value: s.id, label: s.title }))}
              />
            </Form.Item>
            <Form.Item name="acceptance" label="验收要求">
              <Input.TextArea
                rows={3}
                maxLength={1000}
                placeholder="例如保留原有测试，全部通过并提交变更说明"
              />
            </Form.Item>
            <p>
              保存修改后，新运行使用新输入；已经启动的运行保留原来的输入快照。
            </p>
            <Space>
              <Button type="primary" htmlType="submit" loading={busy}>
                保存任务
              </Button>
              <Button onClick={() => setEditing(false)} disabled={busy}>
                取消
              </Button>
            </Space>
          </Form>
        </div>
      ) : selected ? (
        detail ? (
          <>
            <div className="tasks-header">
              <div>
                <Button
                  type="link"
                  onClick={() => {
                    selectTask(null);
                    setDetail(null);
                  }}
                >
                  返回任务列表
                </Button>
                <h3>{detail.title}</h3>
                <p>{detail.description}</p>
              </div>
              <Button disabled={busy} onClick={() => edit(detail)}>
                修改任务
              </Button>
            </div>
            <div className="task-start">
              <span>任务修订 {detail.version}</span>
              <span>每轮最多修复</span>
              <InputNumber
                aria-label="最大修复轮次"
                min={1}
                max={4}
                value={attempts}
                onChange={(n) => setAttempts(n ?? 2)}
              />
              <span>次</span>
              <Button
                type="primary"
                loading={busy}
                disabled={projectBusy || !detail.code_source_id}
                onClick={() => void start()}
              >
                从输入基线运行
              </Button>
            </div>
            {!detail.code_source_id && (
              <Alert
                type="info"
                message="任务已保存，请导入源码与测试样例，并在修改任务中选择快照后开始运行。"
                action={<Button onClick={onSources}>导入资料</Button>}
              />
            )}
            {projectBusy && (
              <p>当前AI 团队正在执行任务，请等待结束或停止后再启动下一轮。</p>
            )}
            {run?.inputs.task_snapshot &&
              run.inputs.task_snapshot.version < detail.version && (
                <Alert
                  type="info"
                  message={`当前任务输入已更新至修订 ${detail.version}；下方运行保留修订 ${run.inputs.task_snapshot.version} 的输入与结果，重新运行后才会验证新输入。`}
                />
              )}
            {runs.length ? (
              <>
                <div className="task-run-select">
                  <Select
                    aria-label="选择运行记录"
                    value={run?.id}
                    onChange={setRunId}
                    options={runs.map((r, index) => ({
                      value: r.id,
                      label: `第 ${runs.length - index} 次 · ${statuses[r.status] ?? r.status} · ${new Date(r.created_at).toLocaleString()}`,
                    }))}
                  />
                  {run && isActive(run.status) ? (
                    <Button disabled={busy} onClick={() => void cancel(run)}>
                      停止运行
                    </Button>
                  ) : run &&
                    ["completed", "blocked"].includes(run.status) &&
                    run.result.workspace ? (
                    <Button
                      disabled={busy || projectBusy}
                      onClick={() => void start(run.id)}
                    >
                      从此代码版本继续
                    </Button>
                  ) : null}
                </div>
                {run && (
                  <>
                    <RunFlow
                      onInspect={(key) => {
                        setActiveTab(key);
                        document
                          .getElementById("task-run-evidence")
                          ?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          });
                      }}
                      run={run}
                      url={`${prefix}/${detail.id}/runs/${run.id}/flow`}
                      disabled={busy || projectBusy}
                      onRun={(action) => void start(run.id, action)}
                    />
                    <RunDetails
                      activeTab={activeTab}
                      onTab={setActiveTab}
                      run={run}
                      runs={runs}
                      exportUrl={`/api${prefix}/${detail.id}/runs/${run.id}/export`}
                    />
                  </>
                )}
              </>
            ) : (
              <Empty description="暂无运行。准备好输入后，启动此任务的第一次执行。" />
            )}
          </>
        ) : (
          <div>
            <Button
              onClick={() => {
                selectTask(null);
                setError("");
              }}
            >
              返回任务列表
            </Button>
            <p>
              {error ? "未能打开此任务，请重试或返回列表" : "正在加载任务…"}
            </p>
          </div>
        )
      ) : (
        <Table
          rowKey="id"
          dataSource={tasks}
          locale={{
            emptyText: "还没有任务。可以先创建 Agent1、Agent2 等任务。",
          }}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: "任务",
              dataIndex: "title",
              render: (_, t) => (
                <Button type="link" onClick={() => void open(t)}>
                  {t.title}
                </Button>
              ),
            },
            {
              title: "状态",
              render: (_, t) => (
                <Tag>
                  {t.latest_run
                    ? (statuses[t.latest_run.status] ?? t.latest_run.status)
                    : "待运行"}
                </Tag>
              ),
            },
            {
              title: "当前环节",
              render: (_, t) => stages[t.latest_run?.stage ?? ""] ?? "—",
            },
            { title: "运行次数", dataIndex: "run_count" },
            { title: "输入修订", dataIndex: "version" },
            {
              title: "操作",
              render: (_, t) => (
                <Button onClick={() => void open(t)}>查看任务</Button>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
