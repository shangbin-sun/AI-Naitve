import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import Factory, { EmployeeEditor, ProjectDetails } from "../App";
import { api } from "../api";
import type { Employee, Draft, Design } from "../types";
vi.mock("../api", () => ({ api: vi.fn() }));
const mocked = vi.mocked(api);
const member = {
  key: "analyst",
  name: "测试分析员",
  role: "需求分析",
  kind: "ai" as const,
  responsibilities: ["定义需求"],
  instructions: "核实输入后分析",
  skills: ["需求分析"],
  inputs: ["用户目标"],
  outputs: ["需求报告"],
};
const employee: Employee = {
  id: "employee-1",
  design_id: "design-1",
  key: "analyst",
  profile: member,
  files: {
    "instructions/role.md": member.instructions,
    "README.md": "# 员工说明",
    "evaluations/example.json": "{}",
  },
  version: 1,
  active: true,
};
const draft: Draft = {
  name: "交互测试团队",
  goal: "验证交互",
  members: [member],
  workflow: [
    {
      key: "work",
      name: "分析需求",
      kind: "work",
      owner: "analyst",
      depends_on: [],
      input: "用户目标",
      output: "需求报告",
      acceptance: "内容完整",
    },
  ],
  requirements: [{ name: "运行环境", description: "等待配置", blocking: true }],
  assumptions: [],
  questions: ["使用什么数据？"],
  ready: true,
};
const design: Design = {
  id: "design-1",
  title: draft.name,
  draft,
  version: 1,
  updated_at: new Date().toISOString(),
  messages: [],
  jobs: [],
  employees: [employee],
};
function mount(ui: React.ReactNode) {
  return render(
    <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
      <AntApp>{ui}</AntApp>
    </ConfigProvider>,
  );
}
function editor() {
  const onClose = vi.fn(),
    onSave = vi.fn().mockResolvedValue(undefined);
  mount(
    <EmployeeEditor
      employee={structuredClone(employee)}
      onClose={onClose}
      onSave={onSave}
    />,
  );
  return { onClose, onSave, user: userEvent.setup() };
}
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  mocked.mockReset();
});

describe("员工编辑器", () => {
  it("无修改时关闭按钮直接关闭", async () => {
    const { user, onClose } = editor();
    expect(screen.getByRole("button", { name: /保存修改/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("有修改时关闭弹出确认，继续编辑保留输入", async () => {
    const { user, onClose } = editor();
    await user.type(screen.getByLabelText("员工名称"), "修改");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续编辑" })).toBeVisible(),
    );
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("员工名称")).toHaveValue("测试分析员修改");
  });
  it("确认丢弃后关闭", async () => {
    const { user, onClose } = editor();
    await user.type(screen.getByLabelText("员工名称"), "修改");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(await screen.findByRole("button", { name: "丢弃并关闭" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
  it("保存成功更新版本并解除未保存状态", async () => {
    mocked.mockResolvedValue({
      ...employee,
      version: 2,
      profile: { ...member, name: "新名称" },
    });
    const { user, onClose, onSave } = editor();
    await user.clear(screen.getByLabelText("员工名称"));
    await user.type(screen.getByLabelText("员工名称"), "新名称");
    await user.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /保存修改/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("保存失败展示错误并保留修改", async () => {
    mocked.mockRejectedValue(new Error("员工已被修改，请刷新后重试"));
    const { user, onClose } = editor();
    await user.type(screen.getByLabelText("员工名称"), "修改");
    await user.click(screen.getByRole("button", { name: /保存修改/ }));
    expect(await screen.findByText("员工已被修改，请刷新后重试")).toBeVisible();
    expect(screen.getByLabelText("员工名称")).toHaveValue("测试分析员修改");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("新增文件、切换文件和评测样例跳转", async () => {
    const { user } = editor();
    await user.click(screen.getByRole("tab", { name: /工程文件/ }));
    await user.type(
      screen.getByPlaceholderText("新增文件，例如 src/analyze.py"),
      "src/work.py",
    );
    await user.click(screen.getByRole("button", { name: /新增/ }));
    await user.type(screen.getByLabelText("工程文件内容"), "print(42)");
    await user.click(screen.getByRole("button", { name: /README.md/ }));
    expect(screen.getByLabelText("工程文件内容")).toHaveValue("# 员工说明");
    await user.click(screen.getByRole("button", { name: /src\/work.py/ }));
    expect(screen.getByLabelText("工程文件内容")).toHaveValue("print(42)");
    await user.click(screen.getByRole("tab", { name: "评测要求" }));
    await user.click(screen.getByRole("button", { name: /编辑评测样例/ }));
    expect(screen.getByLabelText("工程文件内容")).toHaveValue("{}");
  });
  it("非法文件名在新增时立即阻止", async () => {
    const { user } = editor();
    await user.click(screen.getByRole("tab", { name: /工程文件/ }));
    await user.type(
      screen.getByPlaceholderText("新增文件，例如 src/analyze.py"),
      "../outside.py",
    );
    await user.click(screen.getByRole("button", { name: /新增/ }));
    expect(
      await screen.findByText(/请输入有效且未使用的相对路径/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "file-text ../outside.py" }),
    ).not.toBeInTheDocument();
  });
});

function factory() {
  mocked.mockImplementation(async (path, options) => {
    if (path === "/workspaces") return [design];
    if (path === "/employees") return [employee];
    if (path === "/employees/employee-1") return employee;
    if (path === "/snapshots")
      return [
        {
          id: "project-1",
          design_id: "design-1",
          title: "项目快照",
          design_version: 1,
          snapshot: { team: draft, employees: [employee] },
        },
      ];
    if (path === "/runtime")
      return { available: true, logged_in: true, version: "test" };
    if (path === "/workspaces/design-1") return structuredClone(design);
    if (path.endsWith("/revisions"))
      return [
        {
          version: 1,
          source: "codex",
          draft,
          created_at: new Date().toISOString(),
        },
      ];
    if (path.endsWith("/draft")) return design;
    if (path.endsWith("/snapshots"))
      return {
        id: "project-1",
        design_id: "design-1",
        title: "项目快照",
        design_version: 1,
        snapshot: { team: draft, employees: [employee] },
      };
    throw new Error("未预期请求 " + path);
  });
  mount(<Factory />);
  return userEvent.setup();
}
describe("工作台入口", () => {
  it("首页示例填入输入，发送从禁用变为可用", async () => {
    const user = factory();
    await user.click(screen.getByRole("button", { name: /新建项目/ }));
    expect(screen.getByRole("button", { name: /创建项目/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /模型实验团队/ }));
    expect(
      (screen.getByLabelText("描述项目目标") as HTMLTextAreaElement).value,
    ).toContain("模型实验团队");
    expect(screen.getByRole("button", { name: /创建项目/ })).toBeEnabled();
  });
  it("团队标签、问题填入、历史打开关闭", async () => {
    const user = factory();
    await user.click(
      await screen.findByRole("button", { name: /交互测试团队/ }),
    );
    await user.click(await screen.findByRole("tab", { name: "工作流" }));
    await user.click(
      screen.getByRole("button", { name: /测试分析员.*查看详情/ }),
    );
    expect(await screen.findByLabelText("员工名称")).toHaveValue("测试分析员");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(
      screen.queryByRole("region", { name: "测试分析员的协作详情" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /编辑方案/ })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "任务与运行" }));
    expect(screen.getByText("等待配置")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /使用什么数据/ }));
    expect(screen.getByLabelText("讨论当前项目")).toHaveValue(
      "使用什么数据？\n我的回答：",
    );
    await user.click(screen.getByRole("tab", { name: "版本记录" }));
    await user.click(screen.getByRole("button", { name: /查看修订记录/ }));
    expect(await screen.findByText("方案修订历史")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "方案修订历史" }),
      ).not.toBeInTheDocument(),
    );
  });
  it("员工库入口和项目快照打开关闭，问题可跳回团队", async () => {
    const user = factory();
    await user.click(screen.getByRole("button", { name: /^robot 员工$/ }));
    await user.click(await screen.findByRole("button", { name: /测试分析员/ }));
    expect(await screen.findByLabelText("员工名称")).toHaveValue(member.name);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: /^project 项目$/ }));
    await user.click(
      await screen.findByRole("button", { name: /交互测试团队/ }),
    );
    await user.click(await screen.findByRole("tab", { name: "版本记录" }));
    await user.click(await screen.findByRole("button", { name: /方案修订 1/ }));
    expect(
      await screen.findByText("已保存团队修订 1 的独立快照"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /使用什么数据/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(
        screen.queryByText("已保存团队修订 1 的独立快照"),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("异步操作", () => {
  it("发送后显示停止按钮，停止后恢复输入并说明取消", async () => {
    const user = factory();
    const fallback = mocked.getMockImplementation()!;
    let running = false,
      cancelled = false;
    mocked.mockImplementation(async (path, options) => {
      if (path.endsWith("/messages")) {
        running = true;
        return { id: "job-1", status: "queued" };
      }
      if (path === "/jobs/job-1/cancel") {
        running = false;
        cancelled = true;
        return { id: "job-1", status: "cancelled" };
      }
      if (path === "/workspaces/design-1")
        return {
          ...design,
          jobs:
            running || cancelled
              ? [
                  {
                    id: "job-1",
                    status: running ? "running" : "cancelled",
                    error: cancelled ? "已停止生成" : "",
                    logs: [],
                    usage: {},
                  },
                ]
              : [],
        };
      return fallback(path, options);
    });
    await user.click(
      await screen.findByRole("button", { name: /交互测试团队/ }),
    );
    await user.click(await screen.findByRole("tab", { name: "工作流" }));
    await user.click(screen.getByRole("tab", { name: "对话" }));
    await user.type(
      await screen.findByLabelText("讨论当前项目"),
      "补充一个评审岗位",
    );
    await user.click(screen.getByRole("button", { name: /发送/ }));
    await user.click(await screen.findByRole("button", { name: /停止/ }));
    expect(await screen.findByText("已停止生成")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /停止/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /发送/ })).toBeDisabled();
  });
  it("保存项目快照有完成反馈", async () => {
    const user = factory();
    await user.click(
      await screen.findByRole("button", { name: /交互测试团队/ }),
    );
    await user.click(await screen.findByRole("tab", { name: "工作流" }));
    await user.click(screen.getByRole("tab", { name: "版本记录" }));
    await user.click(screen.getByRole("button", { name: /保存方案快照/ }));
    expect(
      await screen.findByText("已保存团队修订 1 的独立快照"),
    ).toBeVisible();
  });
});

describe("项目内员工详情", () => {
  const project = {
    id: "project-1",
    design_id: "design-1",
    title: "项目快照",
    status: "draft",
    design_version: 1,
    created_at: "2026-09-07",
    snapshot: { team: draft, employees: [employee] },
  };
  it("项目成员可打开，完整指令与版本可见，文件只读且下载对应快照", async () => {
    const user = userEvent.setup();
    mount(<ProjectDetails project={project} onEditTeam={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: /测试分析员.*查看详情/ }),
    );
    expect(await screen.findByText(member.instructions)).toBeVisible();
    expect(
      screen.getByText(/项目快照 · 团队修订 1 · 员工版本 1/),
    ).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "项目工程文件" }));
    const file = screen.getByLabelText("项目快照文件内容");
    expect(file).toHaveValue(member.instructions);
    expect(file).toHaveAttribute("readonly");
    expect(
      screen.getByRole("link", { name: /下载此版本工程/ }),
    ).toHaveAttribute(
      "href",
      "/api/projects/project-1/employees/employee-1/export",
    );
    await user.click(screen.getByRole("button", { name: "README.md" }));
    expect(file).toHaveValue("# 员工说明");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("工作流负责人可查看，详情有返回原团队编辑的入口", async () => {
    const user = userEvent.setup(),
      onEdit = vi.fn();
    mount(<ProjectDetails project={project} onEditTeam={onEdit} />);
    await user.click(
      screen.getByRole("button", { name: /测试分析员.*查看详情/ }),
    );
    const detail = await screen.findByRole("dialog");
    await user.click(
      within(detail).getByRole("button", { name: /返回当前项目方案/ }),
    );
    expect(onEdit).toHaveBeenCalledOnce();
  });
  it("项目待确认问题跳回原团队并填入问题", async () => {
    const user = factory();
    await user.click(screen.getByRole("button", { name: /^project 项目$/ }));
    await user.click(
      await screen.findByRole("button", { name: /交互测试团队/ }),
    );
    await user.click(await screen.findByRole("tab", { name: "版本记录" }));
    await user.click(await screen.findByRole("button", { name: /方案修订 1/ }));
    await user.click(
      await screen.findByRole("button", { name: /使用什么数据/ }),
    );
    expect(await screen.findByLabelText("讨论当前项目")).toHaveValue(
      "使用什么数据？\n我的回答：",
    );
    expect(localStorage.getItem("factory.design")).toBe("design-1");
  });
});

describe("整页导航", () => {
  it("员工编辑整页切换导航时保护未保存修改", async () => {
    const user = factory();
    await user.click(screen.getByRole("button", { name: /^robot 员工$/ }));
    await user.click(await screen.findByRole("button", { name: /测试分析员/ }));
    await user.type(screen.getByLabelText("员工名称"), "未保存");
    await user.click(screen.getByRole("button", { name: /^project 项目$/ }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("员工名称")).toHaveValue("测试分析员未保存");
    await user.click(screen.getByRole("button", { name: /^project 项目$/ }));
    await user.click(await screen.findByRole("button", { name: "丢弃并切换" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("员工名称")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: "项目", level: 1 }),
    ).toBeVisible();
  });
});

describe("项目中心主流程", () => {
  it("只有项目和员工两个主入口，项目默认展示持续项目而非快照", async () => {
    factory();
    expect(
      within(screen.getByRole("navigation")).getAllByRole("button"),
    ).toHaveLength(2);
    expect(
      await screen.findByRole("button", { name: /交互测试团队/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /项目快照/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^robot 员工$/ })).toHaveClass(
      "secondary-nav",
    );
  });
  it("直接链接恢复项目方案和员工详情，返回仍然在本项目", async () => {
    window.history.replaceState(
      null,
      "",
      "#/projects/design-1/plan?employee=employee-1",
    );
    const user = factory();
    expect(await screen.findByLabelText("员工名称")).toHaveValue(member.name);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(window.location.hash).toBe("#/projects/design-1/plan");
    expect(screen.getByRole("tab", { name: "工作流" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /测试分析员.*查看详情/ }),
    ).toBeVisible();
  });
  it("浏览器返回会恢复项目标签", async () => {
    const user = factory();
    await user.click(
      await screen.findByRole("button", { name: /交互测试团队/ }),
    );
    await user.click(await screen.findByRole("tab", { name: "工作流" }));
    await user.click(screen.getByRole("tab", { name: "对话" }));
    window.history.back();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "工作流" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(window.location.hash).toBe("#/projects/design-1/plan");
  });
  it("首次生成失败仍保留已创建项目、目标和输入，不会创建快照", async () => {
    const user = factory();
    const fallback = mocked.getMockImplementation()!;
    const created = {
      ...design,
      id: "new-project",
      title: "新项目",
      version: 0,
      draft: { goal: "训练并评估一个模型" },
      employees: [],
    };
    mocked.mockImplementation(async (path, options) => {
      if (path === "/workspaces" && options?.method === "POST") return created;
      if (path === "/workspaces/new-project") return created;
      if (path.endsWith("/messages"))
        throw new Error("模型服务暂不可用，请重试");
      return fallback(path, options);
    });
    await user.click(screen.getByRole("button", { name: /新建项目/ }));
    await user.type(
      screen.getByLabelText("描述项目目标"),
      "训练并评估一个模型",
    );
    await user.click(screen.getByRole("button", { name: /创建项目/ }));
    expect(await screen.findByText("模型服务暂不可用，请重试")).toBeVisible();
    expect(window.location.hash).toBe("#/projects/new-project/conversation");
    expect(screen.getByLabelText("讨论当前项目")).toHaveValue(
      "训练并评估一个模型",
    );
    const creation = mocked.mock.calls.find(
      ([p, o]) => p === "/workspaces" && o?.method === "POST",
    );
    expect(JSON.parse(creation![1]!.body as string).goal).toBe(
      "训练并评估一个模型",
    );
    expect(
      mocked.mock.calls.some(
        ([p, o]) => p.endsWith("/snapshots") && o?.method === "POST",
      ),
    ).toBe(false);
  });
});
