import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExecutionWorkflow from "../tasks/ExecutionWorkflow";

it("主节点与员工节点分别打开自己的日志", async () => {
  const onLogs = vi.fn();
  render(<ExecutionWorkflow nodes={{analyst:{employee:{name:"分析师"},step:{depends_on:[]},status:"running",artifacts:[]}}}
    status="running" busy={false} onOpen={vi.fn()} onRestart={vi.fn()} onData={vi.fn()} onLogs={onLogs}/>);
  await userEvent.click(screen.getByRole("button",{name:"查看主 Agent 日志"}));
  await userEvent.click(screen.getByRole("button",{name:"查看分析师日志"}));
  expect(onLogs.mock.calls).toEqual([[""],["analyst"]]);
  expect(screen.queryByRole("button",{name:"运行过程"})).toBeNull();
});
