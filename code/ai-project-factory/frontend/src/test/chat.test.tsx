import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectChat from "../chat/ProjectChat";
import { createImageAdapter } from "../chat/attachments";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn() }));
function props() {
  return {
    workspaceId: "one",
    messages: [],
    busy: false,
    canCancel: false,
    onSend: vi.fn().mockResolvedValue(true),
    onCancel: vi.fn().mockResolvedValue(undefined),
    onBuild: vi.fn().mockResolvedValue(true),
  };
}
describe("项目对话", () => {
  it("空消息不可发送，Enter 发送文字并清空输入", async () => {
    const p = props();
    render(<ProjectChat {...p} />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("讨论当前项目"),
      "保留员工并调整流程{Enter}",
    );
    await waitFor(() =>
      expect(p.onSend).toHaveBeenCalledWith("保留员工并调整流程", []),
    );
    expect(screen.getByLabelText("讨论当前项目")).toHaveValue("");
  });
  it("发送被拒绝时恢复输入，支持再次发送", async () => {
    const p = props();
    p.onSend.mockResolvedValueOnce(false);
    render(<ProjectChat {...p} />);
    await userEvent.type(
      screen.getByLabelText("讨论当前项目"),
      "修改测试节点{Enter}",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("讨论当前项目")).toHaveValue("修改测试节点"),
    );
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(p.onSend).toHaveBeenCalledTimes(2));
  });
  it("Shift Enter 换行，中文输入法确认不会提交", async () => {
    const p = props();
    render(<ProjectChat {...p} />);
    const input = screen.getByLabelText("讨论当前项目");
    await userEvent.type(input, "第一步{Shift>}{Enter}{/Shift}第二步");
    expect(input).toHaveValue("第一步\n第二步");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(p.onSend).not.toHaveBeenCalled();
  });
  it("运行时显示进度并可停止，构建按钮保留", async () => {
    const p = props();
    render(<ProjectChat {...p} busy canCancel status="正在分析截图" />);
    expect(screen.getByRole("status")).toHaveTextContent("正在分析截图");
    expect(screen.getByLabelText("讨论当前项目")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(p.onCancel).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "按原有测试构建并验证" }),
    ).toBeDisabled();
  });
  it("恢复历史文字和图片；按项目 key 切换隔离草稿", async () => {
    const p = props();
    const view = render(
      <ProjectChat
        key="one"
        {...p}
        messages={[
          {
            id: "m",
            role: "user",
            content: "按图调整",
            attachments: [
              {
                id: "a",
                name: "流程.png",
                content_type: "image/png",
                url: "/api/image",
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("按图调整")).toBeVisible();
    expect(screen.getByAltText("流程.png")).toHaveAttribute(
      "src",
      "/api/image",
    );
    await userEvent.type(screen.getByLabelText("讨论当前项目"), "未发送的修改");
    view.rerender(<ProjectChat key="two" {...p} workspaceId="two" />);
    expect(screen.queryByText("按图调整")).not.toBeInTheDocument();
    expect(screen.getByLabelText("讨论当前项目")).toHaveValue("");
  });
  it("原有构建操作收到输入且成功后清空", async () => {
    const p = props();
    render(<ProjectChat {...p} />);
    await userEvent.type(
      screen.getByLabelText("讨论当前项目"),
      "根据参考测试修复开发流程中的问题",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "按原有测试构建并验证" }),
    );
    expect(p.onBuild).toHaveBeenCalledWith("根据参考测试修复开发流程中的问题");
    await waitFor(() =>
      expect(screen.getByLabelText("讨论当前项目")).toHaveValue(""),
    );
  });
  it("图片上传适配器保存服务端 ID，移除调用项目接口", async () => {
    const mocked = vi.mocked(api);
    mocked.mockResolvedValueOnce({
      id: "a",
      name: "图.png",
      content_type: "image/png",
      url: "/api/a",
    });
    const adapter = createImageAdapter("one", vi.fn());
    const image = await adapter.add({
      file: new File(["png"], "图.png", { type: "image/png" }),
    });
    if (!("id" in image)) throw new Error("Expected attachment");
    expect(image.id).toBe("a");
    expect((await adapter.send(image)).content).toEqual([
      { type: "image", image: "/api/a" },
    ]);
    await adapter.remove(image);
    expect(mocked).toHaveBeenLastCalledWith(
      "/workspaces/one/chat-attachments/a",
      { method: "DELETE" },
    );
  });
  it("粘贴图片后可单独发送，并传递附件 ID", async () => {
    vi.mocked(api).mockResolvedValueOnce({
      id: "paste",
      name: "截图.png",
      content_type: "image/png",
      url: "/api/paste",
    });
    const p = props();
    render(<ProjectChat {...p} />);
    fireEvent.paste(screen.getByLabelText("讨论当前项目"), {
      clipboardData: {
        files: [new File(["png"], "截图.png", { type: "image/png" })],
      },
    });
    await screen.findByAltText("截图.png");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith("", ["paste"]));
  });
  it("发送前移除图片，发送按钮恢复禁用", async () => {
    vi.mocked(api).mockResolvedValueOnce({
      id: "remove",
      name: "删除.png",
      content_type: "image/png",
      url: "/api/remove",
    });
    render(<ProjectChat {...props()} />);
    fireEvent.paste(screen.getByLabelText("讨论当前项目"), {
      clipboardData: {
        files: [new File(["png"], "删除.png", { type: "image/png" })],
      },
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "移除 删除.png" }),
    );
    await waitFor(() =>
      expect(screen.queryByAltText("删除.png")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
  it("不支持格式在上传之前报错", async () => {
    const error = vi.fn();
    const adapter = createImageAdapter("one", error);
    await expect(
      adapter.add({
        file: new File(["svg"], "x.svg", { type: "image/svg+xml" }),
      }),
    ).rejects.toThrow("支持");
    expect(error).toHaveBeenCalled();
  });
});
