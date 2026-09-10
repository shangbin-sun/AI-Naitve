import { afterEach, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLocalEditor } from "../tasks/useLocalEditor";
import type { OutputStep } from "../tasks/buildOutputChain";
const step = { id: "s", origin: "run" } as OutputStep;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("准备文件后唤起本机 VS Code，保留中文路径", async () => {
  const assign = vi.fn();
  const original = window;
  vi.stubGlobal("window", new Proxy(original, { get(target, key) { return key === "location" ? { assign } : Reflect.get(target, key); } }));
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ files: [{ step_id: "s", name: "文件.md", folder: "/中文 空格", path: "/中文 空格/文件.md" }] }) });
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useLocalEditor("/api/runs"));
  await act(() => result.current.open(step, "文件.md"));
  expect(fetch).toHaveBeenCalledWith("/api/runs/run/output-workspace", { method: "POST" });
  expect(assign).toHaveBeenCalledWith(`vscode://file/${encodeURIComponent("中文 空格")}/${encodeURIComponent("文件.md")}`);
  expect(result.current.url).toBe(assign.mock.calls[0][0]);
});
it("不允许从其他员工目录选择文件", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ files: [{ step_id: "s", folder: "/a" }], directory_files: [{ folder: "/b", relative_path: "secret", path: "/b/secret" }] }) }));
  const { result } = renderHook(() => useLocalEditor("/api/runs"));
  await act(() => result.current.open(step, undefined, "secret"));
  expect(result.current.url).toBe("");
  expect(result.current.error).toBe("该环节未保存可编辑文件");
});
