import { expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmployeeTuning from "../tasks/EmployeeTuning";
import { api } from "../api";
vi.mock("../api",()=>({api:vi.fn()}));
const mock=vi.mocked(api);
const props={projectId:"p",runId:"r",nodeKey:"analyst",name:"分析师",problem:"环境受阻",onClose:vi.fn(),onContinue:vi.fn()};
beforeEach(()=>{mock.mockReset();});
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
it("更新能力直接触发保存，不弹出编辑框",async()=>{
  mock.mockResolvedValue({status:"idle",messages:[],read_only:false,can_start:true,report:{passed:true,verification:"重复的验证结果"}});
  render(<EmployeeTuning {...props}/>);
  await userEvent.click(await screen.findByRole("button",{name:"更新员工能力"}));
  await waitFor(()=>expect(mock).toHaveBeenCalledWith(expect.stringContaining("/tuning"),expect.objectContaining({method:"POST",body:expect.stringContaining('"auto_apply":true')})));
  expect(screen.queryByRole("dialog")).toBeNull();
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
it("重新验证默认带入原输入，启动后进入新批次",async()=>{
  mock.mockImplementation(async path=>path.endsWith("/verification-inputs")?{description:"原输入",input_text:"",attachments:[],employee_version:4}:path.endsWith("/verify")?{id:"new-run"}:{status:"idle",messages:[],read_only:false,can_start:true});
  render(<EmployeeTuning {...props}/>);
  await userEvent.click(await screen.findByRole("button",{name:"重新验证"}));
  expect(await screen.findByLabelText("验证输入")).toHaveValue("原输入");
  await userEvent.click(screen.getByRole("button",{name:"开始验证"}));
  await waitFor(()=>expect(props.onContinue).toHaveBeenCalledWith("new-run"));
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
