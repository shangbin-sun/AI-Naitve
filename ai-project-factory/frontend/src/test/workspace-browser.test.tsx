import { expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WorkspaceBrowser from "../WorkspaceBrowser";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));

it("工作空间随运行切换，目录和文件请求都保留运行范围", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes("/file?")
      ? { name: "result.md", text: "成果内容" }
      : {
          root: path.includes("run_id=r2") ? "/run-two" : "/run-one",
          label: "任务工作空间",
          entries: [
            { name: "result.md", path: "outputs/result.md", directory: false },
          ],
        },
  );
  const view = render(<WorkspaceBrowser key="r1" projectId="p" runId="r1" />);
  await screen.findByRole("button", { name: "复制路径" });
  expect(screen.queryByText("/run-one")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "用 VS Code 打开" })).toHaveAttribute(
    "href",
    "vscode://file/run-one",
  );
  await userEvent.click(screen.getByRole("button", { name: "result.md" }));
  expect(await screen.findByText("成果内容")).toBeVisible();
  expect(api).toHaveBeenCalledWith(
    "/workspaces/p/file?path=outputs%2Fresult.md&run_id=r1",
  );
  view.rerender(<WorkspaceBrowser key="r2" projectId="p" runId="r2" />);
  await screen.findByRole("button", { name: "复制路径" });
  expect(screen.queryByText("/run-two")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "用 VS Code 打开" })).toHaveAttribute(
    "href",
    "vscode://file/run-two",
  );
  await waitFor(() =>
    expect(screen.queryByText("成果内容")).not.toBeInTheDocument(),
  );
});

it("保存AI 团队规则携带读取版本并显示新内容", async () => {
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === "PUT") return { name: "AGENTS.md", path: "AGENTS.md", text: "AI 团队独立规则", editable: true, version: 3 };
    if (path.includes("/file?")) return { name: "AGENTS.md", text: "默认规则", editable: true, version: 2 };
    return { root: "/project", label: "AI 团队工作空间", entries: [{ name: "AGENTS.md", path: "AGENTS.md", directory: false }] };
  });
  render(<WorkspaceBrowser projectId="p" />);
  await userEvent.click(await screen.findByRole("button", { name: "AGENTS.md" }));
  await userEvent.click(await screen.findByRole("button", { name: "编辑规则" }));
  await userEvent.clear(screen.getByRole("textbox", { name: "规则内容" }));
  await userEvent.type(screen.getByRole("textbox", { name: "规则内容" }), "AI 团队独立规则");
  await userEvent.click(screen.getByRole("button", { name: "保存规则" }));
  expect(await screen.findByText("AI 团队独立规则")).toBeVisible();
  expect(api).toHaveBeenCalledWith("/workspaces/p/file", {
    method: "PUT", body: JSON.stringify({ path: "AGENTS.md", text: "AI 团队独立规则", expected_version: 2 }),
  });
});
