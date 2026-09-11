import { expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmployeeAbilityActions from "../tasks/EmployeeAbilityActions";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
it("能力提交期间避免重复请求并禁用验证，完成后恢复", async () => {
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
      onVerify={() => {}}
    />,
  );
  const update = screen.getByRole("button", { name: "增强员工能力" });
  await userEvent.click(update);
  await userEvent.click(update);
  expect(onGenerate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "重新验证" })).toBeDisabled();
  await act(async () => finish(true));
  expect(screen.getByRole("button", { name: "重新验证" })).toBeEnabled();
});
it("验证输入加载期间禁用更新，失败后恢复操作", async () => {
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
      onVerify={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "重新验证" }));
  expect(screen.getByRole("button", { name: "增强员工能力" })).toBeDisabled();
  await act(async () => reject(new Error("读取失败")));
  expect(await screen.findByText("读取失败")).toBeVisible();
  expect(screen.getByRole("button", { name: "增强员工能力" })).toBeEnabled();
});
