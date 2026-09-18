import { useEffect, useState } from "react";
import { Button, Card, Input, Space, Tag } from "antd";
import { PlusOutlined, SaveOutlined, ThunderboltOutlined } from "@ant-design/icons";
import WorkflowContract, { type ContractItem } from './WorkflowContract';

export type EmployeeWorkflowStep = {
  id: string;
  name: string;
  description?: string;
  goal: string;
  requirements: string[];
  actions: string[];
  input: string;
  output: string;
  acceptance: string;
  evidence?: string[];
};
export type EmployeeWorkflow = {
  version: number;
  title: string;
  goal: string;
  summary?: string;
  approach?: string;
  inputs?: ContractItem[];
  outputs?: ContractItem[];
  input_id_counter?: number;
  output_id_counter?: number;
  open_questions?: string[];
  source?: { kind?: string; message_count?: number; messages?: {id: string; role: string; content: string; truncated?: boolean}[] };
  steps: EmployeeWorkflowStep[];
};

export function actionDescription(value: EmployeeWorkflowStep) {
  if (value.description !== undefined) return value.description;
  const section = (title: string, items: string[]) => {
    const unique = [...new Set(items.map(text => text.trim()).filter(Boolean))];
    return unique.length ? `### ${title}\n${unique.map(text => `- ${text}`).join("\n")}` : "";
  };
  return [section("主要任务", [value.goal, ...value.actions]),
    section("前置条件", [value.input]), section("注意事项", value.requirements),
    section("输出校验", [value.output, value.acceptance])].filter(Boolean).join("\n\n");
}
function step(value?: Partial<EmployeeWorkflowStep>): EmployeeWorkflowStep {
  return {
    id: value?.id || `step-${Date.now()}`,
    name: value?.name || "新步骤",
    goal: value?.goal || "",
    requirements: value?.requirements || [],
    actions: value?.actions || [],
    input: value?.input || "",
    output: value?.output || "",
    acceptance: value?.acceptance || "",
  };
}

export default function EmployeeWorkflowEditor({
  value,
  previous: baseline,
  saved,
  saving,
  onChange,
  onSave,
  onOptimize,
  manual = false,
  saveDisabled = false,
}: {
  value: EmployeeWorkflow;
  previous?: EmployeeWorkflow;
  saved?: boolean;
  saving?: boolean;
  onChange: (value: EmployeeWorkflow) => void;
  onSave: () => void;
  onOptimize?: () => void;
  manual?: boolean;
  saveDisabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const previous = saved || manual ? undefined : baseline;
  useEffect(() => setDraft(value), [value]);
  function update(next: EmployeeWorkflow) {
    setDraft(next);
    onChange(next);
  }
  function updateStep(index: number, patch: Partial<EmployeeWorkflowStep>) {
    update({ ...draft, steps: draft.steps.map((item, i) => i === index ? { ...item, ...patch } : item) });
  }
  return (
    <section className="employee-workflow-editor" aria-label="员工 WorkFlow">
      <div className="employee-workflow-editor-heading">
        <div>
          <Tag color={saved ? "green" : "blue"}>{manual ? `员工 WorkFlow · v${draft.version}` : saved ? "已保存" : previous ? "版本对比 · 待保存" : "首个版本 · 待保存"}</Tag>
          <small>{draft.steps.length} 个动作</small>
          <h3>{draft.title || "员工工作方法"}</h3>
          {saved ? <p className="workflow-method-intro">{draft.goal}</p> : <Input.TextArea disabled={saving} aria-label="WorkFlow目标" value={draft.goal} autoSize={{ minRows: 1, maxRows: 3 }} placeholder="一句话说明这套方法的用途" onChange={(e) => update({ ...draft, goal: e.target.value })} />}
        </div>
        <Space wrap>
          {onOptimize && <Button icon={<ThunderboltOutlined />} disabled={saving} onClick={onOptimize}>重新生成候选</Button>}
        </Space>
      </div>
      <WorkflowContract value={draft} previous={previous} disabled={saved || saving} onChange={update}/>
      <h4>具体动作</h4>
      {previous && <div className="workflow-compare-heading"><strong>上一版 · v{previous.version}</strong><strong>新候选</strong></div>}
      <div className={previous ? "workflow-compare" : "employee-workflow-steps"}>
        {draft.steps.map((item, index) => (
          <div key={item.id} className={previous ? "workflow-compare-row" : ""}>
          {previous && <div className="workflow-previous">{(() => {
            const old = previous.steps.find(s => s.id === item.id);
            if (!old) return <p className="workflow-empty">此步骤为新增</p>;
            return <><Tag>{old.id}</Tag><strong>{old.name}</strong><p className={actionDescription(old) !== actionDescription(item) ? "workflow-field-changed" : ""} style={{whiteSpace: "pre-wrap"}}>{actionDescription(old)}</p><WorkflowEvidence item={old} workflow={previous} /></>;
          })()}</div>}
          <Card className="workflow-action-card" size="small" title={<Input disabled={saved || saving} aria-label={`步骤${index + 1}名称`} value={item.name} onChange={(e) => updateStep(index, { name: e.target.value })} />} extra={<Tag>{item.id}</Tag>}>
            {previous && <Space><Tag color={!previous.steps.some(s => s.id === item.id) ? "green" : JSON.stringify(previous.steps.find(s => s.id === item.id)) !== JSON.stringify(item) ? "orange" : "default"}>{!previous.steps.some(s => s.id === item.id) ? "新增" : JSON.stringify(previous.steps.find(s => s.id === item.id)) !== JSON.stringify(item) ? "修改" : "未变"}</Tag>{previous.steps.some(s => s.id === item.id) && previous.steps.findIndex(s => s.id === item.id) !== index && <Tag color="blue">顺序 {previous.steps.findIndex(s => s.id === item.id) + 1} → {index + 1}</Tag>}</Space>}
            <fieldset disabled={saved || saving} style={{border: 0, padding: 0, marginTop: 10}}>
            <div className="workflow-method-fields">
              <label><span>动作说明</span>
                <Input.TextArea disabled={saved || saving} aria-label={`步骤${index + 1}说明`}
                  placeholder={"### 主要任务\n- 要做什么、怎么做\n\n### 输入\n- 需要哪些资料（按需）\n\n### 注意事项\n- 需要关注的地方\n\n### 输出校验\n- 交付什么、如何检查\n\n按需增减小节，无需填满。"}
                  value={actionDescription(item)} autoSize={{minRows: 3, maxRows: 16}}
                  onChange={e => updateStep(index, {description: e.target.value})}/>
              </label>
            </div>
            </fieldset>
            <WorkflowEvidence item={item} workflow={draft} previous={previous} />
          </Card>
          </div>
        ))}
        {previous?.steps.filter(old => !draft.steps.some(s => s.id === old.id)).map(old => <div key={old.id} className="workflow-compare-row"><div className="workflow-previous"><Tag color="red">{old.id} · 删除</Tag><strong>{old.name}</strong><p style={{whiteSpace: "pre-wrap"}}>{actionDescription(old)}</p></div><div className="workflow-empty">新版本已移除此步骤</div></div>)}
      </div>
      <Button disabled={saved || saving} icon={<PlusOutlined />} onClick={() => {
        const ids = [...draft.steps, ...(previous?.steps ?? [])].map(s => Number(s.id.replace(/^S/, ""))).filter(Number.isFinite);
        update({ ...draft, steps: [...draft.steps, step({ id: "S" + String(Math.max(0, ...ids) + 1).padStart(2, "0") })] });
      }}>添加动作</Button>
      {!!draft.open_questions?.filter(q => q.trim()).length && <section className="workflow-method-details" aria-label="待确认事项">
        <h4>待确认事项</h4>
        <ul>{draft.open_questions.filter(q => q.trim()).map((question, index) => <li key={index}>{question}</li>)}</ul>
      </section>}
      {!saved && !manual && draft.summary?.trim() && <details className="workflow-method-details">
        <summary>{previous ? "本次更新" : "生成说明"}</summary>
        <p style={{whiteSpace: "pre-wrap"}}>{draft.summary}</p>
      </details>}
      <details className="workflow-method-details">
        <summary>来源与版本</summary>
        <p>WorkFlow · v{draft.version}</p>
        {draft.source?.message_count !== undefined && <p>生成时参考了 {draft.source.message_count} 条聊天记录；各动作的引用可在「关联聊天」中查看。</p>}
      </details>
      <footer className="workflow-save-bar"><span>{manual ? "保存后更新员工能力，已开始的任务保留原版本。" : saved ? "已保存为当前版本，后续优化将以此为输入。" : previous ? "确认差异后保存，新 WorkFlow 将替换上一版。" : "这是第一个 WorkFlow，确认内容后即可保存。"}</span><Button type="primary" disabled={saved || saving || saveDisabled} icon={<SaveOutlined />} loading={saving} onClick={onSave}>{saved ? "已保存" : "保存 WorkFlow"}</Button></footer>
    </section>
  );
}

function WorkflowEvidence({ item, workflow, previous }: { item: EmployeeWorkflowStep; workflow: EmployeeWorkflow; previous?: EmployeeWorkflow }) {
  const refs = item.evidence ?? [];
  return <details className="workflow-method-details workflow-chat-evidence">
    <summary>关联聊天 · {refs.length} 处来源</summary>
    {!refs.length && <p>此动作暂无关联聊天记录。旧版本不会自动补造来源。</p>}
    {refs.map((ref, index) => {
      const message = workflow.source?.messages?.find(m => m.id === ref);
      const old = ref.startsWith("previous_workflow:") ? previous?.steps.find(s => s.id === ref.slice("previous_workflow:".length)) : undefined;
      return <div className="workflow-chat-excerpt" key={`${ref}:${index}`}><small>{message ? `${message.role === "user" ? "用户" : message.role === "assistant" ? "员工" : message.role === "previous_workflow" ? "上一版方法" : "记录"} · ${ref}` : ref}</small>
        <p>{message && typeof message.content === "string" ? message.content : old ? `${old.name}：${old.goal}` : ref.startsWith("previous_workflow:") ? "沿用上一版工作方法；此处未附带旧版聊天原文。" : "旧版本未保存此引用的聊天原文。"}</p>{message?.truncated && <small>此处仅显示节选，完整内容保留在生成时的输入快照中。</small>}</div>;
    })}
  </details>;
}
