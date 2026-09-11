import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentRunsPanel from "../tasks/AgentRunsPanel";
vi.mock("../WorkspaceBrowser", () => ({ default: () => null }));
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
const mock = vi.mocked(api);
const definition = { draft: { workflow: [{ key: "a", owner: "analyst", name: "分析" }], members: [{ key: "analyst", name: "分析员工", kind: "ai" }] } };
const sample = (id: string) => ({ id, task_id: "t", title: "销售分析", scope: "workflow", status: "waiting_human", created_at: "2026-09-10T01:00:00Z", inputs: {description: "分析销售"}, snapshot: {version: 2}, state: {nodes: {review: {step: {name: "评审", depends_on: []}, employee: {name: "负责人"}, status: "waiting_human", question: "确认范围？", artifacts: []}}} });
beforeEach(() => { mock.mockReset(); });
it("提交任务输入并在请求失败后复用幂等ID", async () => {
  mock.mockImplementation(async (path, options) => {
    if (options?.method === "POST") throw new Error("暂时失败");
    return path.endsWith("agent-runs") ? [] : definition;
  });
  render(<AgentRunsPanel projectId="p" />);
  await userEvent.click(screen.getByRole("button", {name: /新建任务/}));
  await userEvent.type(screen.getByLabelText("任务输入"), "分析本轮资料");
  const start = screen.getByRole("button", {name: "开始执行"});
  await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start);
  expect((await screen.findAllByText("Error: 暂时失败")).length).toBeGreaterThan(0);
  await userEvent.click(start);
  const calls = mock.mock.calls.filter(([, o]) => o?.method === "POST");
  expect(calls).toHaveLength(2);
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
  expect(JSON.parse(calls[0][1]!.body as string)).toMatchObject({scope: "workflow", description: "分析本轮资料"});
});
it("任务按执行批次合并，人工答复发送至选中批次", async () => {
  mock.mockImplementation(async path => path.endsWith("agent-runs") ? [sample("new"),sample("old")] : definition);
  render(<AgentRunsPanel projectId="p" />);
  const task = await screen.findByRole("button", {name: "销售分析"});
  expect(screen.getAllByRole("button", {name: "销售分析"})).toHaveLength(1);
  await userEvent.click(task);
  expect(await screen.findByText("确认范围？")).toBeVisible();
  expect(screen.getByRole("button", {name: "恢复执行"})).toBeDisabled();
  await userEvent.type(screen.getByLabelText("答复评审"), "确认");
  await userEvent.click(screen.getByRole("button", {name: "提交答复"}));
  expect(mock).toHaveBeenCalledWith("/workspaces/p/agent-runs/new/answer", expect.objectContaining({method: "POST",body: JSON.stringify({node: "review",answer: "确认"})}));
  expect(screen.queryByRole("tab", {name: "执行数据"})).toBeNull();
  expect(screen.queryByRole("tab", {name: "执行历史"})).toBeNull();
  expect(screen.getByRole("combobox", {name:"执行批次"})).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", {name:"输入资料"}));
  expect(await screen.findByText("未提供额外文本资料")).toBeVisible();
});
it("员工入口直接进入单员工执行", async () => {
  mock.mockImplementation(async path => path.endsWith("agent-runs") ? [] : definition);
  render(<AgentRunsPanel projectId="p" launchEmployee={{employee: "analyst",nonce: 1}} />);
  expect(await screen.findByText("单员工执行")).toBeVisible();
  expect(await screen.findByText("分析员工")).toBeVisible();
  expect(screen.getByText(/缺少的上游输入请在下方补充/)).toBeVisible();
});

it("新任务默认复用上次团队输入和附件", async () => {
  const old = {...sample("latest"), inputs:{description:"上次要求", attachments:[{name:"source.txt",path:"inputs/files/source.txt"}]}};
  mock.mockImplementation(async path => path.endsWith("agent-runs") ? [old] : definition);
  const fetchMock = vi.spyOn(globalThis,"fetch").mockResolvedValue({ok:true,blob:async()=>new Blob(["data"])} as Response);
  try {
    render(<AgentRunsPanel projectId="p" />);
    await screen.findByRole("button",{name:"销售分析"});
    await userEvent.click(screen.getByRole("button",{name:/新建任务/}));
    await waitFor(()=>expect(screen.getByLabelText("任务输入")).toHaveValue("上次要求"));
    await screen.findByText("source.txt");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("run_id=latest"));
    expect(screen.queryByRole("combobox", {name:"已上传的文件"})).toBeNull();
    expect(screen.queryByText("选择已有执行成果作为输入")).toBeNull();
  } finally {fetchMock.mockRestore();}
});
it("员工入口只复用该员工的输入，不继承团队输入", async () => {
  const own={...sample("employee"),scope:"node",inputs:{node:"a",description:"员工上次输入"},state:{nodes:{a:{step:{key:"a",owner:"analyst",name:"分析"},employee:{key:"analyst",name:"分析员工"},status:"completed",artifacts:[]}}}};
  mock.mockImplementation(async path=>path.endsWith("agent-runs")?[sample("team"),own]:definition);
  render(<AgentRunsPanel projectId="p" launchEmployee={{employee:"analyst",nonce:1}} />);
  await waitFor(()=>expect(screen.getByLabelText("任务输入")).toHaveValue("员工上次输入"));
});

it("人工节点保持答复入口，不提供员工调优", async () => {
  mock.mockImplementation(async path => path.endsWith("agent-runs") ? [sample("issue")] : definition);
  render(<AgentRunsPanel projectId="p"/>);
  await userEvent.click(await screen.findByRole("button",{name:"销售分析"}));
  expect(screen.queryByRole("button",{name:"转到聊天处理"})).toBeNull();
  expect(screen.getByRole("button",{name:"提交答复"})).toBeInTheDocument();
  expect(mock.mock.calls.some(([,options])=>options?.method==="POST")).toBe(false);
});
