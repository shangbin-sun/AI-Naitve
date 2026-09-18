import {beforeEach, expect, it, vi} from 'vitest';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {App} from 'antd';
import EmployeeEvaluation from '../EmployeeEvaluation';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
beforeEach(()=>{vi.mocked(api).mockReset();});
it('展示估算完成度、范围和结论，仅保留调优试跑入口',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>path.endsWith('/sources')?[]:[{id:'r1',kind:'run',status:'completed',cases:[{id:'c1',file_mode:true}],results:[{case_id:'c1',title:'案例',actual:'摘要',report:{status:'estimated',completion_percent:72,coverage_percent:80,conclusion:'部分目标已完成',objectives:[],matches:[],improvements:[],regressions:[],excluded_files:[],checks:[],diff:'',note:'模型估算'}}]}]);
  const user=mount();
  expect(await screen.findByText('目标完成度：约 72%')).toBeVisible();
  expect(screen.getByText('部分目标已完成')).toBeVisible();
  expect(screen.getByText(/可判断目标权重：80%/)).toBeVisible();
  await user.click(screen.getByRole('button',{name:'生成新 Workflow 并试跑，提升后采用'}));
  expect(api).toHaveBeenCalledWith('/employees/e1/evaluation/runs/r1/optimize?auto_trial=true',expect.objectContaining({method:'POST'}));
  expect(screen.queryByRole('button',{name:/重新对比已有成果/})).not.toBeInTheDocument();
});
const caseRow={id:'case1',kind:'case',status:'ready',title:'分析任务',reference_status:'confirmed',input_text:'输入',reference:'参考'};
function mount(disabled=false){
  render(<App><EmployeeEvaluation employeeId="e1" version={3} disabled={disabled} onAdopted={async()=>{}}/></App>);
  return userEvent.setup();
}
it('自动导入的案例默认可直接启动固定员工版本的基线评测',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>path.endsWith('/sources')?[]:[caseRow]);
  const user=mount();
  expect(await screen.findByText('成功完成且有实际输出的任务会自动导入一次')).toBeVisible();
  expect(screen.getByRole('checkbox',{name:'分析任务'})).toBeChecked();
  await user.click(screen.getByRole('button',{name:'使用已保存版本开始基线评测'}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('/employees/e1/evaluation/runs',expect.objectContaining({method:'POST',body:JSON.stringify({case_ids:['case1'],expected_version:3})})));
});
it('未保存的员工修改禁止运行评测',async()=>{
  vi.mocked(api).mockResolvedValue([]);mount(true);
  expect(screen.getByText('请先保存员工页面的修改，再进行评测。')).toBeVisible();
  expect(screen.getByRole('button',{name:'使用已保存版本开始基线评测'})).toBeDisabled();
});
it('无规则的结果显示未验证，不冒充通过',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>path.endsWith('/sources')?[]:[{id:'r1',kind:'run',status:'completed',employee_version:3,created_at:'today',cases:[{id:'case1',reference:'参考'}],results:[{case_id:'case1',title:'分析',actual:'结果',report:{status:'unverified',diff:'-参考\n+结果',checks:[],reference_equal:false,note:'文本差异不代表语义质量'}}]}]);
  const user=mount();
  await user.click(await screen.findByText('分析 · 未验证'));
  expect(screen.getByText('文本差异不代表语义质量')).toBeVisible();
  expect(screen.getByText('结果')).toBeVisible();
  expect(screen.queryByText('规则通过')).not.toBeInTheDocument();
});

it('文件案例展示下载清单并标注非文本不评测，不渲染原文JSON',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>path.endsWith('/sources')?[]:[{...caseRow,file_mode:true,
    input_files:[{name:'files/input.png',size:20,text:false}],
    output_files:[{name:'result.md',size:40,text:true},{name:'diagram.png',size:50,text:false}],
    input_text:'PRIVATE_INPUT_TEXT',reference:'PRIVATE_REFERENCE_TEXT'}]);
  const user=mount();
  await user.click(await screen.findByText('输入与参考输出'));
  expect(screen.getByRole('link',{name:'diagram.png'})).toHaveAttribute('href','/api/employees/e1/evaluation/case1/file?group=reference&name=diagram.png');
  expect(screen.getByText(/非文本，未参与评测/)).toBeVisible();
  expect(screen.queryByText('PRIVATE_REFERENCE_TEXT')).not.toBeInTheDocument();
  expect(screen.queryByText('PRIVATE_INPUT_TEXT')).not.toBeInTheDocument();
});

it('聊天入口只默认选中当前案例，并将本次评测记录置顶', async()=>{
  const other = {...caseRow,id:'other',title:'其他任务'};
  vi.mocked(api).mockResolvedValue([
    {id:'old-run',kind:'run',status:'completed',created_at:'older',employee_version:3},
    {id:'chat-run',kind:'run',status:'running',created_at:'current',employee_version:3,cases:[caseRow]},
    other,caseRow,
  ]);
  render(<App><EmployeeEvaluation employeeId="e1" version={3} disabled={false} onAdopted={async()=>{}} initialCaseId="case1" activeRunId="chat-run"/></App>);
  expect(await screen.findByRole('checkbox',{name:'分析任务'})).toBeChecked();
  expect(screen.getByRole('checkbox',{name:'其他任务'})).not.toBeChecked();
  const current = screen.getByText('基线评测 · current');
  const older = screen.getByText('基线评测 · older');
  expect(current.compareDocumentPosition(older)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText('本次聊天评测')).toBeVisible();
  expect(screen.getByRole('button',{name:'使用已保存版本开始基线评测'})).toBeDisabled();
  expect(vi.mocked(api).mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
