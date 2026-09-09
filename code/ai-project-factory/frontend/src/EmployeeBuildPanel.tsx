import { useState } from "react";
import { Alert, Button, Input } from "antd";
import { api } from "./api";
export default function EmployeeBuildPanel({
  projectId,
  disabled,
  onStarted,
}: {
  projectId: string;
  disabled: boolean;
  onStarted: () => Promise<void>;
}) {
  const [goal, setGoal] = useState(
    "根据已导入的感知、模型和执行数据资料，自动开发一个可复用的数据契约整理员工：读取JSON字段记录，保留来源、显式处理未知和矛盾，输出规范化契约和待确认问题。自动提取候选样例，生成可执行工程，测试失败后修复并复测。",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function start() {
    setBusy(true);
    setError("");
    try {
      await api(`/workspaces/${projectId}/employee-builds`, {
        method: "POST",
        body: JSON.stringify({ goal, max_attempts: 2 }),
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
      <h3>让系统开发员工</h3>
      <p>
        平台调用 Codex：提取样例 → 生成工程 → 隔离执行测试 → 自动修复 →
        验证后登记员工。
      </p>
      <Alert
        type="info"
        message="当前支持 Python 标准库数据处理员工；从资料派生的样例仍需业务确认，不代表完整 IT 项目验收。"
      />
      <Input.TextArea
        aria-label="员工自动开发目标"
        rows={4}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      {error && <Alert type="error" message={error} />}
      <Button
        type="primary"
        loading={busy}
        disabled={disabled || goal.trim().length < 10}
        onClick={() => void start()}
      >
        自动开发并验证员工
      </Button>
    </section>
  );
}
