import { expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmployeeTuning from "../tasks/EmployeeTuning";
import { api } from "../api";
import { ConfigProvider } from "antd";
vi.mock("../api",()=>({api:vi.fn()}));
const mock=vi.mocked(api);
const props={projectId:"p",runId:"r",nodeKey:"analyst",name:"分析师",problem:"环境受阻",onClose:vi.fn(),onContinue:vi.fn()};
beforeEach(()=>{mock.mockReset();});
it('已生成的独立任务候选直接展示，不要求再次生成',async()=>{
  const workflow={version:1,title:'已生成的需求整理流程',goal:'整理需求',steps:[{id:'S01',name:'阅读文档',goal:'读取文档',input:'',output:'',acceptance:'',requirements:[],actions:[]}]};
  mock.mockResolvedValue({engine:'independent-v1',status:'awaiting_review',messages:[],read_only:false,
    can_start:true,can_send:true,workflow_generation:{status:'completed'},
    ability_proposal:{id:'candidate',expected_version:2,workflow,previous_workflow:workflow}});
  render(<EmployeeTuning {...props}/>);
  await userEvent.click(await screen.findByRole('button',{name:'查看 WorkFlow'}));
  expect(await screen.findByRole('button',{name:/保存 WorkFlow/})).toBeInTheDocument();
  expect(screen.getByText('已生成的需求整理流程')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'生成 WorkFlow'})).toBeNull();
  expect(mock.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
it('进入中断任务自动检查，直接聊天而不自动恢复执行',async()=>{
  mock.mockImplementation(async path => path.endsWith('/readiness')
    ? {can_send:true,message:'任务已中断，可直接继续聊天'}
    : {engine:'independent-v1',status:'interrupted',messages:[],read_only:false,can_start:true});
  render(<EmployeeTuning {...props}/>);
  await waitFor(()=>expect(screen.getByLabelText('讨论当前AI 团队')).toBeEnabled());
  expect(screen.queryByText('核对现场并恢复任务')).toBeNull();
  expect(mock.mock.calls.some(([path])=>path.endsWith('/conversation/readiness'))).toBe(true);
  expect(mock.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
it('环境检查失败时保留历史并阻止发送',async()=>{
  mock.mockImplementation(async path => {
    if(path.endsWith('/readiness')) throw new Error('工作目录缺失');
    return {engine:'independent-v1',status:'interrupted',messages:[],read_only:false,can_start:true};
  });
  render(<EmployeeTuning {...props}/>);
  expect(await screen.findByText('工作目录缺失')).toBeVisible();
  expect(screen.getByRole('button',{name:'发送'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'重新检查'})).toBeVisible();
});
it('真实时间线保留轮次事件、折叠长输出并加载更早记录',async()=>{
  mock.mockImplementation(async path => path.includes('/history') ? {
    messages: path.includes('before=') ? [{id:'old',role:'user',content:'更早的派工'}] : [
      {id:'u',role:'user',content:'请检查产物'},
      {id:'e',role:'assistant',content:'',turn_id:'t',event:{title:'执行命令',status:'completed',detail:'真实命令输出'}},
      {id:'a',role:'assistant',content:'已检查产物'}],
    next_cursor:path.includes('before=')?null:'t', warnings:['来源已标记内容不完整']
  } : {engine:'independent-v1',status:'completed',messages:[],can_start:true,read_only:false});
  render(<EmployeeTuning {...props}/>);
  expect(await screen.findByText('请检查产物')).toBeVisible();
  const summary=await screen.findByText('执行命令 · 已完成');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  await userEvent.click(summary);
  expect(screen.getByText('真实命令输出')).toBeVisible();
  await userEvent.click(screen.getByText('加载更早的对话'));
  expect(await screen.findByText('更早的派工')).toBeVisible();
  expect(screen.getByText('已检查产物')).toBeVisible();
  expect(screen.getByText('来源已标记内容不完整')).toBeVisible();
});
it('独立任务会话直接发送讨论，不走修复或能力更新接口',async()=>{
  mock.mockResolvedValue({engine:'independent-v1',status:'awaiting_review',messages:[],read_only:false,can_start:true,can_send:true});
  render(<EmployeeTuning {...props}/>);
  await waitFor(()=>expect(screen.getByLabelText('讨论当前AI 团队')).toBeEnabled());
  await userEvent.type(screen.getByLabelText('讨论当前AI 团队'),'解释这份产物');
  await userEvent.click(screen.getByRole('button',{name:'发送'}));
  await waitFor(()=>expect(mock.mock.calls.some(([path,o])=>path.endsWith('/nodes/analyst/conversation')&&JSON.parse(o?.body as string).mode===undefined)).toBe(true));
  expect(screen.queryByLabelText('任务聊天模式')).toBeNull();
  expect(mock.mock.calls.some(([path,o])=>path.endsWith('/tuning')&&o?.method==='POST')).toBe(false);
});
it("打开只读取记录，运行时禁止发送",async()=>{
  mock.mockResolvedValue({status:"idle",messages:[],read_only:true,can_start:true});
  render(<EmployeeTuning {...props}/>);
  await screen.findByText("任务执行中，暂时只读；停止执行后可调优。");
  expect(screen.getByRole("button",{name:"发送"})).toBeDisabled();
  expect(mock.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
it("对话发送到员工节点，关闭不停止任务",async()=>{
  mock.mockResolvedValue({status:"idle",messages:[],read_only:false,can_start:true});
  render(<EmployeeTuning {...props}/>);
  await waitFor(()=>expect(screen.getByLabelText("讨论当前AI 团队")).toBeEnabled());
  await userEvent.type(screen.getByLabelText("讨论当前AI 团队"),"请检查环境");
  await userEvent.click(screen.getByRole("button",{name:"发送"}));
  await waitFor(()=>expect(mock.mock.calls.some(([path,o])=>path.endsWith("/nodes/analyst/tuning")&&o?.method==="POST")).toBe(true));
  await userEvent.click(screen.getByRole("button",{name:"关闭对话"}));
  expect(props.onClose).toHaveBeenCalled();
  expect(mock.mock.calls.some(([path])=>path.endsWith("/stop"))).toBe(false);
});
it("优化生成候选，等待用户保存",async()=>{
  mock.mockResolvedValue({status:"idle",messages:[],read_only:false,can_start:true,report:{passed:true,verification:"重复的验证结果"}});
  render(<EmployeeTuning {...props}/>);
  await userEvent.click(await screen.findByRole("button",{name:"增强员工能力"}));
  await waitFor(()=>expect(mock).toHaveBeenCalledWith(expect.stringContaining("/workflow-generation"),expect.objectContaining({method:"POST"})));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByText("修复验证通过")).toBeNull();
  expect(screen.queryByText("重复的验证结果")).toBeNull();
});

it("员工聊天复用图片粘贴上传并可单独发送",async()=>{
  mock.mockImplementation(async path=>path.endsWith("/chat-attachments")?{id:"image-one",name:"截图.png",content_type:"image/png",url:"/api/image-one"}:{status:"idle",messages:[],read_only:false,can_start:true});
  render(<EmployeeTuning {...props}/>);
  await waitFor(()=>expect(screen.getByLabelText("讨论当前AI 团队")).toBeEnabled());
  fireEvent.paste(screen.getByLabelText("讨论当前AI 团队"),{clipboardData:{files:[new File(["png"],"截图.png",{type:"image/png"})]}});
  await screen.findByAltText("截图.png");
  await userEvent.click(screen.getByRole("button",{name:"发送"}));
  await waitFor(()=>expect(mock).toHaveBeenCalledWith(expect.stringContaining("/nodes/analyst/tuning"),expect.objectContaining({method:"POST",body:expect.stringContaining('"attachment_ids":["image-one"]')})));
});
it("评测与调优一键启动当前聊天案例，不再填写输入或跳转任务批次", async () => {
  const current = {id:"case-current",kind:"case",status:"ready",title:"当前聊天案例",reference_status:"historical"};
  const other = {id:"case-other",kind:"case",status:"ready",title:"其他任务案例"};
  mock.mockImplementation(async path => {
    if (path.endsWith("/tuning/evaluation")) return {employee_id:"e1",employee_version:4,case_id:current.id,run_id:"eval-current",reused:false};
    if (path === "/employees/e1/evaluation") return [other,current,{id:"eval-current",kind:"run",status:"queued",employee_version:4,created_at:"now",cases:[current]}];
    return {status:"idle",messages:[],read_only:false,can_start:true,employee_version:3};
  });
  props.onContinue.mockClear();
  // jsdom does not run CSS keyframes; test modal visibility without animation.
  render(<ConfigProvider theme={{token:{motion:false}}}><EmployeeTuning {...props}/></ConfigProvider>);
  await userEvent.click(await screen.findByRole("button", {name:"评测与调优"}));
  await waitFor(() => expect(screen.getByText("已启动当前聊天的基线评测")).toBeVisible());
  expect(await screen.findByRole("checkbox", {name:"当前聊天案例"})).toBeChecked();
  expect(screen.getByRole("checkbox", {name:"其他任务案例"})).not.toBeChecked();
  expect(screen.getByText("本次聊天评测")).toBeVisible();
  expect(screen.getByRole("button", {name:"使用已保存版本开始基线评测"})).toBeDisabled();
  expect(screen.queryByLabelText("验证输入")).toBeNull();
  expect(screen.queryByRole("button", {name:"重新验证"})).toBeNull();
  expect(mock.mock.calls.filter(([path, options])=>path.endsWith("/tuning/evaluation")&&options?.method==="POST")).toHaveLength(1);
  expect(mock.mock.calls.some(([path])=>path.endsWith("/verify")||path.endsWith("/verification-inputs"))).toBe(false);
  expect(props.onContinue).not.toHaveBeenCalled();
});
it("进展先展示可读说明，技术日志仅在主动打开后加载",async()=>{
  mock.mockResolvedValue({status:"idle",messages:[],read_only:false,can_start:true,context:{status:"waiting_human",summary:"已完成代码编写，窗口测试尚未通过。",problem:"需要确认可用的桌面测试环境。",verification:"15 项逻辑测试通过。"}});
  render(<EmployeeTuning {...props}/>);
  await userEvent.click(await screen.findByText("当前进展"));
  await waitFor(()=>expect(screen.getByText("已完成代码编写，窗口测试尚未通过。")).toBeVisible());
  expect(screen.getByText("15 项逻辑测试通过。")).toBeVisible();
  expect(mock.mock.calls.some(([path])=>path.includes("/activity"))).toBe(false);
  expect(screen.queryByText("环境受阻")).toBeNull();
});
it("直接显示员工原会话输出，不触发执行",async()=>{
  mock.mockImplementation(async path=>path.endsWith("/history")?{messages:[{id:"native-one",role:"assistant",content:"1. 已完成需求分析。"}]}:{status:"idle",messages:[],read_only:false,can_start:true});
  render(<EmployeeTuning {...props}/>);
  expect(await screen.findByText("已完成需求分析。")).toBeVisible();
  expect(mock.mock.calls.every(([,options])=>!options?.method||options.method==="GET")).toBe(true);
});
