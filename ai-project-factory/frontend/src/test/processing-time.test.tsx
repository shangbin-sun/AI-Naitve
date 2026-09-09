import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ProcessingTime, { formatElapsed } from "../chat/ProcessingTime";

afterEach(() => vi.useRealTimers());
it("从服务端开始时间恢复计时，完成后固定耗时并清理定时器", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T08:00:35Z"));
  const props = { startedAt: "2026-09-09T08:00:00Z", running: true };
  const view = render(<ProcessingTime {...props} />);
  expect(screen.getByLabelText("本次处理耗时")).toHaveTextContent(
    "已处理 35秒",
  );
  act(() => vi.advanceTimersByTime(26000));
  expect(screen.getByLabelText("本次处理耗时")).toHaveTextContent(
    "已处理 1分钟 1秒",
  );
  view.rerender(
    <ProcessingTime
      {...props}
      running={false}
      finishedAt="2026-09-09T08:01:02Z"
    />,
  );
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByLabelText("本次处理耗时")).toHaveTextContent(
    "用时 1分钟 2秒",
  );
  expect(vi.getTimerCount()).toBe(0);
});
it("无有效时间不显示伪造耗时", () => {
  render(<ProcessingTime running={false} />);
  expect(screen.queryByLabelText("本次处理耗时")).toBeNull();
  expect(formatElapsed(-1000)).toBe("0秒");
  expect(formatElapsed(3661000)).toBe("1小时 1分钟 1秒");
});
