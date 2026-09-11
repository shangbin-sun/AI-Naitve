import type { ReactNode } from "react";
import { Button, Tag } from "antd";

type Node = {
  employee: { name: string; kind?: string };
  step: { depends_on?: string[] };
  status: string;
  activity?: string;
  preparing_at?: string;
  started_at?: string;
  finished_at?: string;
  artifacts: unknown[];
};
const labels: Record<string, string> = {
  skipped: "无需处理",
  pending: "未开始",
  draft: "未开始",
  queued: "准备中",
  preparing: "准备中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  waiting_human: "等待人工",
  interrupted: "已中断",
  cancelled: "已停止",
};
export default function ExecutionWorkflow({
  nodes,
  status,
  busy,
  onOpen,
  onRestart,
  onData,
  onLogs,
  onTune,
  actions,
}: {
  actions?: ReactNode;
  nodes: Record<string, Node>;
  status: string;
  busy: boolean;
  onOpen: (key: string) => void;
  onRestart: (key: string) => void;
  onLogs: (node: string) => void;
  onTune?: (node: string) => void;
  onData: (view: "inputs" | "outputs") => void;
}) {
  const entries = Object.entries(nodes),
    active = ["running", "queued"].includes(status);
  const layers: string[][] = [];
  const placed = new Set<string>();
  while (placed.size < entries.length) {
    const ready = entries
      .filter(
        ([key, n]) =>
          !placed.has(key) &&
          (n.step.depends_on ?? []).every((d) => !nodes[d] || placed.has(d)),
      )
      .map(([key]) => key);
    if (!ready.length) {
      layers.push(entries.filter(([k]) => !placed.has(k)).map(([k]) => k));
      break;
    }
    layers.push(ready);
    ready.forEach((k) => placed.add(k));
  }
  const height = Math.max(170, ...layers.map((l) => l.length * 150 + 20));
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, i) =>
    layer.forEach((key, j) =>
      positions.set(key, {
        x: 150 + i * 250,
        y: (height - layer.length * 150) / 2 + j * 150 + 10,
      }),
    ),
  );
  const width = 300 + layers.length * 250;
  const duration = (n: Node) =>
    n.started_at
      ? `${Math.max(0, Math.round((new Date(n.finished_at ?? new Date()).getTime() - new Date(n.started_at).getTime()) / 1000))} 秒`
      : n.preparing_at
        ? `准备 ${Math.max(0, Math.round((new Date(n.finished_at ?? new Date()).getTime() - new Date(n.preparing_at).getTime()) / 1000))} 秒`
        : "尚未开始";
  return (
    <section className="execution-workflow" aria-label="执行工作流">
      <div className="execution-workflow-title">
        <strong>执行工作流</strong>
        <span>
          {
            entries.filter(([, n]) =>
              ["completed", "skipped"].includes(n.status),
            ).length
          }{" "}
          / {entries.length} 员工已完成
        </span>
      </div>
      {actions && <div className="execution-workflow-actions">{actions}</div>}
      <div className="execution-coordinator" aria-label="主 Agent 节点">
        <div><strong>主 Agent</strong><Tag color={active ? "processing" : "default"}>{labels[status] ?? status}</Tag></div>
        <small>任务调度与结果校验</small>
        <Button type="text" size="small" onClick={() => onLogs("")} aria-label="查看主 Agent 日志">查看日志</Button>
      </div>
      <div className="execution-workflow-scroll">
        <div className="execution-workflow-stage" style={{ width, height }}>
          <svg
            width={width}
            height={height}
            className="execution-workflow-lines"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="execution-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0 0 L10 5 L0 10z" fill="var(--flow-edge)" />
              </marker>
            </defs>
            {entries.flatMap(([key, n]) => {
              const to = positions.get(key)!;
              const deps = (n.step.depends_on ?? []).filter((d) =>
                positions.has(d),
              );
              return (deps.length ? deps : [null]).map((dep) => {
                const from = dep ? positions.get(dep)! : null;
                const x = from ? from.x + 210 : 110,
                  y = from ? from.y + 52 : height / 2;
                return (
                  <path
                    key={`${dep}-${key}`}
                    d={`M${x},${y} C${x + 20},${y} ${to.x - 20},${to.y + 52} ${to.x},${to.y + 52}`}
                    stroke={
                      dep && nodes[dep].status === "completed"
                        ? "var(--status-success)"
                        : "var(--flow-edge)"
                    }
                    fill="none"
                    markerEnd="url(#execution-arrow)"
                  />
                );
              });
            })}
            {entries
              .filter(
                ([key]) =>
                  !entries.some(([, n]) => n.step.depends_on?.includes(key)),
              )
              .map(([key]) => {
                const p = positions.get(key)!;
                return (
                  <path
                    key={key}
                    d={`M${p.x + 210},${p.y + 52} L${width - 130},${height / 2}`}
                    stroke="var(--flow-edge)"
                    markerEnd="url(#execution-arrow)"
                  />
                );
              })}
          </svg>
          <button
            className="execution-boundary input-boundary"
            style={{ left: 10, top: height / 2 - 20 }}
            onClick={() => onData("inputs")}
          >
            输入资料
          </button>
          {entries.map(([key, n]) => {
            const p = positions.get(key)!,
              state =
                ["preparing", "running"].includes(n.status) && !active ? "interrupted" : n.status;
            return (
              <div
                key={key}
                className={`execution-employee ${n.employee.kind === "human" ? "human-employee" : "ai-employee"} state-${state}`}
                style={{ left: p.x, top: p.y }}
              >
                <button
                  className="execution-employee-main"
                  onClick={() => onOpen(key)}
                  aria-label={`查看执行 ${n.employee.name}`}
                >
                  <div>
                    <strong>{n.employee.name}</strong>
                    <Tag
                      color={
                        ["preparing", "running"].includes(state)
                          ? "processing"
                          : ["completed", "skipped"].includes(state)
                            ? "success"
                            : state === "failed"
                              ? "error"
                              : state === "waiting_human"
                                ? "warning"
                                : "default"
                      }
                    >
                      {labels[state] ?? state}
                    </Tag>
                  </div>
                  <p>
                    {state === "pending"
                      ? "等待前置工作"
                      : n.activity || labels[state]}
                  </p>
                  <small>
                    {duration(n)} · {n.artifacts.length} 份产物
                  </small>
                </button>
                <div className="execution-node-actions">
                  {onTune && n.employee.kind !== "human" && <Button type="text" size="small" onClick={() => onTune(key)}>与员工对话</Button>}
                  <Button type="text" size="small" onClick={() => onLogs(key)} aria-label={`查看${n.employee.name}日志`}>查看日志</Button>
                <Button
                  type="text"
                  size="small"
                  disabled={busy || active || status === "draft"}
                  onClick={() => onRestart(key)}
                >
                  从这里执行
                </Button>
                </div>
              </div>
            );
          })}
          <button
            className="execution-boundary output-boundary"
            style={{ left: width - 120, top: height / 2 - 20 }}
            onClick={() => onData("outputs")}
          >
            查看成果
          </button>
        </div>
      </div>
    </section>
  );
}
