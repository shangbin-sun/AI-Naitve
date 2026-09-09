import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Empty,
  Input,
  Select,
  Spin,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckOutlined,
  CodeOutlined,
  DownloadOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  HistoryOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  ProjectOutlined,
  RobotOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
const TasksPanel = lazy(() => import("./tasks/TasksPanel"));
const ProjectChat = lazy(() => import("./chat/ProjectChat"));
import { api } from "./api";
import WorkspacePage from "./WorkspacePage";
import EvidencePanel from "./EvidencePanel";
import type {
  Design,
  Draft,
  Employee,
  Member,
  Project,
  Runtime,
} from "./types";

type View = "design" | "employees" | "projects";
type ProjectTab =
  "overview" | "conversation" | "plan" | "history" | "evidence" | "tasks";
function readRoute() {
  const [path, query] = window.location.hash.slice(1).split("?");
  const employee = new URLSearchParams(query).get("employee");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "employees")
    return {
      view: "employees" as View,
      id: null,
      tab: "overview" as ProjectTab,
      employee,
    };
  if (parts[0] === "projects" && parts[1])
    return {
      view: "design" as View,
      id: parts[1] === "new" ? null : parts[1],
      employee,
      tab: ([
        "overview",
        "conversation",
        "plan",
        "history",
        "tasks",
        "evidence",
      ].includes(parts[2])
        ? parts[2]
        : "overview") as ProjectTab,
    };
  return {
    view: "projects" as View,
    id: null,
    tab: "overview" as ProjectTab,
    employee: null,
  };
}
const examples = [
  {
    title: "数据分析团队",
    icon: "↗",
    text: "帮我设计一个数据分析团队：分析每月销售数据，找出增长和下滑原因，输出报告，由我确认最终结论。",
  },
  {
    title: "模型实验团队",
    icon: "◈",
    text: "设计一个模型实验团队，负责数据准备、训练实验和独立评估。训练使用外部 GPU 服务，增加算力前由我确认。",
  },
  {
    title: "研究与内容团队",
    icon: "✳",
    text: "我想建立一个研究与内容团队，先调研并核实来源，再写报告，由复核员工检查，最后交给人验收。",
  },
];

export default function FactoryApp() {
  const { message, modal } = AntApp.useApp();
  const [view, setView] = useState<View>(() => readRoute().view);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [active, setActive] = useState<string | null>(readRoute().id);
  const [projectTab, setProjectTab] = useState<ProjectTab>(
    () => readRoute().tab,
  );
  const [search, setSearch] = useState("");
  const [design, setDesign] = useState<Design | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [editor, setEditor] = useState<Employee | null>(null);
  const [employeeRouteId, setEmployeeRouteId] = useState(readRoute().employee);
  const [raw, setRaw] = useState<string | null>(null);
  const [rawVersion, setRawVersion] = useState(0);
  const [history, setHistory] = useState<
    | { version: number; source: string; created_at: string; draft: Draft }[]
    | null
  >(null);
  const [project, setProject] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const requestRef = useRef<{
    id: string;
    content: string;
    designId: string;
  } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const job = design?.jobs?.[0];
  const busy = sending || (!!job && ["queued", "running"].includes(job.status));

  const refreshLists = useCallback(async () => {
    const [d, e, p] = await Promise.all([
      api<Design[]>("/workspaces"),
      api<Employee[]>("/employees"),
      api<Project[]>("/snapshots"),
    ]);
    setDesigns(d);
    setEmployees(e);
    setProjects(p);
  }, []);
  const refreshDesign = useCallback(async (id: string) => {
    const d = await api<Design>(`/workspaces/${id}`);
    if (activeRef.current === id) {setDesign(d); setSyncError("");}
  }, []);

  useEffect(() => {
    refreshLists().catch((e) => setError(e.message));
    api<Runtime>("/runtime")
      .then(setRuntime)
      .catch((e) => setError(e.message));
  }, [refreshLists]);
  useEffect(() => {
    setDesign(null);
    if (!active) {
      localStorage.removeItem("factory.design");
      return;
    }
    localStorage.setItem("factory.design", active);
    refreshDesign(active).catch((e) => setSyncError(e.message));
  }, [active, refreshDesign]);
  useEffect(() => {
    if (!active) return;
    const generating = !!job && ["queued", "running"].includes(job.status);
    let inFlight = false;
    const timer = window.setInterval(
      async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          await refreshDesign(active);
          if (generating) await refreshLists();
        } catch (e) {
          setSyncError((e as Error).message);
        } finally {
          inFlight = false;
        }
      },
      generating ? 1500 : 6000,
    );
    return () => clearInterval(timer);
  }, [active, job?.status, refreshDesign, refreshLists]);
  async function send(
    value = text,
    attachmentIds: string[] = [],
  ): Promise<boolean> {
    if ((!value.trim() && !attachmentIds.length) || busy) return false;
    setSending(true);
    setError("");
    let id = active;
    let accepted = false;
    try {
      let version = design?.version ?? 0;
      if (!id) {
        const created = await api<Design>("/workspaces", {
          method: "POST",
          body: JSON.stringify({ title: value.slice(0, 24), goal: value }),
        });
        id = created.id;
        version = created.version;
        activeRef.current = id;
        navigate("design", id, "conversation");
        setDesign(created);
        await refreshLists();
      }
      if (
        !requestRef.current ||
        requestRef.current.content !== JSON.stringify([value, attachmentIds]) ||
        requestRef.current.designId !== id
      )
        requestRef.current = {
          id: crypto.randomUUID(),
          content: JSON.stringify([value, attachmentIds]),
          designId: id,
        };
      await api(`/workspaces/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: value,
          attachment_ids: attachmentIds,
          request_id: requestRef.current.id,
          expected_version: version,
        }),
      });
      accepted = true;
      requestRef.current = null;
      setText("");
      await refreshDesign(id);
      await refreshLists();
      return true;
    } catch (e) {
      setError((e as Error).message);
      if (id) await refreshDesign(id).catch(() => undefined);
      return accepted;
    } finally {
      setSending(false);
    }
  }

  async function createProject() {
    if (!design || creating) return;
    setCreating(true);
    try {
      const p = await api<Project>(`/workspaces/${design.id}/snapshots`, {
        method: "POST",
        body: JSON.stringify({ expected_version: design.version }),
      });
      await refreshLists();
      setProject(p);
      message.success("方案快照已保存，可在本项目历史中查看");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const editorDirty = useRef(false);
  const routeRef = useRef(window.location.hash || "#/projects");
  const scrollPositions = useRef(new Map<string, number>());
  function navigate(
    nextView: View,
    id: string | null,
    tab: ProjectTab = "overview",
    replace = false,
    employeeId: string | null = null,
  ) {
    scrollPositions.current.set(routeRef.current, window.scrollY);
    const base =
      nextView === "employees"
        ? "#/employees"
        : nextView === "projects"
          ? "#/projects"
          : `#/projects/${id || "new"}/${tab}`;
    const hash =
      base + (employeeId ? `?employee=${encodeURIComponent(employeeId)}` : "");
    if (hash !== window.location.hash)
      window.history[replace ? "replaceState" : "pushState"](null, "", hash);
    routeRef.current = hash;
    setView(nextView);
    setActive(id);
    setProjectTab(tab);
    setEmployeeRouteId(employeeId);
    if (activeRef.current !== id) {
      setText("");
      setError("");
    }
    activeRef.current = id;
  }
  function askProject(value: string) {
    navigate("design", active, "conversation");
    setText(value);
  }
  function openEditor(employee: Employee) {
    navigate(view, active, projectTab, false, employee.id);
    setEditor(employee);
  }
  function closeEditor() {
    setEditor(null);
    editorDirty.current = false;
    navigate(view, active, projectTab);
  }
  useEffect(() => {
    if (!employeeRouteId || editor?.id === employeeRouteId) return;
    let cancelled = false;
    api<Employee>(`/employees/${employeeRouteId}`)
      .then((employee) => {
        if (cancelled) return;
        if (view === "design" && employee.design_id !== active)
          throw new Error("此员工不属于当前项目");
        setEditor(employee);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [employeeRouteId, active, view, editor?.id]);
  useEffect(() => {
    if (!window.location.hash)
      window.history.replaceState(null, "", "#/projects");
    const onBack = () => {
      const target = readRoute();
      const proceed = () => {
        setEditor(null);
        setRaw(null);
        setHistory(null);
        setProject(null);
        editorDirty.current = false;
        navigate(target.view, target.id, target.tab, true, target.employee);
      };
      if (
        editorDirty.current ||
        (raw !== null && raw !== JSON.stringify(design?.draft, null, 2))
      ) {
        window.history.replaceState(null, "", routeRef.current);
        modal.confirm({
          title: "有尚未保存的修改",
          content: "离开页面会丢弃本次修改。",
          okText: "丢弃并切换",
          cancelText: "继续编辑",
          onOk: proceed,
        });
      } else proceed();
    };
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, [raw, design?.draft]);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      window.scrollTo(0, scrollPositions.current.get(routeRef.current) || 0),
    );
    return () => cancelAnimationFrame(frame);
  }, [view, active, projectTab, !!design]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        editorDirty.current ||
        (raw !== null && raw !== JSON.stringify(design?.draft, null, 2))
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [raw, design?.draft]);
  const navigationBypass = useRef(false);
  function navigateFromPage(event: React.MouseEvent<HTMLElement>) {
    if (
      navigationBypass.current ||
      (!editor && !project && history === null && raw === null)
    )
      return;
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "button, a",
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const proceed = () => {
      setEditor(null);
      setProject(null);
      setHistory(null);
      setRaw(null);
      editorDirty.current = false;
      navigationBypass.current = true;
      target.click();
      navigationBypass.current = false;
    };
    if (
      (editor && editorDirty.current) ||
      (raw !== null && raw !== JSON.stringify(design?.draft, null, 2))
    ) {
      modal.confirm({
        title: "有尚未保存的修改",
        content: "切换页面会丢弃本次修改。",
        okText: "丢弃并切换",
        cancelText: "继续编辑",
        onOk: proceed,
      });
    } else proceed();
  }

  const openEmployee = (member: Member) => {
    const e = design?.employees?.find((e) => e.key === member.key);
    if (e) openEditor(e);
    else if (member.kind === "human" && design) {
      setRaw(JSON.stringify(design.draft, null, 2));
      setRawVersion(design.version);
    } else
      message.info(
        member.kind === "human"
          ? "这是人类岗位，可通过聊天或编辑方案调整"
          : "员工工程将在团队方案就绪后自动创建",
      );
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" onClickCapture={navigateFromPage}>
        <a
          className="brand"
          onClick={() => {
            navigate("projects", null);
          }}
        >
          <span className="brand-mark">
            F<span>·</span>
          </span>
          <div>
            AI 项目工厂<small>PROJECT FACTORY</small>
          </div>
        </a>
        <div className="workspace-label">
          <span className="workspace-icon">B</span>
          <div>
            我的工作空间<small>本地开发版</small>
          </div>
          <span className="tiny-dot" />
        </div>
        <div className="nav-label">工作台</div>
        <nav>
          {(
            [
              ["projects", ProjectOutlined, "项目"],
              ["employees", RobotOutlined, "员工"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              className={`nav-item ${key === "employees" ? "secondary-nav" : ""} ${view === key || (view === "design" && key === "projects") ? "selected" : ""}`}
              onClick={() => navigate(key, null)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </nav>
        <div className="runtime-card">
          <span
            className={runtime?.logged_in ? "tiny-dot" : "tiny-dot offline"}
          />
          <div>
            Codex CLI
            <small>
              {runtime
                ? runtime.logged_in
                  ? "已连接 · 本机运行"
                  : "未登录或不可用"
                : "正在检查连接…"}
            </small>
          </div>
          <Tooltip title={runtime?.version || "连接状态"}>
            <CodeOutlined />
          </Tooltip>
        </div>
        <div className="sidebar-footer">
          <span className="user-avatar">我</span>
          <span>本地工作空间</span>
          <Tooltip title="当前版本仅监听本机，不提供多用户登录">
            <SettingOutlined />
          </Tooltip>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="breadcrumb">工作台</span>
            <span className="slash">/</span>
            {view === "employees" ? "员工" : "项目"}
            {view === "design" && (
              <>
                <span className="slash">/</span>
                {active ? design?.title || "正在加载" : "新建项目"}
              </>
            )}
          </div>
          <span className="local-badge">
            <span className="tiny-dot" /> LOCAL WORKSPACE{" "}
            <span className="version">v0.1</span>
          </span>
        </header>
        {(error || syncError) && (
          <Alert
            className="global-error"
            message={error || syncError}
            type="error"
            closable
            onClose={() => {setError(""); setSyncError("");}}
          />
        )}

        {view === "design" && (
          <>
            {!active ? (
              <div className="welcome">
                <div className="eyebrow">
                  <span />
                  从想法，到一起工作的团队
                </div>
                <h1>
                  你的下一个项目，
                  <br />
                  从一场对话开始<span>。</span>
                </h1>
                <p className="welcome-description">
                  说说你想完成什么。我们一起梳理角色、工作流程与交付目标，
                  <br className="desktop-break" />
                  创建项目，在同一个空间里完善团队与方案。
                </p>
                <div className="welcome-composer">
                  <Input.TextArea
                    aria-label="描述项目目标"
                    autoSize={{ minRows: 3, maxRows: 7 }}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="例如：我想建立一个模型实验团队，负责数据准备、训练和评估，关键决策由我确认…"
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-bottom">
                    <span>
                      <CodeOutlined />{" "}
                      {runtime?.logged_in
                        ? "Codex 已准备好与你一起设计"
                        : runtime
                          ? "请先在终端执行 codex login"
                          : "正在检查 Codex 连接…"}
                    </span>
                    <Button
                      type="primary"
                      loading={sending}
                      disabled={!text.trim()}
                      onClick={() => void send()}
                    >
                      创建项目 <ArrowRightOutlined />
                    </Button>
                  </div>
                </div>
                <div className="suggestion-label">也可以从这些场景开始</div>
                <div className="suggestions">
                  {examples.map((x) => (
                    <button key={x.title} onClick={() => setText(x.text)}>
                      <span className="suggestion-icon">{x.icon}</span>
                      <div>
                        <strong>{x.title}</strong>
                        <small>点击补充你的想法</small>
                      </div>
                      <ArrowRightOutlined />
                    </button>
                  ))}
                </div>
                <div className="how-it-works">
                  {[
                    "聊清目标与分工",
                    "在项目中完善方案",
                    "配置资源，准备执行",
                  ].map((t, i) => (
                    <div key={t}>
                      <span>0{i + 1}</span>
                      {t}
                    </div>
                  ))}
                </div>
              </div>
            ) : !design ? (
              <div className="loading">
                {error ? (
                  <>
                    <p>项目暂时无法打开，请重试或返回项目列表。</p>
                    <Button
                      onClick={() => {
                        setError("");
                        void refreshDesign(active).catch((e) =>
                          setError(e.message),
                        );
                      }}
                    >
                      重新加载
                    </Button>
                    <Button onClick={() => navigate("projects", null)}>
                      返回项目
                    </Button>
                  </>
                ) : (
                  <>
                    <Spin />
                    <p>正在打开项目…</p>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="design-heading">
                  <div>
                    <div className="eyebrow small">PROJECT WORKSPACE</div>
                    <h2>
                      {design.title}{" "}
                      <Tag
                        bordered={false}
                        color={design.draft.ready ? "green" : "default"}
                      >
                        {design.draft.ready ? "方案已形成" : "筹备中"}
                      </Tag>
                    </h2>
                  </div>
                  <div className="header-actions">
                    <Button
                      icon={<ArrowLeftOutlined />}
                      onClick={() => navigate("projects", null)}
                    >
                      所有项目
                    </Button>
                  </div>
                </div>
                <Tabs
                  className="project-tabs"
                  activeKey={projectTab}
                  onChange={(key) =>
                    navigate("design", active, key as ProjectTab)
                  }
                  items={[
                    { key: "overview", label: "概览" },
                    { key: "conversation", label: "对话" },
                    { key: "plan", label: "团队" },
                    { key: "tasks", label: "任务与运行" },
                    { key: "history", label: "版本记录" },
                    { key: "evidence", label: "资料与评估" },
                  ]}
                />
                {projectTab === "tasks" && (
                  <Suspense fallback={<Spin />}>
                    <TasksPanel
                      key={design.id}
                      projectId={design.id}
                      onSources={() =>
                        navigate("design", design.id, "evidence")
                      }
                    />
                  </Suspense>
                )}
                {projectTab === "evidence" && (
                  <EvidencePanel
                    key={design.id}
                    projectId={design.id}
                    version={design.version}
                    onImprove={askProject}
                  />
                )}
                {projectTab === "overview" && (
                  <section className="project-overview">
                    <div className="project-intro">
                      <span className="section-kicker">项目目标</span>
                      <h2>
                        {design.draft.goal || "通过对话补充你希望交付的成果"}
                      </h2>
                      <p>
                        对话、团队和工作流保存在这个项目中，修改后无需重新创建项目。
                      </p>
                      <Button
                        type="primary"
                        onClick={() =>
                          navigate("design", active, "conversation")
                        }
                      >
                        {design.draft.name ? "继续讨论项目" : "开始完善方案"}
                        <ArrowRightOutlined />
                      </Button>
                      {design.draft.name && (
                        <Button
                          onClick={() => navigate("design", active, "plan")}
                        >
                          查看与编辑方案
                        </Button>
                      )}
                    </div>
                    <div className="project-metrics">
                      <div>
                        <strong>{design.draft.members?.length || 0}</strong>
                        <span>团队岗位</span>
                      </div>
                      <div>
                        <strong>{design.draft.workflow?.length || 0}</strong>
                        <span>工作步骤</span>
                      </div>
                      <div>
                        <strong>
                          {(design.draft.questions?.length || 0) +
                            (design.draft.requirements?.length || 0)}
                        </strong>
                        <span>待澄清与依赖</span>
                      </div>
                    </div>
                    <div className="project-readiness">
                      <h3>下一步</h3>
                      <p>
                        {!design.draft.name
                          ? "描述目标，让项目助手生成需求、团队和工作流。"
                          : "检查团队职责、工作交接和验收条件，再补齐运行依赖。"}
                      </p>
                      {(design.draft.questions || []).map((q) => (
                        <Button
                          key={q}
                          onClick={() => askProject(q + "\n我的回答：")}
                        >
                          {q}
                          <ArrowRightOutlined />
                        </Button>
                      ))}
                      <Alert
                        type="info"
                        showIcon
                        message="当前可完成项目筹备与员工工程编辑"
                        description="资料与评估中可运行需求分析、基线测试及员工自动研发；完整工作流调度、端到端和部署执行仍待接入。"
                      />
                    </div>
                  </section>
                )}
                {projectTab === "history" && (
                  <section className="project-history">
                    <div className="project-history-heading">
                      <div>
                        <h3>方案版本与快照</h3>
                        <p>
                          快照固定保存当时的团队与员工工程，后续编辑不影响历史内容。
                        </p>
                      </div>
                      <Button
                        disabled={!design.draft.ready}
                        loading={creating}
                        onClick={() => void createProject()}
                      >
                        保存方案快照
                      </Button>
                    </div>
                    <Button
                      icon={<HistoryOutlined />}
                      onClick={() =>
                        api<typeof history>(
                          `/workspaces/${design.id}/revisions`,
                        )
                          .then(setHistory)
                          .catch((e) => message.error(e.message))
                      }
                    >
                      查看修订记录
                    </Button>
                    <div className="snapshot-list">
                      {projects.filter((p) => p.design_id === active).length ? (
                        projects
                          .filter((p) => p.design_id === active)
                          .map((p) => (
                            <button
                              className="snapshot-row"
                              key={p.id}
                              onClick={() => setProject(p)}
                            >
                              <div>
                                <strong>方案修订 {p.design_version}</strong>
                                <p>
                                  {p.title} ·{" "}
                                  {new Date(p.created_at).toLocaleString()}
                                </p>
                              </div>
                              <span>
                                查看快照 <ArrowRightOutlined />
                              </span>
                            </button>
                          ))
                      ) : (
                        <Empty description="尚无固定快照，项目修改会自动保留修订记录" />
                      )}
                    </div>
                  </section>
                )}
                <div
                  hidden={
                    projectTab !== "conversation" && projectTab !== "plan"
                  }
                  className={`studio project-studio ${projectTab === "conversation" || projectTab === "plan" ? "" : "is-hidden"}`}
                >
                  <section
                    hidden={projectTab !== "conversation"}
                    className={`chat-panel ${projectTab !== "conversation" ? "is-hidden" : ""}`}
                  >
                    <div className="panel-heading">
                      <span>
                        <span className="assistant-icon">✳</span> 项目助手
                      </span>
                      <div>
                        <small>对话自动保存</small>
                        {design.draft.name && (
                          <Button
                            type="link"
                            onClick={() => navigate("design", active, "plan")}
                          >
                            查看方案 <ArrowRightOutlined />
                          </Button>
                        )}
                      </div>
                    </div>
                    <Suspense fallback={<Spin tip="正在加载对话" />}>
                      <ProjectChat
                        key={design.id}
                        workspaceId={design.id}
                        draftText={text}
                        messages={design.messages ?? []}
                        busy={busy}
                        status={job?.logs?.at(-1)?.message}
                        failure={
                          job &&
                          !["running", "queued", "completed"].includes(
                            job.status,
                          )
                            ? job.error || "本轮已停止，可继续发送消息"
                            : undefined
                        }
                        canCancel={
                          !!job && ["queued", "running"].includes(job.status)
                        }
                        onSend={send}
                        onCancel={async () => {
                          if (!job) return;
                          await api(`/jobs/${job.id}/cancel`, {
                            method: "POST",
                          });
                          await refreshDesign(design.id);
                        }}
                        onBuild={async (goal) => {
                          setSending(true);
                          setError("");
                          try {
                            await api(
                              `/workspaces/${design.id}/delivery-runs`,
                              {
                                method: "POST",
                                body: JSON.stringify({
                                  goal,
                                  max_attempts: 2,
                                  offline: false,
                                }),
                              },
                            );
                            await refreshDesign(design.id);
                            navigate("design", design.id, "evidence");
                            return true;
                          } catch (e) {
                            setError((e as Error).message);
                            return false;
                          } finally {
                            setSending(false);
                          }
                        }}
                      />
                    </Suspense>
                  </section>
                  <section
                    hidden={projectTab !== "plan"}
                    className={`preview-panel ${projectTab !== "plan" ? "is-hidden" : ""}`}
                  >
                    <div className="panel-heading">
                      <span>项目方案 · 团队与工作流</span>
                      <div>
                        <small>修订 {design.version}</small>{" "}
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          disabled={!design.draft.name}
                          onClick={() => {
                            setRaw(JSON.stringify(design.draft, null, 2));
                            setRawVersion(design.version);
                          }}
                        >
                          编辑方案
                        </Button>
                      </div>
                    </div>
                    {!design.draft.name ? (
                      <div className="preview-empty">
                        <div className="empty-orbit">
                          <TeamOutlined />
                        </div>
                        <h3>团队正在构思中</h3>
                        <p>
                          聊清目标后，岗位、工作流和待完善事项
                          <br />
                          会自动出现在这里。
                        </p>
                      </div>
                    ) : (
                      <TeamPreview
                        draft={design.draft as Draft}
                        onEmployee={openEmployee}
                        onQuestion={askProject}
                      />
                    )}
                  </section>
                </div>
              </>
            )}
          </>
        )}

        {view === "employees" && (
          <section className="library">
            <div className="library-heading">
              <div className="eyebrow small">EMPLOYEE WORKSHOP</div>
              <h1>员工</h1>
              <p>集中完善员工指令与工程文件。日常团队协作请进入所属项目。</p>
            </div>
            {!employees.length ? (
              <Empty description="还没有员工工程">
                <Button
                  type="primary"
                  onClick={() => {
                    navigate("design", null, "conversation");
                  }}
                >
                  创建项目并生成员工
                </Button>
              </Empty>
            ) : (
              <div className="employee-grid">
                {employees.map((e) => (
                  <button
                    className="employee-card"
                    key={e.id}
                    onClick={() => openEditor(e)}
                  >
                    <div className="card-top">
                      <div className="member-avatar">
                        <RobotOutlined />
                      </div>
                      <Tag bordered={false}>工程草稿 · v{e.version}</Tag>
                    </div>
                    <h3>{e.profile.name}</h3>
                    <p>{e.profile.role}</p>
                    <span className="employee-project-label">
                      所属项目 ·{" "}
                      {designs.find((d) => d.id === e.design_id)?.title ||
                        "项目"}
                    </span>
                    <div className="skill-tags">
                      {e.profile.skills.slice(0, 3).map((s) => (
                        <Tag key={s}>{s}</Tag>
                      ))}
                    </div>
                    <div className="card-footer">
                      {Object.keys(e.files).length} 个工程文件{" "}
                      <span>
                        完善员工 <ArrowRightOutlined />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {view === "projects" && (
          <section className="library project-library">
            <div className="project-list-heading">
              <div className="library-heading">
                <div className="eyebrow small">YOUR PROJECTS</div>
                <h1>项目</h1>
                <p>从目标开始，让团队、方案与每一次迭代留在同一个项目里。</p>
              </div>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  setText("");
                  navigate("design", null, "conversation");
                }}
              >
                新建项目
              </Button>
            </div>
            <Input.Search
              className="project-search"
              placeholder="搜索项目名称或目标"
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {!designs.length ? (
              <Empty className="spaced" description="从第一个目标开始">
                <Button
                  onClick={() => navigate("design", null, "conversation")}
                >
                  创建第一个项目
                </Button>
              </Empty>
            ) : (
              <div className="employee-grid spaced">
                {designs
                  .filter((d) =>
                    `${d.title} ${d.draft.goal || ""}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((d) => (
                    <button
                      className="employee-card project-card"
                      key={d.id}
                      onClick={() => {
                        setText("");
                        navigate("design", d.id);
                      }}
                    >
                      <div className="card-top">
                        <ProjectOutlined className="project-icon" />
                        <Tag>{d.draft.ready ? "方案已形成" : "筹备中"}</Tag>
                      </div>
                      <h3>{d.title}</h3>
                      <p>{d.draft.goal || "进入项目，继续完善目标与团队"}</p>
                      <div className="card-footer">
                        {d.draft.members?.length || 0} 个岗位 ·{" "}
                        {d.draft.workflow?.length || 0} 项工作
                        <span>
                          打开项目 <ArrowRightOutlined />
                        </span>
                      </div>
                    </button>
                  ))}
              </div>
            )}
            {designs.length > 0 &&
              !designs.some((d) =>
                `${d.title} ${d.draft.goal || ""}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ) && <Empty className="spaced" description="没有匹配的项目" />}
          </section>
        )}
      </main>

      {editor && (
        <EmployeeEditor
          key={editor.id}
          employee={editor}
          projectTitle={designs.find((d) => d.id === editor.design_id)?.title}
          onDirtyChange={(dirty) => {
            editorDirty.current = dirty;
          }}
          onClose={closeEditor}
          onSave={async (e) => {
            setEditor(e);
            await refreshLists();
            if (active) await refreshDesign(active);
          }}
        />
      )}
      <WorkspacePage
        title="编辑项目方案"
        open={raw !== null}
        onCancel={() => setRaw(null)}
        okText="保存草稿"
        onOk={async () => {
          try {
            const payload = JSON.parse(raw!);
            await api(`/workspaces/${design!.id}/draft`, {
              method: "PUT",
              body: JSON.stringify({
                expected_version: rawVersion,
                draft: payload,
              }),
            });
            setRaw(null);
            await refreshDesign(design!.id);
            await refreshLists();
            message.success("方案已保存");
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        <p className="muted">
          修改会校验岗位、工作流依赖与版本。也可以直接在聊天中描述修改。
        </p>
        <Input.TextArea
          className="code-editor"
          rows={20}
          value={raw || ""}
          onChange={(e) => setRaw(e.target.value)}
        />
      </WorkspacePage>
      <WorkspacePage
        title="方案修订历史"
        open={history !== null}
        onClose={() => setHistory(null)}
      >
        {history?.length ? (
          history.map((r) => (
            <div className="revision" key={r.version}>
              <Tag>修订 {r.version}</Tag>
              <small>
                {r.source === "codex" ? "Codex 生成" : "手动修改"} ·{" "}
                {new Date(r.created_at).toLocaleString()}
              </small>
              <h3>{r.draft.name}</h3>
              <p>{r.draft.goal}</p>
              <span>
                {r.draft.members.length} 个岗位 · {r.draft.workflow.length}{" "}
                个节点
              </span>
            </div>
          ))
        ) : (
          <Empty description="尚无修订" />
        )}
      </WorkspacePage>
      <WorkspacePage
        title={project ? `${project.title} · 历史快照` : "历史快照"}
        open={!!project}
        onClose={() => setProject(null)}
      >
        {project && (
          <>
            <Alert
              type="success"
              showIcon
              message={`已保存团队修订 ${project.design_version} 的独立快照`}
              description="后续修改本项目的方案和员工，不会改变这个历史快照。"
            />
            <ProjectDetails
              project={project}
              onEditTeam={(question) => {
                setProject(null);
                navigate(
                  "design",
                  project.design_id,
                  question ? "conversation" : "plan",
                );
                setText(question ?? "");
              }}
            />
          </>
        )}
      </WorkspacePage>
    </div>
  );
}

export function ProjectDetails({
  project,
  onEditTeam,
}: {
  project: Project;
  onEditTeam: (question?: string) => void;
}) {
  const [member, setMember] = useState<Member | null>(null);
  const [selectedFile, setSelectedFile] = useState("instructions/role.md");
  const saved = project.snapshot.employees.find(
    (e) => e.profile.key === member?.key,
  );
  return (
    <>
      <div className="project-next-step">
        <p>这是本项目的历史方案。点击岗位查看当时的职责、指令与工程文件。</p>
        <Button icon={<EditOutlined />} onClick={() => onEditTeam()}>
          返回当前项目方案
        </Button>
      </div>
      <TeamPreview
        draft={project.snapshot.team}
        onEmployee={(m) => {
          setMember(m);
          setSelectedFile("instructions/role.md");
        }}
        onQuestion={(q) => onEditTeam(q)}
      />
      <WorkspacePage
        title={member ? `${member.name} · 项目内详情` : "员工详情"}
        open={!!member}
        onClose={() => setMember(null)}
        destroyOnHidden
      >
        {member && (
          <>
            <Alert
              type="info"
              showIcon
              message={`项目快照 · 团队修订 ${project.design_version}${saved ? ` · 员工版本 ${saved.version}` : " · 人类岗位"}`}
              description="这里展示保存快照时的内容。编辑当前项目不会改变此历史版本。"
            />
            <Tabs
              items={[
                {
                  key: "role",
                  label: "职责与指令",
                  children: (
                    <div className="snapshot-profile">
                      <h3>{member.role}</h3>
                      <h4>职责</h4>
                      <ul>
                        {member.responsibilities.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                      <h4>工作输入</h4>
                      <ul>
                        {member.inputs.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                      <h4>交付成果</h4>
                      <ul>
                        {member.outputs.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                      <h4>技能需求</h4>
                      <p>{member.skills.join("、") || "未声明"}</p>
                      <h4>工作指令</h4>
                      <div className="snapshot-instructions">
                        {member.instructions || "未填写"}
                      </div>
                    </div>
                  ),
                },
                ...(saved
                  ? [
                      {
                        key: "files",
                        label: "项目工程文件",
                        children: (
                          <>
                            <Button
                              icon={<DownloadOutlined />}
                              href={`/api/projects/${project.id}/employees/${saved.id}/export`}
                            >
                              下载此版本工程
                            </Button>
                            <div className="file-editor spaced">
                              <div className="file-list">
                                {Object.keys(saved.files).map((file) => (
                                  <button
                                    key={file}
                                    className={
                                      selectedFile === file ? "active" : ""
                                    }
                                    onClick={() => setSelectedFile(file)}
                                  >
                                    {file}
                                  </button>
                                ))}
                              </div>
                              <div className="file-content">
                                <div className="file-path">{selectedFile}</div>
                                <Input.TextArea
                                  aria-label="项目快照文件内容"
                                  className="code-editor"
                                  rows={18}
                                  readOnly
                                  value={saved.files[selectedFile] ?? ""}
                                />
                              </div>
                            </div>
                          </>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            <Button
              type="primary"
              icon={<EditOutlined />}
              onClick={() => onEditTeam()}
            >
              返回当前项目方案
            </Button>
          </>
        )}
      </WorkspacePage>
    </>
  );
}

function TeamPreview({
  draft,
  onEmployee,
  onQuestion,
}: {
  draft: Draft;
  onEmployee?: (m: Member) => void;
  onQuestion?: (q: string) => void;
}) {
  const MemberCard = onEmployee ? "button" : "div";
  return (
    <div className="team-preview">
      <div className="goal-card">
        <span className="section-kicker">项目目标</span>
        <h3>{draft.name}</h3>
        <p>{draft.goal}</p>
      </div>
      <Tabs
        items={[
          {
            key: "team",
            label: (
              <span>
                <TeamOutlined /> 团队{" "}
                <span className="count">{draft.members.length}</span>
              </span>
            ),
            children: (
              <div className="members">
                {draft.members.map((m, i) => (
                  <MemberCard
                    className="member-row"
                    key={m.key}
                    onClick={onEmployee ? () => onEmployee(m) : undefined}
                  >
                    <div
                      className={`member-avatar ${m.kind === "human" ? "human-avatar" : ""}`}
                    >
                      {m.kind === "human" ? (
                        <UserOutlined />
                      ) : (
                        <RobotOutlined />
                      )}
                    </div>
                    <div className="member-content">
                      <div>
                        <strong>{m.name}</strong>
                        <Tag
                          bordered={false}
                          color={m.kind === "human" ? "gold" : "blue"}
                        >
                          {m.kind === "human" ? "人类" : "AI 员工"}
                        </Tag>
                      </div>
                      <p>{m.role}</p>
                      <ul>
                        {m.responsibilities.slice(0, 3).map((r, k) => (
                          <li key={k}>{r}</li>
                        ))}
                      </ul>
                    </div>
                    <span className="member-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </MemberCard>
                ))}
              </div>
            ),
          },
          {
            key: "workflow",
            label: (
              <span>
                <NodeIndexOutlined /> 工作流{" "}
                <span className="count">{draft.workflow.length}</span>
              </span>
            ),
            children: (
              <div className="flow-list">
                {draft.workflow.map((s, i) => (
                  <div className="flow-step" key={s.key}>
                    <div className="step-number">{i + 1}</div>
                    <div className="step-body">
                      <div>
                        <strong>{s.name}</strong>
                        <Tag>
                          {s.kind === "approval"
                            ? "人工决策"
                            : s.kind === "review"
                              ? "评审检查"
                              : "执行工作"}
                        </Tag>
                      </div>
                      <p className="step-owner">
                        {onEmployee ? (
                          <Button
                            type="link"
                            size="small"
                            onClick={() => {
                              const owner = draft.members.find(
                                (m) => m.key === s.owner,
                              );
                              if (owner) onEmployee(owner);
                            }}
                          >
                            查看负责人：
                            {draft.members.find((m) => m.key === s.owner)?.name}
                          </Button>
                        ) : (
                          draft.members.find((m) => m.key === s.owner)?.name
                        )}
                      </p>
                      {s.depends_on.length > 0 && (
                        <p className="dependency">
                          等待：
                          {s.depends_on
                            .map(
                              (k) =>
                                draft.workflow.find((x) => x.key === k)?.name ||
                                k,
                            )
                            .join("、")}
                        </p>
                      )}
                      <dl>
                        <dt>输入</dt>
                        <dd>{s.input}</dd>
                        <dt>交付</dt>
                        <dd>{s.output}</dd>
                        <dt>验收</dt>
                        <dd>{s.acceptance}</dd>
                      </dl>
                    </div>
                  </div>
                ))}
              </div>
            ),
          },
          {
            key: "requirements",
            label: (
              <span>
                <ExperimentOutlined /> 待完善{" "}
                <span className="count">{draft.requirements.length}</span>
              </span>
            ),
            children: (
              <div>
                {draft.requirements.length ? (
                  draft.requirements.map((r, i) => (
                    <div className="requirement" key={i}>
                      <Badge status={r.blocking ? "warning" : "default"} />
                      <div>
                        <strong>{r.name}</strong>
                        <p>{r.description}</p>
                        <small>
                          {r.blocking ? "正式运行前需要补齐" : "可以后续完善"}
                        </small>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty
                    description="暂无额外资源声明；员工仍需评测后使用"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                )}
                <Alert
                  type="info"
                  message="保存草稿不会自动安装工具、绑定凭据或启动外部任务。"
                />
              </div>
            ),
          },
        ]}
      />
      {draft.questions.length > 0 && (
        <div className="questions">
          <span className="section-kicker">还想和你确认</span>
          {draft.questions.map((q, i) =>
            onQuestion ? (
              <button key={i} onClick={() => onQuestion(`${q}\n我的回答：`)}>
                {q}
                <ArrowRightOutlined />
              </button>
            ) : (
              <p className="snapshot-question" key={i}>
                {q}
              </p>
            ),
          )}
        </div>
      )}
      {draft.assumptions.length > 0 && (
        <div className="assumptions">
          <span className="section-kicker">当前假设</span>
          {draft.assumptions.map((s, i) => (
            <p key={i}>• {s}</p>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmployeeEditor({
  employee,
  projectTitle,
  onClose,
  onSave,
  onDirtyChange,
}: {
  employee: Employee;
  projectTitle?: string;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
  onSave: (e: Employee) => Promise<void>;
}) {
  const { message, modal } = AntApp.useApp();
  const [profile, setProfile] = useState(employee.profile);
  const [files, setFiles] = useState(employee.files);
  const [selected, setSelected] = useState("instructions/role.md");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("profile");
  const [filename, setFilename] = useState("");
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState(employee.version);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  function patch(fields: Partial<Member>) {
    setProfile((p) => ({ ...p, ...fields }));
    setDirty(true);
  }
  function close() {
    if (dirty)
      modal.confirm({
        title: "有尚未保存的修改",
        content: "关闭后会丢弃这些修改。",
        okText: "丢弃并关闭",
        cancelText: "继续编辑",
        onOk: onClose,
      });
    else onClose();
  }
  async function save() {
    setSaving(true);
    try {
      const e = await api<Employee>(`/employees/${employee.id}`, {
        method: "PUT",
        body: JSON.stringify({ expected_version: version, profile, files }),
      });
      setVersion(e.version);
      setFiles(e.files);
      setDirty(false);
      await onSave(e);
      message.success("员工工程已保存，团队方案已同步");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <WorkspacePage
      title={
        <span>
          <RobotOutlined /> {profile.name} <Tag>工程草稿 v{version}</Tag>
        </span>
      }
      open
      onClose={close}
      extra={
        <Button
          type="primary"
          icon={<CheckOutlined />}
          loading={saving}
          disabled={!dirty}
          onClick={() => void save()}
        >
          保存修改
        </Button>
      }
    >
      <div className="editor-notice">
        <CodeOutlined />
        <span>
          {projectTitle ? `所属项目：${projectTitle} · ` : ""}
          保存后更新本项目方案，历史快照保持原版本
        </span>
      </div>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "profile",
            label: "岗位与能力",
            children: (
              <div className="profile-form">
                <label>
                  员工名称
                  <Input
                    value={profile.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </label>
                <label>
                  岗位说明
                  <Input
                    value={profile.role}
                    onChange={(e) => patch({ role: e.target.value })}
                  />
                </label>
                {(
                  ["responsibilities", "skills", "inputs", "outputs"] as const
                ).map((k, i) => (
                  <label key={k}>
                    {
                      [
                        "职责（每行一项）",
                        "技能需求（每行一项）",
                        "工作输入（每行一项）",
                        "交付成果（每行一项）",
                      ][i]
                    }
                    <Input.TextArea
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      value={profile[k].join("\n")}
                      onChange={(e) =>
                        patch({ [k]: e.target.value.split("\n") })
                      }
                    />
                  </label>
                ))}
                <label>
                  员工工作指令
                  <Input.TextArea
                    rows={10}
                    value={profile.instructions}
                    onChange={(e) => patch({ instructions: e.target.value })}
                  />
                </label>
              </div>
            ),
          },
          {
            key: "files",
            label: (
              <span>
                <FileTextOutlined /> 工程文件
              </span>
            ),
            children: (
              <>
                <div className="file-toolbar">
                  <Input
                    placeholder="新增文件，例如 src/analyze.py"
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                  />
                  <Button
                    icon={<PlusOutlined />}
                    onClick={() => {
                      if (
                        !filename.trim() ||
                        files[filename.trim()] !== undefined ||
                        filename.trim() === "employee.json" ||
                        filename.includes("\\") ||
                        filename
                          .trim()
                          .split("/")
                          .some((part) => !part || part.startsWith("."))
                      ) {
                        message.warning(
                          "请输入有效且未使用的相对路径，不能使用隐藏目录、上级目录或 employee.json",
                        );
                        return;
                      }
                      setFiles({ ...files, [filename.trim()]: "" });
                      setSelected(filename.trim());
                      setFilename("");
                      setDirty(true);
                    }}
                  >
                    新增
                  </Button>
                  <Tooltip
                    title={
                      dirty
                        ? "请先保存修改，再下载最新工程"
                        : "下载已保存的员工工程"
                    }
                  >
                    <Button
                      disabled={dirty}
                      icon={<DownloadOutlined />}
                      href={`/api/employees/${employee.id}/export`}
                    >
                      导出
                    </Button>
                  </Tooltip>
                </div>
                <div className="file-editor">
                  <div className="file-list">
                    {Object.keys(files).map((f) => (
                      <button
                        key={f}
                        className={selected === f ? "active" : ""}
                        onClick={() => setSelected(f)}
                      >
                        <FileTextOutlined />
                        {f}
                      </button>
                    ))}
                  </div>
                  <div className="file-content">
                    <div className="file-path">{selected}</div>
                    <Input.TextArea
                      aria-label="工程文件内容"
                      className="code-editor"
                      rows={22}
                      value={
                        selected === "instructions/role.md"
                          ? profile.instructions
                          : files[selected] || ""
                      }
                      onChange={(e) => {
                        if (selected === "instructions/role.md")
                          patch({ instructions: e.target.value });
                        else {
                          setFiles({ ...files, [selected]: e.target.value });
                          setDirty(true);
                        }
                      }}
                    />
                  </div>
                </div>
              </>
            ),
          },
          {
            key: "evaluation",
            label: "评测要求",
            children: (
              <>
                <Alert
                  showIcon
                  type="info"
                  message="当前版本支持定义评测样例；自动试运行与正式发布尚未实现。"
                />
                <h3 className="spaced">评测前需要确认</h3>
                <ul className="evaluation-list">
                  <li>岗位指令清楚，输入与输出约定完整。</li>
                  <li>外部工具、依赖和资源已准备好。</li>
                  <li>在 evaluations/example.json 中完善样例。</li>
                  <li>覆盖失败、缺少资料和人工介入的情况。</li>
                </ul>
                <Button
                  onClick={() => {
                    setTab("files");
                    setSelected("evaluations/example.json");
                  }}
                >
                  编辑评测样例 <ArrowRightOutlined />
                </Button>
              </>
            ),
          },
        ]}
      />
    </WorkspacePage>
  );
}
