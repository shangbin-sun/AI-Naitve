import { Alert, Empty } from "antd";
import "./task-center.css";
import Editor, { type EmployeeWorkflow } from "./EmployeeWorkflowEditor";

export default function EmployeeWorkflowTab({ files, saving, dirty, onChange, onSave }: {
  files: Record<string, string>;
  saving: boolean;
  dirty: boolean;
  onChange: (files: Record<string, string>) => void;
  onSave: () => void;
}) {
  const raw = files["workflow.json"];
  if (!raw) return <Empty description="还没有已保存的 WorkFlow。请先在员工对话中点击「增强员工能力」，确认生成结果并保存后，即可在这里查看和编辑。" />;
  let workflow: EmployeeWorkflow;
  try {
    workflow = JSON.parse(raw);
    if (workflow && (workflow.approach !== undefined || workflow.inputs !== undefined || workflow.outputs !== undefined)) {
      if (typeof workflow.approach !== 'string' || ![workflow.inputs, workflow.outputs].every(items =>
        Array.isArray(items) && items.every(item => item && ['id','name','description','format','validation'].every(key => typeof (item as unknown as Record<string, unknown>)[key] === 'string') && typeof item.required === 'boolean'))) throw new Error('invalid contract');
    }
    if (!workflow || typeof workflow.title !== "string" || typeof workflow.goal !== "string" || !Array.isArray(workflow.steps) || !workflow.steps.length ||
      workflow.steps.some(s => !s || [s.id, s.name, s.goal, s.input, s.output, s.acceptance].some(v => typeof v !== "string") ||
        (s.description !== undefined && typeof s.description !== "string") ||
        !Array.isArray(s.requirements) || !Array.isArray(s.actions) || [...s.requirements, ...s.actions].some(v => typeof v !== "string")) ||
      (workflow.open_questions !== undefined && (!Array.isArray(workflow.open_questions) || workflow.open_questions.some(v => typeof v !== "string")))) throw new Error("invalid");
  } catch {
    return <Alert type="error" message="WorkFlow 格式无法展示" description="请在「工程文件」中检查 workflow.json；原内容已保留，不会自动覆盖。" />;
  }
  return <Editor value={workflow} manual saving={saving} saveDisabled={!dirty}
    onChange={value => onChange({ ...files, "workflow.json": JSON.stringify(value, null, 2) + "\n" })}
    onSave={onSave} />;
}
