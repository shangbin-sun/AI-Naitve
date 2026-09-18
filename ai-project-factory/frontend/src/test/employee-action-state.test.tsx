import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmployeeAbilityActions from "../tasks/EmployeeAbilityActions";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
beforeEach(() => { vi.mocked(api).mockReset(); });
it("能力提交期间避免重复请求并禁用评测，完成后恢复", async () => {
  let finish!: (value: boolean) => void;
  const onGenerate = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <EmployeeAbilityActions
      base="/test"
      disabled={false}
      running={false}
      onGenerate={onGenerate}
      onEvaluate={() => {}}
    />,
  );
  const update = screen.getByRole("button", { name: "增强员工能力" });
  await userEvent.click(update);
  await userEvent.click(update);
  expect(onGenerate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "评测与调优" })).toBeDisabled();
  await act(async () => finish(true));
  expect(screen.getByRole("button", { name: "评测与调优" })).toBeEnabled();
});
it("评测启动期间禁用更新，失败后恢复操作", async () => {
  let reject!: (e: Error) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  render(
    <EmployeeAbilityActions
      base="/test"
      disabled={false}
      running={false}
      onGenerate={async () => true}
      onEvaluate={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "评测与调优" }));
  expect(screen.getByRole("button", { name: "增强员工能力" })).toBeDisabled();
  await act(async () => reject(new Error("读取失败")));
  expect(await screen.findByText("读取失败")).toBeVisible();
  expect(screen.getByRole("button", { name: "增强员工能力" })).toBeEnabled();
});

it("评测网络失败重试复用请求编号，成功后再次点击使用新编号", async () => {
  const result = {employee_id:"e1",employee_version:2,case_id:"case1",run_id:"eval1",reused:false};
  const onEvaluate = vi.fn();
  vi.mocked(api).mockRejectedValueOnce(new Error("网络响应丢失")).mockResolvedValue(result);
  render(<EmployeeAbilityActions base="/test" disabled={false} running={false} onGenerate={async()=>true} onEvaluate={onEvaluate}/>);
  await userEvent.click(screen.getByRole("button", {name:"评测与调优"}));
  expect(await screen.findByText("网络响应丢失")).toBeVisible();
  expect(onEvaluate).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name:"评测与调优"}));
  expect(onEvaluate).toHaveBeenCalledWith(result);
  const calls = vi.mocked(api).mock.calls;
  expect(calls[0][0]).toBe("/test/evaluation");
  expect(calls[0][1]?.method).toBe("POST");
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
  await userEvent.click(screen.getByRole("button", {name:"评测与调优"}));
  expect(calls[2][1]?.body).not.toBe(calls[1][1]?.body);
});

it("评测启动中连续点击只提交一次请求", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const onEvaluate = vi.fn();
  render(<EmployeeAbilityActions base="/test" disabled={false} running={false} onGenerate={async()=>true} onEvaluate={onEvaluate}/>);
  await userEvent.dblClick(screen.getByRole("button", {name:"评测与调优"}));
  expect(api).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", {name:"增强员工能力"})).toBeDisabled();
  await act(async()=>finish({employee_id:"e1",employee_version:2,case_id:"case1",run_id:"eval1",reused:false}));
  expect(onEvaluate).toHaveBeenCalledTimes(1);
});
