import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import TaskScheduleFields, {
  emptySchedule,
  schedulePayload,
} from "../tasks/TaskScheduleFields";
it("普通任务不附带调度，定时和循环校验后生成配置", () => {
  expect(schedulePayload(emptySchedule)).toBeUndefined();
  expect(() => schedulePayload({ ...emptySchedule, timed: true })).toThrow(
    "未来",
  );
  expect(() => schedulePayload({ ...emptySchedule, loop: true })).toThrow(
    "停止条件",
  );
  expect(
    schedulePayload({ ...emptySchedule, loop: true, condition: "全部通过" }),
  ).toMatchObject({
    kind: "loop",
    start_at: null,
    stop_condition: "全部通过",
    max_runs: 20,
  });
  expect(
    schedulePayload({
      ...emptySchedule,
      timed: true,
      repeat: true,
      start: "2099-01-01T09:00",
    }),
  ).toMatchObject({ kind: "interval" });
});
it("循环可独立开启，也可设置首次定时时间", async () => {
  function Form() {
    const [v, setV] = useState(emptySchedule);
    return <TaskScheduleFields value={v} onChange={setV} />;
  }
  render(<Form />);
  expect(screen.queryByLabelText("循环停止条件")).toBeNull();
  await userEvent.click(
    screen.getByRole("checkbox", { name: "按条件循环执行" }),
  );
  expect(screen.getByLabelText("循环停止条件")).toBeVisible();
  expect(screen.getByLabelText("最多执行次数")).toHaveValue("20");
  await userEvent.click(screen.getByRole("checkbox", { name: "定时执行" }));
  expect(screen.getByLabelText("首次执行时间")).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "定时方式" })).toBeNull();
});
