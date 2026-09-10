import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DeliveryPanel, { DeliveryResults } from "../DeliveryPanel";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
beforeEach(() => {
  vi.mocked(api).mockReset();
});
it("零测试即使退出码为零也不能算验收通过", () => {
  render(
    <DeliveryResults
      referenceFiles={39}
      attempts={[
        {
          attempt: 0,
          exit_code: 0,
          tests: { executed: 0, passed: 0, failed: 0, skipped: 0, cases: [] },
        },
      ]}
    />,
  );
  expect(screen.getByText("构建阻塞 / 未执行")).toBeInTheDocument();
  expect(screen.queryByText("参考测试通过")).not.toBeInTheDocument();
});
it("用户任务交给平台执行且保留重试参数", async () => {
  vi.mocked(api).mockResolvedValue({});
  const refreshed = vi.fn().mockResolvedValue(undefined);
  render(
    <DeliveryPanel projectId="p" disabled={false} onStarted={refreshed} />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "启动AI 团队自动开发与样例验证" }),
  );
  expect(api).toHaveBeenCalledWith(
    "/workspaces/p/delivery-runs",
    expect.objectContaining({ method: "POST" }),
  );
  expect(
    JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string).max_attempts,
  ).toBe(2);
  expect(refreshed).toHaveBeenCalled();
});
