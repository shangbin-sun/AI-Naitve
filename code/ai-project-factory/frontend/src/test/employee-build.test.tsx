import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmployeeBuildPanel from "../EmployeeBuildPanel";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
beforeEach(() => {
  vi.mocked(api).mockReset();
});
it("提交到平台构建接口并刷新运行记录", async () => {
  vi.mocked(api).mockResolvedValue({});
  const refreshed = vi.fn().mockResolvedValue(undefined);
  render(
    <EmployeeBuildPanel
      projectId="p1"
      disabled={false}
      onStarted={refreshed}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "自动开发并验证员工" }),
  );
  expect(api).toHaveBeenCalledWith(
    "/workspaces/p1/employee-builds",
    expect.objectContaining({ method: "POST" }),
  );
  const body = JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string);
  expect(body.max_attempts).toBe(2);
  expect(body.goal.length).toBeGreaterThan(10);
  expect(refreshed).toHaveBeenCalled();
});
it("失败后保留目标并显示接口错误", async () => {
  vi.mocked(api).mockImplementation(async () => {
    throw new Error("当前项目已有运行进行中");
  });
  render(
    <EmployeeBuildPanel projectId="p1" disabled={false} onStarted={vi.fn()} />,
  );
  const input = screen.getByRole("textbox", { name: "员工自动开发目标" });
  const before = (input as HTMLTextAreaElement).value;
  await userEvent.click(
    screen.getByRole("button", { name: "自动开发并验证员工" }),
  );
  expect(await screen.findByText("当前项目已有运行进行中")).toBeInTheDocument();
  expect(input).toHaveValue(before);
});
