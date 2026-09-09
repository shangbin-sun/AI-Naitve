import { vi, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RunFlow from "../tasks/RunFlow";
import type { TaskRun } from "../tasks/types";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
const run = { id: "r", status: "completed", inputs: {}, result: {} } as TaskRun;
beforeEach(() =>
  vi
    .mocked(api)
    .mockResolvedValue({
      run_id: "r",
      edits_digest: "hash",
      changes: [{ name: "build.gradle.kts" }],
      nodes: [
        {
          key: "test",
          title: "参考测试",
          worker: "平台测试执行器",
          state: "completed",
          stale: true,
          modified_files: [],
          calls: 0,
        },
      ],
    }),
);
it("修改后标记需验证并携带版本摘要运行", async () => {
  const onRun = vi.fn();
  render(<RunFlow run={run} url="/flow" disabled={false} onRun={onRun} />);
  expect(await screen.findByText("需重新验证")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Run · 仅测试" }));
  expect(onRun).toHaveBeenCalledWith({
    restart_node: "test",
    edits_digest: "hash",
  });
});
it("执行中禁止启动节点", async () => {
  render(
    <RunFlow
      run={{ ...run, status: "running" }}
      url="/flow"
      disabled={false}
      onRun={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "Run · 仅测试" }),
  ).toBeDisabled();
});
it("无效接口数据展示错误而非崩溃", async () => {
  vi.mocked(api).mockResolvedValue({});
  render(<RunFlow run={run} url="/flow" disabled={false} onRun={vi.fn()} />);
  expect(
    await screen.findByText("节点状态数据格式异常，请刷新重试"),
  ).toBeVisible();
});
