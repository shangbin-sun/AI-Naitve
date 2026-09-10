import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import EmployeeWorkflow, { employeeGraph } from "../workflow/EmployeeWorkflow";
import type { Draft, Member } from "../types";
const member = (key: string, kind: "ai" | "human" = "ai"): Member => ({
  key,
  name: key,
  kind,
  role: `${key}职责`,
  responsibilities: [],
  instructions: "",
  skills: [],
  inputs: ["输入"],
  outputs: ["交付"],
});
const draft: Draft = {
  name: "AI 团队",
  goal: "目标",
  members: [member("需求AI"), member("架构AI"), member("负责人", "human")],
  workflow: [
    {
      key: "one",
      name: "解析",
      owner: "需求AI",
      kind: "work",
      depends_on: [],
      input: "原文",
      output: "摘要",
      acceptance: "可追溯",
    },
    {
      key: "two",
      name: "需求",
      owner: "需求AI",
      kind: "work",
      depends_on: ["one"],
      input: "摘要",
      output: "需求",
      acceptance: "完整",
    },
    {
      key: "human",
      name: "确认",
      owner: "负责人",
      kind: "approval",
      depends_on: ["two"],
      input: "需求",
      output: "意见",
      acceptance: "确认",
    },
    {
      key: "three",
      name: "架构",
      owner: "架构AI",
      kind: "work",
      depends_on: ["human"],
      input: "意见",
      output: "架构",
      acceptance: "可行",
    },
  ],
  requirements: [],
  assumptions: [],
  questions: [],
  ready: true,
};

it("重复步骤合并为一位员工，投影真实交接并保留人工接收人", () => {
  const graph = employeeGraph(draft);
  expect(graph.ai).toHaveLength(2);
  expect(graph.edges).toEqual([{ from: "需求AI", to: "架构AI" }]);
  expect(graph.assignments).toEqual({ 需求AI: "负责人", 架构AI: "负责人" });
  const changed = employeeGraph({
    ...draft,
    human_routing: { assignments: { 架构AI: "专业人类" } },
    members: [...draft.members, member("专业人类", "human")],
  });
  expect(changed.assignments["架构AI"]).toBe("专业人类");
});

it("没有人类成员时展示默认AI 团队负责人，不改写原始成员", () => {
  const noHumans = {
    ...draft,
    members: draft.members.filter((m) => m.kind === "ai"),
  };
  expect(employeeGraph(noHumans).humans[0].name).toBe("AI 团队负责人（你）");
  expect(noHumans.members).toHaveLength(2);
});

it("点击员工卡片直接打开对应编辑器，不显示重复协作详情", async () => {
  const onEmployee = vi.fn();
  render(<EmployeeWorkflow draft={draft} onEmployee={onEmployee} />);
  expect(screen.queryByText("原文")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /需求AI职责/ }));
  expect(onEmployee).toHaveBeenCalledOnce();
  expect(onEmployee).toHaveBeenCalledWith(draft.members[0]);
  expect(screen.queryByRole("region", { name: "需求AI的协作详情" })).toBeNull();
});

it("输入输出沿实际步骤边界连接，保留最终人工交付", () => {
  const graph = employeeGraph(draft);
  expect(graph.entries).toEqual(["需求AI"]);
  expect(graph.exits).toEqual(["架构AI"]);
  expect(graph.inputs).toEqual(["原文"]);
  expect(graph.outputs).toEqual(["架构"]);
  const repeated = employeeGraph({
    ...draft,
    workflow: [
      ...draft.workflow,
      {
        ...draft.workflow[0],
        key: "final",
        owner: "需求AI",
        depends_on: ["three"],
        output: "最终文档",
      },
    ],
  });
  expect(repeated.entries).toEqual(["需求AI"]);
  expect(repeated.exits).toEqual(["需求AI"]);
  expect(repeated.outputs).toEqual(["最终文档"]);
});

it("默认显示输入输出节点，点击展示实际要求", async () => {
  render(<EmployeeWorkflow draft={draft} />);
  await userEvent.click(screen.getByRole("button", { name: /流程起点/ }));
  expect(
    screen.getByRole("region", { name: "流程输入详情" }),
  ).toHaveTextContent("原文");
  await userEvent.click(screen.getByRole("button", { name: /流程终点/ }));
  expect(
    screen.getByRole("region", { name: "流程输出详情" }),
  ).toHaveTextContent("架构");
  expect(screen.queryByRole("region", { name: "流程输入详情" })).toBeNull();
});
