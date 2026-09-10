import { useState } from "react";
import { Alert, Button, Input, Table, Tag } from "antd";
import { api } from "./api";
export type DeliveryAttempt = {
  attempt: number;
  summary?: string;
  error?: string;
  exit_code?: number;
  output?: string;
  changed_files?: string[];
  reference_intact?: boolean;
  tests?: {
    missing_reference_classes?: string[];
    executed: number;
    passed: number;
    failed: number;
    skipped: number;
    cases: {
      suite: string;
      name: string;
      status: string;
      difference?: string;
    }[];
  };
};
export function DeliveryResults({
  attempts,
  referenceFiles,
}: {
  attempts: DeliveryAttempt[];
  referenceFiles: number;
}) {
  return (
    <section className="source-import">
      <h3>员工能力与参考样例对比</h3>
      <p>
        参考基准：源码中 {referenceFiles}{" "}
        个原有测试文件。样例体现了哪些行为被要求，不代表人类全部能力，也不保证业务覆盖完整。
      </p>
      <Table
        size="small"
        pagination={false}
        rowKey="attempt"
        dataSource={attempts}
        columns={[
          {
            title: "版本 / 轮次",
            dataIndex: "attempt",
            render: (n: number) =>
              n === 0 ? "本轮起始版本" : `开发员工 · 第 ${n} 轮`,
          },
          {
            title: "实际执行",
            render: (_, r) => r.tests?.executed ?? "未运行",
          },
          { title: "通过", render: (_, r) => r.tests?.passed ?? "—" },
          { title: "失败", render: (_, r) => r.tests?.failed ?? "—" },
          { title: "跳过", render: (_, r) => r.tests?.skipped ?? "—" },
          {
            title: "结论",
            render: (_, r) => (
              <Tag
                color={
                  r.exit_code === 0 &&
                  r.tests &&
                  r.tests.executed > 0 &&
                  !r.tests.failed &&
                  !r.tests.skipped &&
                  !r.tests.missing_reference_classes?.length
                    ? "green"
                    : "orange"
                }
              >
                {r.exit_code === 0 &&
                r.tests &&
                r.tests.executed > 0 &&
                !r.tests.failed &&
                !r.tests.skipped &&
                !r.tests.missing_reference_classes?.length
                  ? "参考测试通过"
                  : r.tests?.executed
                    ? "尚未通过"
                    : "构建阻塞 / 未执行"}
              </Tag>
            ),
          },
        ]}
      />
      {attempts.map((a) => (
        <details className="source-form" key={a.attempt}>
          <summary>
            {a.attempt === 0 ? "本轮起始版本" : `第 ${a.attempt} 轮`} ·
            查看改动、实际输出与参考测试
          </summary>
          <p>{a.summary || a.error}</p>
          <p>
            变更文件：{a.changed_files?.join("、") || "无"}
            {a.reference_intact !== undefined
              ? ` · 原测试哈希${a.reference_intact ? "一致" : "不一致"}`
              : ""}
          </p>
          <pre>{a.output}</pre>
          {a.tests?.cases.map((c, i) => (
            <p key={i}>
              {c.suite}.{c.name}：{c.status} {c.difference}
            </p>
          ))}
        </details>
      ))}
    </section>
  );
}
export default function DeliveryPanel({
  projectId,
  disabled,
  onStarted,
}: {
  projectId: string;
  disabled: boolean;
  onStarted: () => Promise<void>;
}) {
  const [goal, setGoal] = useState(
    "基于AI 团队原有测试样例明确要求，分析架构和构建失败，自动修复源码副本并重新执行所有原测试。不得修改参考测试、减少模块或伪造成功。",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function start() {
    setBusy(true);
    setError("");
    try {
      await api(`/workspaces/${projectId}/delivery-runs`, {
        method: "POST",
        body: JSON.stringify({ goal, max_attempts: 2, offline: false }),
      });
      await onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="source-import">
      <h3>让AI 团队按原有样例自动开发</h3>
      <p>
        冻结源码测试 → 执行基线 → Codex 分析需求与架构 → 开发修复 → 原测试回归 →
        质量对比。每轮保留证据。
      </p>
      <Alert
        type="info"
        message="当前支持 Gradle/JUnit 源码AI 团队，允许下载构建依赖；在副本运行，部署不在本轮验证范围。"
      />
      <Input.TextArea
        aria-label="AI 团队自动开发任务说明"
        rows={4}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      {error && <Alert type="error" message={error} />}
      <Button
        type="primary"
        disabled={disabled || goal.trim().length < 10}
        loading={busy}
        onClick={() => void start()}
      >
        启动AI 团队自动开发与样例验证
      </Button>
    </section>
  );
}
