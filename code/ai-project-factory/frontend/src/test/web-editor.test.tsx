import { afterEach, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebEditor } from "../tasks/useWebEditor";
import type { OutputStep } from "../tasks/buildOutputChain";
const step = { id: "run-develop-1", origin: "run" } as OutputStep;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("点击打开 HTTP 编辑器并传递准确的轮次文件", async () => {
  const tab = {
    opener: {},
    closed: false,
    location: { href: "" },
    close: vi.fn(),
  };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  const fetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({ url: "http://127.0.0.1:8787/?folder=test" }),
    });
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useWebEditor("/api/tasks/t/runs"));
  await act(() => result.current.open(step, "a.py"));
  expect(fetch).toHaveBeenCalledWith(
    "/api/tasks/t/runs/run/web-editor",
    expect.objectContaining({
      body: JSON.stringify({ step_id: step.id, filename: "a.py" }),
    }),
  );
  expect(tab.location.href).toContain("http://127.0.0.1:8787/");
  expect(tab.opener).toBeNull();
});
it("编辑器未启动时关闭空白页并显示错误，允许重试", async () => {
  const tab = { opener: null, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        ok: false,
        json: async () => ({ detail: "编辑器未启动" }),
      }),
  );
  const { result } = renderHook(() => useWebEditor("/api/tasks/t/runs"));
  await act(() => result.current.open(step));
  expect(tab.close).toHaveBeenCalled();
  expect(result.current.error).toBe("编辑器未启动");
  expect(result.current.opening).toBe(false);
});
it("弹窗受阻时仍提供可点击的 HTTP 入口", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ url: "http://127.0.0.1:8787/" }),
      }),
  );
  const { result } = renderHook(() => useWebEditor("/api/tasks/t/runs"));
  await act(() => result.current.open(step));
  expect(result.current.url).toBe("http://127.0.0.1:8787/");
});
