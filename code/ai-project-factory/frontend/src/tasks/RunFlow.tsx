import { useEffect, useState } from "react";
import { Alert, Button, Tag } from "antd";
import { api } from "../api";
import type { TaskRun } from "./types";
export type NodeAction = {
  restart_node: "analysis" | "develop" | "test";
  edits_digest?: string;
};
type Node = {
  key: string;
  title: string;
  worker: string;
  state: string;
  modified_files: string[];
  stale?: boolean;
  calls: number;
};
type Flow = {
  run_id: string;
  nodes: Node[];
  edits_digest: string;
  changes: { name: string }[];
};
const labels: Record<string, string> = {
  pending: "待执行",
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  reused: "复用历史方案",
  skipped: "本轮无需执行",
  blocked: "需要处理",
  needs_repair: "基线未通过",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
  unavailable: "未接入",
};
export default function RunFlow({
  run,
  url,
  disabled,
  onRun,
  onInspect,
}: {
  run: TaskRun;
  url: string;
  disabled: boolean;
  onRun: (action: NodeAction) => void;
  onInspect?: (tab: string) => void;
}) {
  const [flow, setFlow] = useState<Flow | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let stopped = false,
      pending = false;
    setFlow(null);
    setError("");
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const data = await api<Flow>(url);
        if (!Array.isArray(data.nodes) || !Array.isArray(data.changes))
          throw new Error("节点状态数据格式异常，请刷新重试");
        if (!stopped) {
          setFlow(data);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [url]);
  const active = ["queued", "running"].includes(run.status);
  return (
    <section className="run-flow" aria-label="员工工作流程">
      <h3>员工工作流程</h3>
      <p>当前运行的真实执行节点 · 每 4 秒同步状态与工作文件修改</p>
      {error && <Alert type="error" message={error} />}
      {flow?.changes.length ? (
        <Alert
          type="warning"
          message={`工作文件已修改 ${flow.changes.length} 项，原测试结果不再代表这些修改。`}
          description={flow.changes.map((c) => c.name).join("、")}
        />
      ) : null}
      <div className="run-flow-nodes">
        {flow?.nodes.map((node, index) => (
          <article
            key={node.key}
            className={`run-flow-node state-${node.state}`}
          >
            <span className="run-flow-index">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h4>{node.title}</h4>
            {onInspect && node.key !== "deploy" && (
              <Button
                type="link"
                size="small"
                onClick={() =>
                  onInspect(
                    ["baseline", "test"].includes(node.key)
                      ? "results"
                      : "outputs",
                  )
                }
              >
                {["baseline", "test"].includes(node.key)
                  ? "查看测试记录"
                  : "查看员工文件"}
              </Button>
            )}
            <p>{node.worker}</p>
            <Tag
              color={
                node.state === "completed"
                  ? "green"
                  : node.state === "running"
                    ? "blue"
                    : node.state === "failed"
                      ? "red"
                      : undefined
              }
            >
              {labels[node.state] ?? node.state}
            </Tag>
            {node.modified_files.length > 0 && <Tag color="orange">已修改</Tag>}
            {node.stale && <Tag color="orange">需重新验证</Tag>}
            {["analyze", "develop", "test"].includes(node.key) && (
              <Button
                size="small"
                disabled={
                  disabled ||
                  active ||
                  !flow ||
                  flow.run_id !== run.id ||
                  !!error
                }
                onClick={() =>
                  onRun({
                    restart_node:
                      node.key === "analyze"
                        ? "analysis"
                        : (node.key as "develop" | "test"),
                    ...(flow.changes.length
                      ? { edits_digest: flow.edits_digest }
                      : {}),
                  })
                }
              >
                {node.key === "test"
                  ? "Run · 仅测试"
                  : node.key === "analyze"
                    ? "Run · 重新分析"
                    : "Run · 从开发继续"}
              </Button>
            )}
          </article>
        ))}
      </div>
      <p className="run-flow-note">
        Run
        会保留历史并创建新运行。分析或开发会继续执行下游测试；仅测试会验证当前代码。支持采用
        workspace 中已有方案与源码文件的修改；归档文件和新建文件不作为运行输入。
      </p>
    </section>
  );
}
