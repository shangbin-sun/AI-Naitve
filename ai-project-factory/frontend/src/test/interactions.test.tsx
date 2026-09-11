import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import Factory, { EmployeeEditor, ProjectDetails } from "../App";
import { api, ApiError } from "../api";
import type { Employee, Draft, Design } from "../types";
vi.mock("../api", async (importOriginal) => ({ ...await importOriginal<typeof import("../api")>(), api: vi.fn() }));
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
  mocked.mockImplementation(async (path, _options) => {
    if (path === "/workspaces") return [design];
    if (path === "/employees") return [employee];
    if (path === "/employees/employee-1") return employee;
    if (path === "/snapshots")
      return [
        {
          id: "project-1",
          design_id: "design-1",
          title: "AI 团队快照",
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
        title: "AI 团队快照",
        design_version: 1,
        snapshot: { team: draft, employees: [employee] },
      };
    throw new Error("未预期请求 " + path);
  });
  mount(<Factory />);
  return userEvent.setup();
}
describe("工作台入口", () => {
  it("已删除团队地址返回首页并清除引用，空侧栏不显示占位文字", async () => {
    window.location.hash = "#/projects/deleted/conversation";
    localStorage.setItem("factory.design", "deleted");
    mocked.mockImplementation(async (path) => {
      if (path === "/workspaces/deleted") throw new ApiError("团队不存在", 404);
      if (path === "/runtime") return { logged_in: true };
      return [];
    });
    mount(<Factory />);
    await waitFor(() => expect(window.location.hash).toBe("#/projects"));
    expect(localStorage.getItem("factory.design")).toBeNull();
    expect(screen.queryByText("团队不存在")).toBeNull();
    expect(screen.queryByText("还没有 AI 团队")).toBeNull();
    expect(screen.getByRole("button", { name: "新建AI团队" })).toBeEnabled();
  });
  it("新建团队必须输入名称，取消不会创建", async () => {
    const user = factory();
    await user.click(screen.getByRole("button", { name: "新建AI团队" }));
    expect(screen.getByRole("button", { name: "创建团队" })).toBeDisabled();
    await user.type(screen.getByLabelText("AI团队名称"), "   ");
    expect(screen.getByRole("button", { name: "创建团队" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(mocked.mock.calls.some(([p,o])=>p==="/workspaces"&&o?.method==="POST")).toBe(false);
  });
  it("工作流入口打开预选范围的任务启动半窗", async () => {
    const user = factory();
    await user.click(await screen.findByRole("button", {name:"查看 AI 团队 交互测试团队"}));
    await user.click(screen.getByRole("tab", {name:"团队"}));
    await user.click(screen.getByRole("button", {name:/执行团队/}));
    expect(await screen.findByLabelText("任务输入")).toBeVisible();
    expect(screen.getByText("团队执行")).toBeVisible();
    await user.click(screen.getByRole("button", {name:"关闭"}));
    await user.click(screen.getByRole("tab", {name:"团队"}));
    await user.click(screen.getByRole("button", {name:"单独执行 测试分析员"}));
    expect(await screen.findByLabelText("任务输入")).toBeVisible();
    expect(screen.getByText("单员工执行")).toBeVisible();
    await user.click(screen.getByRole("button", {name:"关闭"}));
    await user.click(screen.getByRole("tab", {name:"团队"}));
    await user.click(screen.getByRole("tab", {name:"任务与运行"}));
    expect(screen.queryByLabelText("任务输入")).toBeNull();
  });
  it("团队标签、任务入口、历史打开关闭", async () => {
    const user = factory();
    await user.click(
      await screen.findByRole("button", { name: "查看 AI 团队 交互测试团队" }),
    );
    await user.click(await screen.findByRole("tab", { name: "团队" }));
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
    expect(await screen.findByRole("button", { name: /新建任务/ })).toBeVisible();
    const tabs = screen.getAllByRole("tab").map(t => t.textContent);
    expect(tabs.slice(0,4)).toEqual(["对话","团队","任务与运行","看板"]);
    expect(screen.queryByRole("tab", {name:"概览"})).toBeNull();
    expect(screen.queryByRole("tab", {name:"版本记录"})).toBeNull();
    expect(screen.queryByRole("tab", {name:"资料与评估"})).toBeNull();
  });
  it("员工库返回团队默认进入对话", async () => {
    const user = factory();
    await user.click(screen.getByRole("button", { name: /^robot 员工$/ }));
    await user.click(await screen.findByRole("button", { name: /测试分析员/ }));
    expect(await screen.findByLabelText("员工名称")).toHaveValue(member.name);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("link", { name: "返回团队首页" }));
    await user.click(
      await screen.findByRole("button", { name: "查看 AI 团队 交互测试团队" }),
    );
    expect(await screen.findByLabelText("讨论当前AI 团队")).toBeVisible();
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
      await screen.findByRole("button", { name: "查看 AI 团队 交互测试团队" }),
    );
    await user.click(await screen.findByRole("tab", { name: "团队" }));
    await user.click(screen.getByRole("tab", { name: "对话" }));
    await user.type(
      await screen.findByLabelText("讨论当前AI 团队"),
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

});

describe("AI 团队内员工详情", () => {
  const project = {
    id: "project-1",
    design_id: "design-1",
    title: "AI 团队快照",
    status: "draft",
    design_version: 1,
    created_at: "2026-09-07",
    snapshot: { team: draft, employees: [employee] },
  };
  it("AI 团队成员可打开，完整指令与版本可见，文件只读且下载对应快照", async () => {
    const user = userEvent.setup();
    mount(<ProjectDetails project={project} onEditTeam={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: /测试分析员.*查看详情/ }),
    );
    expect(await screen.findByText(member.instructions)).toBeVisible();
    expect(
      screen.getByText(/AI 团队快照 · 团队修订 1 · 员工版本 1/),
    ).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "AI 团队工程文件" }));
    const file = screen.getByLabelText("AI 团队快照文件内容");
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
      within(detail).getByRole("button", { name: /返回当前AI 团队方案/ }),
    );
    expect(onEdit).toHaveBeenCalledOnce();
  });

});

describe("整页导航", () => {
  it("员工编辑整页切换导航时保护未保存修改", async () => {
    const user = factory();
    await user.click(screen.getByRole("button", { name: /^robot 员工$/ }));
    await user.click(await screen.findByRole("button", { name: /测试分析员/ }));
    await user.type(screen.getByLabelText("员工名称"), "未保存");
    await user.click(screen.getByRole("link", { name: "返回团队首页" }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("员工名称")).toHaveValue("测试分析员未保存");
    await user.click(screen.getByRole("link", { name: "返回团队首页" }));
    await user.click(await screen.findByRole("button", { name: "丢弃并切换" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("员工名称")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: `查看 AI 团队 ${design.title}` }),
    ).toBeVisible();
  });
});

describe("AI 团队中心主流程", () => {
  it("只有AI 团队和员工两个主入口，AI 团队默认展示持续AI 团队而非快照", async () => {
    factory();
    expect(
      screen.getByRole("link", { name: "返回团队首页" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "查看 AI 团队 交互测试团队" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /AI 团队快照/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^robot 员工$/ })).toHaveClass(
      "secondary-nav",
    );
  });
  it("直接链接恢复AI 团队方案和员工详情，返回仍然在本AI 团队", async () => {
    window.history.replaceState(
      null,
      "",
      "#/projects/design-1/plan?employee=employee-1",
    );
    const user = factory();
    expect(await screen.findByLabelText("员工名称")).toHaveValue(member.name);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(window.location.hash).toBe("#/projects/design-1/plan");
    expect(screen.getByRole("tab", { name: "团队" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /测试分析员.*查看详情/ }),
    ).toBeVisible();
  });
  it("浏览器返回会恢复AI 团队标签", async () => {
    const user = factory();
    await user.click(
      await screen.findByRole("button", { name: "查看 AI 团队 交互测试团队" }),
    );
    await user.click(await screen.findByRole("tab", { name: "团队" }));
    await user.click(screen.getByRole("tab", { name: "对话" }));
    window.history.back();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "团队" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(window.location.hash).toBe("#/projects/design-1/plan");
  });
  it("首次生成失败仍保留已创建AI 团队、目标和输入，不会创建快照", async () => {
    const user = factory();
    const fallback = mocked.getMockImplementation()!;
    const created = {
      ...design,
      id: "new-project",
      title: "新AI 团队",
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
    await user.click(screen.getByRole("button", { name: "新建AI团队" }));
    await user.type(screen.getByLabelText("AI团队名称"), "研发团队");
    await user.click(screen.getByRole("button", { name: "创建团队" }));
    await user.type(await screen.findByLabelText("讨论当前AI 团队"), "训练并评估一个模型");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("模型服务暂不可用，请重试")).toBeVisible();
    expect(window.location.hash).toBe("#/projects/new-project/conversation");
    expect(screen.getByLabelText("讨论当前AI 团队")).toHaveValue(
      "训练并评估一个模型",
    );
    const creation = mocked.mock.calls.find(
      ([p, o]) => p === "/workspaces" && o?.method === "POST",
    );
    expect(JSON.parse(creation![1]!.body as string).title).toBe(
      "研发团队",
    );
    expect(
      mocked.mock.calls.some(
        ([p, o]) => p.endsWith("/snapshots") && o?.method === "POST",
      ),
    ).toBe(false);
  });
});


it("侧栏直接进入具体 AI Team 的对话", async () => {
  const user = factory();
  await user.click(await screen.findByRole("button", { name: "进入 AI 团队 交互测试团队" }));
  expect(await screen.findByLabelText("讨论当前AI 团队")).toBeVisible();
  expect(window.location.hash).toContain("projects/design-1/conversation");
});

it("员工对话显示在团队下，关闭只隐藏入口并保留服务端记录", async () => {
  localStorage.setItem("employee-conversations",JSON.stringify([{projectId:design.id,runId:"run-one",nodeKey:"work",name:"测试分析员"}]));
  window.history.replaceState(null,"","#/projects/design-1/conversation?tuning=run-one%3Awork");
  mocked.mockImplementation(async path=>{
    if(path==="/workspaces")return [design];
    if(path==="/employees")return [employee];
    if(path==="/workspaces/design-1")return design;
    if(path.endsWith("/tuning"))return {status:"completed",messages:[{role:"assistant",content:"已保留调优记录"}],read_only:false,can_start:true};
    if(path.endsWith("/definition"))return {draft,employees:[employee],sources:[],attachments:[]};
    if(path.endsWith("/agent-runs")||path.endsWith("/tasks"))return [];
    return {};
  });
  mount(<Factory/>);
  expect(await screen.findByRole("button",{name:"关闭测试分析员对话"})).toBeInTheDocument();
  expect(await screen.findByText("已保留调优记录")).toBeVisible();
  expect(screen.getByRole("button",{name:"添加附件"})).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button",{name:"关闭对话"}));
  expect(screen.queryByRole("button",{name:"关闭测试分析员对话"})).toBeNull();
  expect(JSON.parse(localStorage.getItem("employee-conversations")!)).toEqual([]);
  expect(mocked.mock.calls.some(([,options])=>options?.method==="DELETE"||options?.method==="POST")).toBe(false);
});

it("从员工对话点击团队名称回到原团队标签", async () => {
  localStorage.setItem("employee-conversations",JSON.stringify([{projectId:design.id,runId:"run-one",nodeKey:"work",name:"测试分析员"}]));
  window.history.replaceState(null,"","#/projects/design-1/plan");
  mocked.mockImplementation(async path=>{
    if(path==="/workspaces")return [design];
    if(path==="/employees")return [employee];
    if(path==="/workspaces/design-1")return design;
    if(path.endsWith("/tuning"))return {status:"idle",messages:[],read_only:false,can_start:true};
    return {};
  });
  mount(<Factory/>);
  await screen.findByRole("tab",{name:"团队",selected:true});
  const sidebar=screen.getByRole("region",{name:"AI 团队列表"});
  await userEvent.click(within(sidebar).getByRole("button",{name:"robot 测试分析员"}));
  await screen.findByRole("button",{name:"关闭对话"});
  await userEvent.click(screen.getByRole("button",{name:"进入 AI 团队 交互测试团队"}));
  expect(await screen.findByRole("tab",{name:"团队",selected:true})).toBeVisible();
  expect(screen.queryByRole("button",{name:"关闭对话"})).toBeNull();
});
