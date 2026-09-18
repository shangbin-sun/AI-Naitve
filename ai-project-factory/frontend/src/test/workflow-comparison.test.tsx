import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Editor, { type EmployeeWorkflow } from "../tasks/EmployeeWorkflowEditor";

const item = (id: string) => ({id, name: id, goal: "检查", requirements: [], actions: [], input: "", output: "", acceptance: "通过"});
const old: EmployeeWorkflow = {version: 1, title: "流程", goal: "交付", steps: [item("S01"), item("S02")]};
it("按固定编号比较新增删除及移动，点击保存才提交", async () => {
  const save = vi.fn();
  render(<Editor value={{...old, steps: [item("S03"), {...item("S01"), name: "新名称"}]}} previous={old} onSave={save} onChange={vi.fn()} onOptimize={vi.fn()}/>);
  expect(screen.getByText("新增")).toBeVisible();
  expect(screen.getByText("修改")).toBeVisible();
  expect(screen.getByText("S02 · 删除")).toBeVisible();
  expect(screen.getByText("顺序 1 → 2")).toBeVisible();
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: /保存 WorkFlow/}));
  expect(save).toHaveBeenCalledOnce();
});
it("首版可直接保存，已保存版本禁用重复提交", () => {
  const props = {value: old, onSave: vi.fn(), onChange: vi.fn(), onOptimize: vi.fn()};
  const view = render(<Editor {...props}/>);
  expect(screen.getByText("首个版本 · 待保存")).toBeVisible();
  expect(screen.getByRole("button", {name: /保存 WorkFlow/})).toBeEnabled();
  view.rerender(<Editor {...props} saved/>);
  expect(screen.getByRole("button", {name: /已保存/})).toBeDisabled();
});

it("动作卡片只保留名称说明与关联聊天，合并旧版内容", async () => {
  const value: EmployeeWorkflow = {...old, source: {messages: [{id: "chat:3", role: "user", content: "先确认数据含义，不要直接执行"}]},
    steps: [{...item("S01"), evidence: ["chat:3"], input: "原有输入"}]};
  render(<Editor value={value} onChange={vi.fn()} onSave={vi.fn()}/>);
  expect(screen.getByText("动作说明")).toBeVisible();
  expect(screen.queryByText("解决的问题")).not.toBeInTheDocument();
  expect(screen.queryByText("形成的做法")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("步骤1输入")).not.toBeInTheDocument();
  expect(screen.getByLabelText("步骤1说明")).toHaveValue("### 主要任务\n- 检查\n\n### 前置条件\n- 原有输入\n\n### 输出校验\n- 通过");
  await userEvent.click(screen.getByText("关联聊天 · 1 处来源"));
  expect(screen.getByText("先确认数据含义，不要直接执行")).toBeVisible();
  expect(screen.queryByText("补充执行信息（可选）")).not.toBeInTheDocument();
});

it("合并说明编辑后成为权威内容，不重新拼回旧字段", async () => {
  const change = vi.fn();
  const view = render(<Editor value={{...old, steps: [item("S01")]}} onChange={change} onSave={vi.fn()}/>);
  await userEvent.clear(screen.getByLabelText("步骤1说明"));
  await userEvent.type(screen.getByLabelText("步骤1说明"), "先确认再处理");
  const updated = change.mock.lastCall![0];
  expect(updated.steps[0].description).toBe("先确认再处理");
  view.rerender(<Editor value={updated} onChange={change} onSave={vi.fn()}/>);
  expect(screen.getByLabelText("步骤1说明")).toHaveValue("先确认再处理");
});

it("概览精简、问题后置、候选说明折叠，保存后隐藏生成说明与对比", async () => {
  const value = {...old, summary: "S01 增加检查", open_questions: ["是否检查外部数据？", "是否需要复核？"]};
  const props = {value, onChange: vi.fn(), onSave: vi.fn()};
  const view = render(<Editor {...props}/>);
  expect(screen.getByText("2 个动作")).toBeVisible();
  expect(screen.queryByText(/从聊天中归纳做过/)).not.toBeInTheDocument();
  expect(screen.getByText("S01 增加检查")).not.toBeVisible();
  const questions = screen.getByRole("region", {name: "待确认事项"});
  expect(screen.getByLabelText("步骤2说明").compareDocumentPosition(questions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.click(screen.getByText("生成说明"));
  expect(screen.getByText("S01 增加检查")).toBeVisible();
  view.rerender(<Editor {...props} previous={old}/>);
  expect(screen.getByText("本次更新")).toBeVisible();
  view.rerender(<Editor {...props} previous={old} saved/>);
  expect(screen.queryByText("本次更新")).not.toBeInTheDocument();
  expect(screen.queryByText("S01 增加检查")).not.toBeInTheDocument();
  expect(screen.queryByText("新候选")).not.toBeInTheDocument();
  expect(screen.getByRole("region", {name: "待确认事项"})).toBeVisible();
  view.rerender(<Editor {...props} manual/>);
  expect(screen.queryByText("生成说明")).not.toBeInTheDocument();
});

it("全局约定可编辑，输入输出结构化保存，删除后编号不复用", async () => {
  const change = vi.fn();
  render(<Editor value={old} onChange={change} onSave={vi.fn()}/>);
  await userEvent.type(screen.getByLabelText("如何做事情"), '先确认依赖');
  await userEvent.click(screen.getByRole('button', {name:'添加输入'}));
  await userEvent.type(screen.getByLabelText('输入是什么1名称'), '原始数据');
  await userEvent.click(screen.getByRole('button', {name:'添加输出'}));
  await userEvent.type(screen.getByLabelText('输出是什么1名称'), '报告');
  const updated = change.mock.lastCall![0];
  expect(updated.approach).toBe('先确认依赖');
  expect(updated.inputs[0]).toMatchObject({id:'I01', name:'原始数据', required:true});
  expect(updated.outputs[0]).toMatchObject({id:'O01', name:'报告', validation:''});
  await userEvent.click(screen.getByRole('button', {name:'删除I01'}));
  await userEvent.click(screen.getByRole('button', {name:'添加输入'}));
  expect(change.mock.lastCall![0].inputs[0].id).toBe('I02');
});
