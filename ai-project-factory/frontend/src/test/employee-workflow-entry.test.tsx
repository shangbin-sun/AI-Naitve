import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { EmployeeEditor } from "../App";
import { api } from "../api";
import type { Employee } from "../types";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const workflow = { version: 2, title: "分析方法", goal: "交付报告", steps: [{ id: "S01", name: "分析", goal: "核实", requirements: [], actions: [], input: "资料", output: "报告", acceptance: "有依据" }] };
const employee: Employee = { id: "e", design_id: "d", key: "analyst", active: true, version: 3,
  profile: { key: "analyst", name: "分析员", role: "分析", kind: "ai", responsibilities: [], skills: [], inputs: [], outputs: [], instructions: "核实" },
  files: { "workflow.json": JSON.stringify(workflow), "README.md": "保留" } };
beforeEach(() => vi.mocked(api).mockReset());
function mount(files = employee.files) {
  render(<AntApp><EmployeeEditor employee={{ ...employee, files }} onSave={async () => {}} onClose={() => {}} /></AntApp>);
  return userEvent.setup();
}
it("员工详情可查看已保存流程并连续编辑保存，不需要任务聊天", async () => {
  vi.mocked(api).mockImplementation(async (_url, options) => {
    if (!options?.body) return {};
    const body = JSON.parse(options!.body as string);
    return { ...employee, ...body, version: body.expected_version + 1 };
  });
  const user = mount();
  await user.click(screen.getByRole("tab", { name: "WorkFlow" }));
  expect(screen.getByText("分析方法")).toBeVisible();
  expect(screen.getByRole("button", { name: /保存 WorkFlow/ })).toBeDisabled();
  await user.type(screen.getByLabelText("步骤1名称"), "改进");
  await user.click(screen.getByRole("button", { name: /保存 WorkFlow/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /保存 WorkFlow/ })).toBeDisabled());
  const writes = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PUT");
  expect(JSON.parse(writes()[0][1]!.body as string).files["README.md"]).toBe("保留");
  await user.type(screen.getByLabelText("步骤1名称"), "再次");
  await user.click(screen.getByRole("button", { name: /保存 WorkFlow/ }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(JSON.parse(writes()[1][1]!.body as string).expected_version).toBe(4);
});
it("无流程显示提示且不发起模型调用", async () => {
  const user = mount({});
  await user.click(screen.getByRole("tab", { name: "WorkFlow" }));
  expect(screen.getByText(/还没有已保存的 WorkFlow/)).toBeVisible();
  expect(api).not.toHaveBeenCalled();
});
it("损坏的流程显示错误而非崩溃", async () => {
  const user = mount({ "workflow.json": "invalid" });
  await user.click(screen.getByRole("tab", { name: "WorkFlow" }));
  expect(screen.getByText("WorkFlow 格式无法展示")).toBeVisible();
});
