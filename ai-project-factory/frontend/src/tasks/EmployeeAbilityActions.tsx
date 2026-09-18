import { requestId } from "../requestId";
import { type ReactNode, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { api } from "../api";
import { ExperimentOutlined, EditOutlined } from "@ant-design/icons";

export type ChatEvaluation = {
  employee_id: string;
  employee_version: number;
  case_id: string;
  run_id: string;
  reused: boolean;
};

export default function EmployeeAbilityActions({
  base, disabled, running, onGenerate, onEvaluate, children,
}: {
  children?: ReactNode;
  base: string;
  disabled: boolean;
  running: boolean;
  onGenerate: () => Promise<boolean>;
  onEvaluate: (evaluation: ChatEvaluation) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const locked = useRef(false);
  const request = useRef("");

  async function generate() {
    if (locked.current || disabled || running) return;
    locked.current = true;
    setGenerating(true);
    setError("");
    try {
      await onGenerate();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setGenerating(false);
    }
  }

  async function evaluate() {
    if (locked.current || disabled || running) return;
    locked.current = true;
    setBusy(true);
    setError("");
    // Keep this ID on failure: the server may have accepted a lost response.
    if (!request.current) request.current = requestId();
    try {
      const result = await api<ChatEvaluation>(base + "/evaluation", {
        method: "POST",
        body: JSON.stringify({ request_id: request.current }),
      });
      request.current = "";
      onEvaluate(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      locked.current = false;
    }
  }

  return <>
    <span className="employee-ability-actions">
      <Button type="default" aria-label="增强员工能力" icon={<EditOutlined aria-hidden="true" />}
        disabled={disabled || busy} loading={running || generating}
        onClick={() => void generate()}>增强员工能力</Button>
      <Button type="default" aria-label="评测与调优" icon={<ExperimentOutlined aria-hidden="true" />}
        disabled={disabled || running || generating || busy} loading={busy}
        title="使用当前聊天对应的评测案例，直接开始基线评测"
        onClick={() => void evaluate()}>评测与调优</Button>
      {children}
    </span>
    {error && <Alert type="error" message={error} closable onClose={() => setError("")} />}
  </>;
}
