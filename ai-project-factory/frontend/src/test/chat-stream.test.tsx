import { it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import ProjectChat from "../chat/ProjectChat";
vi.mock("../WorkspaceBrowser", () => ({ default: () => null }));

it("逐段显示、重连恢复、完成不重复，并关闭旧AI 团队连接", () => {
  const sources: FakeSource[] = [];
  class FakeSource {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(public url: string) {
      sources.push(this);
    }
    emit(reply: string, status = "running") {
      this.onmessage?.({
        data: JSON.stringify({ id: "job", reply, status, message: "生成中" }),
      });
    }
  }
  const original = globalThis.EventSource;
  vi.stubGlobal("EventSource", FakeSource);
  try {
    const props = {
      workspaceId: "one",
      jobId: "job",
      messages: [],
      busy: true,
      canCancel: true,
      onSend: vi.fn(),
      onCancel: vi.fn(),
      onBuild: vi.fn(),
    };
    const view = render(<ProjectChat {...props} />);
    expect(sources[0].url).toBe("/api/jobs/job/events");
    act(() => sources[0].emit("你好"));
    expect(screen.getByText("你好")).toBeVisible();
    act(() => sources[0].onerror?.());
    expect(screen.getByRole("status")).toHaveTextContent("正在重连");
    act(() => sources[0].emit("你好，完整回复"));
    expect(screen.queryByText("你好")).toBeNull();
    expect(screen.getByText("你好，完整回复")).toBeVisible();
    act(() => sources[0].emit("你好，完整回复", "completed"));
    expect(sources[0].close).toHaveBeenCalled();
    view.rerender(
      <ProjectChat
        {...props}
        busy={false}
        messages={[
          { id: "saved", role: "assistant", content: "你好，完整回复" },
        ]}
      />,
    );
    expect(screen.getAllByText("你好，完整回复")).toHaveLength(1);
    view.rerender(<ProjectChat {...props} jobId="next" />);
    expect(screen.queryByText("你好，完整回复")).toBeNull();
    view.unmount();
    expect(sources[1].close).toHaveBeenCalled();
  } finally {
    vi.stubGlobal("EventSource", original);
  }
});

it("每条历史回复独立显示耗时，下一轮不会覆盖之前的时间", () => {
  render(
    <ProjectChat
      workspaceId="one"
      busy={false}
      canCancel={false}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      onBuild={vi.fn()}
      messages={[
        {
          id: "a",
          role: "assistant",
          content: "第一轮",
          timing: {
            started_at: "2026-09-09T08:00:00Z",
            finished_at: "2026-09-09T08:00:04Z",
          },
        },
        {
          id: "b",
          role: "assistant",
          content: "第二轮",
          timing: {
            started_at: "2026-09-09T08:01:00Z",
            finished_at: "2026-09-09T08:01:35Z",
          },
        },
      ]}
    />,
  );
  expect(
    screen.getByText("用时 4秒").closest(".factory-chat-message"),
  ).toHaveTextContent("第一轮");
  expect(
    screen.getByText("用时 35秒").closest(".factory-chat-message"),
  ).toHaveTextContent("第二轮");
});

it("等待首字与流式输出共用同一行角色和计时，不产生独立计时行", () => {
  const sources: { onmessage: ((e: { data: string }) => void) | null }[] = [];
  const original = globalThis.EventSource;
  class Source {
    onmessage = null;
    onerror = null;
    close() {}
    constructor() {
      sources.push(this);
    }
  }
  vi.stubGlobal("EventSource", Source);
  try {
    const view = render(
      <ProjectChat
        workspaceId="one"
        jobId="running"
        jobCreatedAt={new Date(Date.now() - 7000).toISOString()}
        busy
        canCancel
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onBuild={vi.fn()}
        messages={[]}
      />,
    );
    const timer = screen.getByLabelText("本次处理耗时");
    expect(timer.parentElement).toHaveClass("factory-chat-author");
    expect(timer.parentElement).toHaveTextContent("AI 团队助手");
    expect(screen.getAllByText("✳ AI 团队助手")).toHaveLength(1);
    act(() =>
      sources[0].onmessage?.({
        data: JSON.stringify({
          id: "running",
          reply: "正在回复",
          status: "running",
        }),
      }),
    );
    expect(screen.getByLabelText("本次处理耗时")).toBe(timer);
    expect(screen.getByText("正在回复")).toBeVisible();
    expect(screen.getAllByLabelText("本次处理耗时")).toHaveLength(1);
    view.unmount();
  } finally {
    vi.stubGlobal("EventSource", original);
  }
});
