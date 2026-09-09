import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { outputChain } from "../tasks/buildOutputChain";
import OutputChain from "../tasks/EmployeeOutputChain";
import type { TaskRun } from "../tasks/types";
const first: TaskRun = {
  id: "first",
  status: "completed",
  design_version: 1,
  created_at: "2026-09-08",
  error: "",
  inputs: {
    task_snapshot: {
      title: "Agent1",
      description: "输入要求",
      acceptance: "通过",
      code_source_id: "code",
      version: 1,
    },
  },
  result: {
    plan: { requirements: ["需求文档"], architecture: ["架构文档"] },
    artifacts: [{ path: "main.py", content: "original output" }],
    attempts: [
      {
        attempt: 0,
        exit_code: 1,
        tests: { executed: 0, passed: 0, failed: 0, skipped: 0, cases: [] },
      },
      {
        attempt: 1,
        summary: "完成修复",
        changed_files: ["main.py"],
        exit_code: 0,
        tests: { executed: 3, passed: 3, failed: 0, skipped: 0, cases: [] },
      },
    ],
  },
};
const second: TaskRun = {
  ...first,
  id: "second",
  inputs: {
    ...first.inputs,
    resume_run_id: "first",
    previous_plan: first.result.plan,
  },
  result: {
    plan: first.result.plan,
    attempts: [
      {
        attempt: 0,
        exit_code: 0,
        tests: { executed: 3, passed: 3, failed: 0, skipped: 0, cases: [] },
      },
    ],
  },
};
describe("员工产出链", () => {
  it("续跑追溯原方案和代码，不把继承方案标为新产出", () => {
    const { steps } = outputChain(second, [second, first]);
    expect(steps.filter((s) => s.title === "需求分析与架构设计")).toHaveLength(
      1,
    );
    const code = steps.find((s) => s.title === "代码开发 · 第 1 轮")!;
    expect(code.reused).toBe(true);
    expect(code.origin).toBe("first");
    expect(code.files[1].content).toBe("original output");
    expect(steps.at(-1)?.title).toBe("本轮复测");
    expect(
      steps.find((s) => s.title === "需求分析与架构设计")?.handoff,
    ).toContain("开发");
  });
  it("缺失前序记录不借用其他任务成果，也不编造代码", () => {
    const { steps, missing } = outputChain(second, [second]);
    expect(missing).toBe(true);
    expect(steps.some((s) => s.title.startsWith("代码开发"))).toBe(false);
  });
  it("每轮代码使用自己的产物，旧轮次缺失正文明确为空", () => {
    const run: TaskRun = {
      ...first,
      result: {
        ...first.result,
        attempts: [
          {
            attempt: 1,
            changed_files: ["one.py"],
            artifacts: [{ path: "one.py", content: "version 1" }],
          },
          { attempt: 2, changed_files: ["main.py"] },
        ],
      },
    };
    expect(
      outputChain(run, [run]).steps.find((s) => s.id.endsWith("develop-1"))
        ?.files[1].content,
    ).toBe("version 1");
  });
  it("被拒绝的补丁不显示之前成功轮次的代码", () => {
    const run: TaskRun = {
      ...first,
      result: {
        ...first.result,
        attempts: [{ attempt: 1, error: "拒绝修改测试" }],
      },
    };
    const development = outputChain(run, [run]).steps.find((s) =>
      s.id.endsWith("develop-1"),
    );
    expect(development?.files).toHaveLength(1);
    expect(development?.files[0].content).toBe("拒绝修改测试");
  });
  it("同一员工的多轮文件归入一个员工标题", async () => {
    const run: TaskRun = {
      ...first,
      inputs: {
        ...first.inputs,
        employees: [
          { key: "it_development", version: 1, profile: { name: "员工B" } },
        ],
      },
      result: {
        ...first.result,
        attempts: [
          {
            attempt: 1,
            artifacts: [{ path: "first.py", content: "第一轮数据" }],
          },
          {
            attempt: 2,
            artifacts: [{ path: "second.py", content: "第二轮数据" }],
          },
        ],
      },
    };
    render(<OutputChain run={run} runs={[run]} />);
    expect(screen.getAllByRole("heading", { name: /员工B/ })).toHaveLength(1);
    expect(screen.getByText("first.py")).toBeVisible();
    expect(screen.queryByText("第一轮数据")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "查看全部（4）" }),
    );
    expect(screen.getByText("second.py")).toBeVisible();
  });
  it("附件列表默认三项，查看全部展开剩余文件并可收起", async () => {
    const run: TaskRun = {
      ...first,
      result: {
        attempts: [
          {
            attempt: 1,
            artifacts: [1, 2, 3, 4].map((i) => ({
              path: `file-${i}.py`,
              content: "代码",
            })),
          },
        ],
      },
    };
    render(<OutputChain run={run} runs={[run]} />);
    expect(screen.queryByText("file-4.py")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "查看全部（5）" }),
    );
    expect(screen.getByText("file-4.py")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByText("file-4.py")).not.toBeInTheDocument();
  });
  it("目录入口在网页展示完整文件，切换正文并返回列表", async () => {
    render(<OutputChain run={second} runs={[second, first]} />);
    await userEvent.click(
      screen.getAllByRole("button", { name: "查看原始记录" })[1],
    );
    expect(
      screen.getByRole("navigation", { name: "产出文件列表" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /main.py/ }));
    expect(screen.getByText("original output")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "返回员工产出" }));
    expect(screen.queryByText("original output")).not.toBeInTheDocument();

  });
  it("按员工列文件与打开入口，不展开正文", async () => {
    render(<OutputChain run={second} runs={[second, first]} />);
    expect(screen.getByText("main.py")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /打开文件/ }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("任务说明与验收要求")).not.toBeInTheDocument();
    expect(screen.queryByText("original output")).not.toBeInTheDocument();
    expect(screen.getAllByText(/历史未绑定具体员工/).length).toBeGreaterThan(0);
    expect(screen.getByText(/部署尚未接通/)).toBeVisible();
  });
});
