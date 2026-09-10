import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentRunsPanel from "../tasks/AgentRunsPanel";
vi.mock("../WorkspaceBrowser", () => ({ default: () => null }));
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
const mock = vi.mocked(api);
beforeEach(() => {
  mock.mockReset();
});

it("提交任务输入并在请求失败后复用幂等ID", async () => {
  mock.mockImplementation(async (path, options) => {
    if (options?.method === "POST") throw new Error("暂时失败");
    return path.endsWith("agent-runs")
      ? []
      : { draft: { workflow: [{ key: "a", name: "分析" }] } };
  });
  render(<AgentRunsPanel projectId="p" />);
  await userEvent.type(screen.getByLabelText("任务输入"), "分析本轮资料");
  const start = screen.getByRole("button", { name: "开始运行" });
  await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start);
  expect(await screen.findByText("Error: 暂时失败")).toBeVisible();
  await userEvent.click(start);
  const calls = mock.mock.calls.filter(([, o]) => o?.method === "POST");
  expect(calls).toHaveLength(2);
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
  expect(JSON.parse(calls[0][1]!.body as string)).toMatchObject({
    scope: "workflow",
    description: "分析本轮资料",
  });
});

it("人工待办阻止继续，答复发送至所属运行", async () => {
  mock.mockImplementation(async (path) =>
    path.endsWith("agent-runs")
      ? [
          {
            id: "r",
            title: "任务",
            scope: "workflow",
            status: "waiting_human",
            snapshot: { version: 2 },
            state: {
              nodes: {
                review: {
                  step: { name: "评审" },
                  employee: { name: "负责人" },
                  status: "waiting_human",
                  question: "确认范围？",
                  artifacts: [],
                },
              },
            },
          },
        ]
      : { draft: { workflow: [] } },
  );
  render(<AgentRunsPanel projectId="p" />);
  expect(await screen.findByText("确认范围？")).toBeVisible();
  expect(screen.getByRole("button", { name: "继续原运行" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("答复评审"), "确认");
  await userEvent.click(screen.getByRole("button", { name: "提交答复" }));
  expect(mock).toHaveBeenCalledWith(
    "/workspaces/p/agent-runs/r/answer",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ node: "review", answer: "确认" }),
    }),
  );
});
