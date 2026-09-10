import { useState } from "react";
import { Alert, Button, Input } from "antd";
import { api } from "./api";
export default function EmployeeTrial({
  employeeId,
  disabled,
  onStarted,
}: {
  employeeId: string;
  disabled: boolean;
  onStarted: () => Promise<void>;
}) {
  const [input, setInput] = useState('{"records":[]}');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run() {
    setError("");
    setBusy(true);
    try {
      JSON.parse(input);
      await api(`/employees/${employeeId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input_json: input }),
      });
      await onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="source-form">
      <summary>给员工新输入并试运行</summary>
      <p>
        使用员工当前保存版本，输入结构见上方工程与样例。执行结果保存到AI 团队运行记录；没有预期答案的试运行不计为验收通过。
      </p>
      <Input.TextArea
        aria-label="员工试运行JSON输入"
        rows={6}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {error && <Alert type="error" message={error} />}
      <Button loading={busy} disabled={disabled} onClick={() => void run()}>
        运行员工
      </Button>
    </details>
  );
}
