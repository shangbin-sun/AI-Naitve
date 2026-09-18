import { Button, Checkbox, Input, Tag } from 'antd';
import type { EmployeeWorkflow } from './EmployeeWorkflowEditor';

export type ContractItem = {id: string; name: string; description: string; format: string; required: boolean; validation: string};

export default function WorkflowContract({value, previous, disabled, onChange}: {
  value: EmployeeWorkflow; previous?: EmployeeWorkflow; disabled?: boolean; onChange: (value: EmployeeWorkflow) => void;
}) {
  function update(patch: Partial<EmployeeWorkflow>) {
    onChange({...value, approach: value.approach ?? '', inputs: value.inputs ?? [], outputs: value.outputs ?? [], ...patch});
  }
  function changeItem(field: 'inputs' | 'outputs', index: number, patch: Partial<ContractItem>) {
    update({[field]: (value[field] ?? []).map((item, i) => i === index ? {...item, ...patch} : item)});
  }
  return <section className="workflow-global-contract" aria-label="全局约定">
    <h4>如何做事情</h4>
    <Input.TextArea aria-label="如何做事情" disabled={disabled} value={value.approach ?? ''}
      placeholder="整体思路、全局方案、依赖与通用约束；具体动作写在下方。" autoSize={{minRows: 3, maxRows: 12}}
      onChange={e => update({approach: e.target.value})}/>
    {(['inputs', 'outputs'] as const).map(field => {
      const title = field === 'inputs' ? '输入是什么' : '输出是什么';
      return <section key={field} aria-label={title}>
        <h4>{title}</h4>
        {!(value[field]?.length) && <p>尚未设置，可按实际需要添加。</p>}
        {(value[field] ?? []).map((item, index) => <div className="workflow-contract-item" key={item.id}>
          <div className="workflow-contract-item-heading"><Tag>{item.id}</Tag>
            <Input aria-label={`${title}${index + 1}名称`} placeholder="名称" value={item.name} disabled={disabled} onChange={e => changeItem(field, index, {name: e.target.value})}/>
            <Button aria-label={`删除${item.id}`} disabled={disabled} onClick={() => update({[field]: value[field]!.filter((_, i) => i !== index)})}>删除</Button>
          </div>
          <Input.TextArea aria-label={`${title}${index + 1}说明`} placeholder="说明" value={item.description} disabled={disabled} autoSize={{minRows: 1, maxRows: 6}} onChange={e => changeItem(field, index, {description: e.target.value})}/>
          <details className="workflow-method-details"><summary>格式与校验 · {item.required ? '必需' : '可选'}</summary>
            <div className="workflow-method-fields">
              <label>类型／格式<Input disabled={disabled} value={item.format} placeholder="例如 CSV、Markdown、JSON" onChange={e => changeItem(field, index, {format: e.target.value})}/></label>
              <Checkbox disabled={disabled} checked={item.required} onChange={e => changeItem(field, index, {required: e.target.checked})}>必需</Checkbox>
              <label>校验标准<Input.TextArea disabled={disabled} value={item.validation} placeholder="检查内容与判断方式，不代表已通过评测" onChange={e => changeItem(field, index, {validation: e.target.value})}/></label>
            </div>
          </details>
        </div>)}
        <Button disabled={disabled} onClick={() => {
          const prefix = field === 'inputs' ? 'I' : 'O';
          const ids = [...(value[field] ?? []), ...(previous?.[field] ?? [])].map(item => Number(item.id.slice(1))).filter(Number.isFinite);
          const counter = field === 'inputs' ? 'input_id_counter' : 'output_id_counter';
          const next = Math.max(value[counter] ?? 0, ...ids, 0) + 1;
          update({[counter]: next, [field]: [...(value[field] ?? []), {id: prefix + String(next).padStart(2, '0'), name: '', description: '', format: '', required: true, validation: ''}]});
        }}>添加{field === 'inputs' ? '输入' : '输出'}</Button>
      </section>;
    })}
    {previous && <details className="workflow-method-details"><summary>对比上一版全局约定</summary>
      <p style={{whiteSpace:'pre-wrap'}}>{previous.approach || '旧版未设置全局做事思路'}</p>
      {(['inputs','outputs'] as const).map(field => <section key={field}><h4>{field === 'inputs' ? '原输入' : '原输出'}</h4>{(previous[field] ?? []).map(item => <p key={item.id}>{item.id} · {item.name} — {item.description} · {item.format} · {item.required ? '必需' : '可选'} · {item.validation}</p>)}</section>)}
    </details>}
  </section>;
}
