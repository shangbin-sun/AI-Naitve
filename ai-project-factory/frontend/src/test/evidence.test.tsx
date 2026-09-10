import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import EvidencePanel from "../EvidencePanel";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
const mocked = vi.mocked(api);
const source = {
  id: "source-1",
  title: "PRD摘录",
  location: "https://example.test/doc",
  kind: "requirements",
  coverage: "excerpt",
  content: "缺少完整正文",
  digest: "abc123",
};
beforeEach(() => {
  mocked.mockReset();
});
describe("AI 团队证据与质量", () => {
  it("显式选择依赖下载，并调用对应基线执行接口", async () => {
    mocked.mockImplementation(async (path, options) =>
      options?.method === "POST"
        ? {}
        : path.endsWith("/sources")
          ? [{ ...source, kind: "code" }]
          : [],
    );
    const user = userEvent.setup();
    render(
      <AntApp>
        <EvidencePanel projectId="p1" version={1} onImprove={vi.fn()} />
      </AntApp>,
    );
    await screen.findByText("PRD摘录");
    await user.click(
      screen.getByRole("checkbox", { name: "允许下载构建依赖" }),
    );
    await user.click(screen.getByRole("button", { name: "运行基线单元测试" }));
    expect(mocked).toHaveBeenCalledWith(
      "/workspaces/p1/evaluations?kind=baseline&offline=false",
      { method: "POST" },
    );
  });
  it("运行中可停止并保留已生成需求产物", async () => {
    mocked.mockImplementation(async (path, options) =>
      options?.method === "POST"
        ? {}
        : path.endsWith("/sources")
          ? [source]
          : [
              {
                id: "task1",
                design_version: 1,
                kind: "requirements",
                status: "running",
                error: "",
                result: {
                  artifacts: [
                    {
                      path: "requirements.md",
                      content: "可追溯的部分需求",
                      sha256: "abc123",
                    },
                  ],
                },
              },
            ],
    );
    const user = userEvent.setup();
    render(
      <AntApp>
        <EvidencePanel projectId="p1" version={1} onImprove={vi.fn()} />
      </AntApp>,
    );
    await user.click(
      await screen.findByRole("button", { name: "停止本次运行" }),
    );
    expect(mocked).toHaveBeenCalledWith("/evaluations/task1/cancel", {
      method: "POST",
    });
    await user.click(screen.getByText("requirements.md · abc123"));
    expect(screen.getByText("可追溯的部分需求")).toBeVisible();
  });
  it("显示资料覆盖边界和评估阻塞，并将建议带回AI 团队", async () => {
    mocked.mockImplementation(async (path) =>
      path.endsWith("/sources")
        ? [source]
        : [
            {
              id: "eval-1",
              design_version: 2,
              kind: "review",
              status: "completed",
              error: "",
              result: {
                summary: "仍缺完整资料",
                checks: [
                  {
                    id: "source_coverage",
                    status: "blocked",
                    reason: "仅摘录",
                    evidence: ["source-1"],
                    improvement: "补充全文",
                  },
                ],
                next_iteration: "完善感知契约",
              },
            },
          ],
    );
    const improve = vi.fn(),
      user = userEvent.setup();
    render(
      <AntApp>
        <EvidencePanel projectId="p1" version={2} onImprove={improve} />
      </AntApp>,
    );
    expect(await screen.findByText("PRD摘录")).toBeVisible();
    expect(await screen.findByText("仅摘录")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "带着评估结果继续优化" }),
    );
    expect(improve.mock.calls[0][0]).toContain("eval-1");
    expect(improve.mock.calls[0][0]).toContain("完善感知契约");
    expect(
      screen.getByRole("button", { name: "运行基线单元测试" }),
    ).toBeDisabled();
  });
  it("旧方案的评估不能直接应用于当前版本", async () => {
    mocked.mockImplementation(async (path) =>
      path.endsWith("/sources")
        ? [source]
        : [
            {
              id: "old",
              design_version: 1,
              kind: "review",
              status: "completed",
              error: "",
              result: { next_iteration: "旧建议" },
            },
          ],
    );
    render(
      <AntApp>
        <EvidencePanel projectId="p1" version={2} onImprove={vi.fn()} />
      </AntApp>,
    );
    expect(
      await screen.findByText("历史版本，请重新评估当前方案"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "带着评估结果继续优化" }),
    ).toBeDisabled();
  });
  it("导入失败保留路径并展示错误", async () => {
    mocked.mockImplementation(async (path, options) => {
      if (options?.method === "POST")
        throw new Error("目录不在授权资料根目录内");
      return [];
    });
    const user = userEvent.setup();
    render(
      <AntApp>
        <EvidencePanel projectId="p1" version={1} onImprove={vi.fn()} />
      </AntApp>,
    );
    await user.type(screen.getByLabelText("代码基线目录"), "/invalid");
    await user.click(screen.getByRole("button", { name: "导入源码快照" }));
    expect(await screen.findByText("目录不在授权资料根目录内")).toBeVisible();
    expect(screen.getByLabelText("代码基线目录")).toHaveValue("/invalid");
  });
});
