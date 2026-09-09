import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TasksPanel from "../tasks/TasksPanel";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
const mock = vi.mocked(api);
const task = {
  id: "t1",
  title: "开发 Agent1",
  description: "根据参考输入开发一个可以测试的 Agent",
  acceptance: "测试通过",
  code_source_id: "code1",
  version: 1,
  created_at: "2026-09-08",
  updated_at: "2026-09-08",
  runs: [],
  run_count: 0,
};
beforeEach(() => {
  mock.mockReset();
  mock.mockImplementation(async (path) =>
    path.endsWith("/task-sources")
      ? [{ id: "code1", kind: "code", title: "输入代码" }]
      : path.endsWith("/tasks")
        ? [task]
        : task,
  );
});
describe("任务与运行", () => {
  it("同步失败后下一次成功加载清除旧报错", async () => {
    mock.mockRejectedValueOnce(new Error("临时服务异常"));
    render(<TasksPanel projectId="failed" onSources={vi.fn()} />);
    expect(await screen.findByText("临时服务异常")).toBeVisible();
    await waitFor(() => expect(screen.queryByText("临时服务异常")).not.toBeInTheDocument(), {timeout: 4000});
    expect(screen.getByRole("button", {name: "开发 Agent1"})).toBeVisible();
  });
  it("创建独立任务，保存需求与验收要求", async () => {
    render(<TasksPanel projectId="p" onSources={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(screen.getByLabelText("任务名称"), "Agent2");
    await userEvent.type(
      screen.getByLabelText("任务说明"),
      "开发第二个 Agent 并验证参考测试",
    );
    await userEvent.type(screen.getByLabelText("验收要求"), "保留原测试");
    await userEvent.click(screen.getByRole("button", { name: "保存任务" }));
    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith(
        "/workspaces/p/tasks",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("Agent2"),
        }),
      ),
    );
  });
  it("启动任务时包含输入版本和幂等请求 ID", async () => {
    render(<TasksPanel projectId="p" onSources={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "开发 Agent1" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "从输入基线运行" }),
    );
    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith(
        "/workspaces/p/tasks/t1/runs",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mock.mock.calls.find(([path]) => path.endsWith("/runs"))!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({
      expected_version: 1,
      request_id: expect.any(String),
      resume_run_id: null,
    });
  });
  it("缺少输入时展示导入入口，不能启动", async () => {
    mock.mockResolvedValue({ ...task, code_source_id: null });
    mock.mockImplementation(async (path) =>
      path.endsWith("/task-sources")
        ? []
        : path.endsWith("/tasks")
          ? [{ ...task, code_source_id: null }]
          : { ...task, code_source_id: null },
    );
    const onSources = vi.fn();
    render(<TasksPanel projectId="p" onSources={onSources} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "开发 Agent1" }),
    );
    expect(
      await screen.findByRole("button", { name: "从输入基线运行" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "导入资料" }));
    expect(onSources).toHaveBeenCalledOnce();
  });
  it("真实运行记录可查看日志并停止", async () => {
    const run = {
      id: "r1",
      status: "running",
      design_version: 3,
      created_at: "2026-09-08",
      error: "",
      inputs: { task_snapshot: { ...task } },
      result: { stage: "test", events: ["执行原有测试"] },
    };
    mock.mockImplementation(async (path) =>
      path.endsWith("/task-sources")
        ? []
        : path.endsWith("/tasks")
          ? [{ ...task, latest_run: { status: "running" } }]
          : { ...task, runs: [run] },
    );
    render(<TasksPanel projectId="p" onSources={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "开发 Agent1" }),
    );
    await userEvent.click(await screen.findByRole("tab", { name: "执行日志" }));
    expect(screen.getByText("执行原有测试")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "停止运行" }));
    expect(mock).toHaveBeenCalledWith("/evaluations/r1/cancel", {
      method: "POST",
    });
  });
});
