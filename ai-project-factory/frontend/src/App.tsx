import EmployeeWorkflow from "./workflow/EmployeeWorkflow";
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
  Modal,
  Spin,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import {
  ArrowRightOutlined,
  CheckOutlined,
  CodeOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  RobotOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import type { EmployeeConversation } from "./tasks/EmployeeTuning";
const EmployeeTuning = lazy(() => import("./tasks/EmployeeTuning"));
const TasksPanel = lazy(() => import("./tasks/TasksPanel"));
const ProjectChat = lazy(() => import("./chat/ProjectChat"));
const DashboardPanel = lazy(() => import('./DashboardPanel'));
import { api, ApiError } from "./api";
import WorkspacePage from "./WorkspacePage";
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
  "conversation" | "plan" | "tasks" | "dashboard";
function readRoute() {
  const [path, query] = window.location.hash.slice(1).split("?");
  const employee = new URLSearchParams(query).get("employee");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "employees")
    return {
      view: "employees" as View,
      id: null,
      tab: "conversation" as ProjectTab,
      employee,
    };
  if (parts[0] === "projects" && parts[1])
    return {
      view: "design" as View,
      id: parts[1] === "new" ? null : parts[1],
      employee,
      tab: ([
        "conversation",
        "plan",
        "tasks",
        "dashboard",
      ].includes(parts[2])
        ? parts[2]
        : "conversation") as ProjectTab,
    };
  return {
    view: "projects" as View,
    id: null,
    tab: "conversation" as ProjectTab,
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
  const teamLocations = useRef(new Map<string, ProjectTab>());
  const [employeeChats,setEmployeeChats] = useState<EmployeeConversation[]>(()=>{
    try {const value=JSON.parse(localStorage.getItem("employee-conversations")||"[]");return Array.isArray(value)?value.filter(c=>c&&typeof c.projectId==="string"&&typeof c.runId==="string"&&typeof c.nodeKey==="string"&&typeof c.name==="string"):[];}catch{return [];}
  });
  const [selectedChat,setSelectedChat]=useState<string|null>(()=>new URLSearchParams(window.location.hash.split("?")[1]).get("tuning"));
  const chatKey=(c:EmployeeConversation)=>`${c.runId}:${c.nodeKey}`;
  const currentChat=employeeChats.find(c=>c.projectId===active&&chatKey(c)===selectedChat);
  useEffect(()=>{try{localStorage.setItem("employee-conversations",JSON.stringify(employeeChats));}catch{/* Navigation still works when browser storage is unavailable. */}},[employeeChats]);
  function openEmployeeChat(conversation:EmployeeConversation){
    setEmployeeChats(current=>[...current.filter(c=>chatKey(c)!==chatKey(conversation)),conversation]);
    setReturnRun(conversation.runId);
    navigate("design",conversation.projectId,conversation.projectId===active ? projectTab : teamLocations.current.get(conversation.projectId) ?? "tasks",false,null,chatKey(conversation));
  }
  function closeEmployeeChat(conversation:EmployeeConversation){
    setEmployeeChats(current=>current.filter(c=>chatKey(c)!==chatKey(conversation)));
    if(selectedChat===chatKey(conversation)){setReturnRun(conversation.runId);navigate("design",conversation.projectId,"tasks");}
  }
  const [namingTeam, setNamingTeam] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [nameError, setNameError] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [returnRun,setReturnRun]=useState<string>();
  const [taskLaunch,setTaskLaunch]=useState<{employee?:string;nonce:number}>();
  const [design, setDesign] = useState<Design | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [employeeReference, setEmployeeReference] = useState("");
  useEffect(() => {
    setEmployeeReference("");
  }, [active]);
  const [editor, setEditor] = useState<Employee | null>(null);
  const [employeeRouteId, setEmployeeRouteId] = useState(readRoute().employee);
  const [raw, setRaw] = useState<string | null>(null);
  const [rawVersion, setRawVersion] = useState(0);
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
    const [d, e] = await Promise.all([
      api<Design[]>("/workspaces"),
      api<Employee[]>("/employees"),
    ]);
    setDesigns(d);
    setEmployees(e);
  }, []);
  const refreshDesign = useCallback(async (id: string) => {
    try {
      const d = await api<Design>(`/workspaces/${id}`);
      if (activeRef.current === id) {
        setDesign(d);
        setSyncError("");
      }
    } catch (e) {
      if (activeRef.current !== id) return;
      if (e instanceof ApiError && e.status === 404) {
        activeRef.current = null;
        setDesign(null);
        setEditor(null);
        setRaw(null);
        setFilesOpen(false);
        setError("");
        setSyncError("");
        requestRef.current = null;
        localStorage.removeItem("factory.design");
        navigate("projects", null, "conversation", true);
        await refreshLists();
        return;
      }
      throw e;
    }
  }, [refreshLists]);

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
    let inFlight = false;
    const timer = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refreshDesign(active);
      } catch (e) {
        setSyncError((e as Error).message);
      } finally {
        inFlight = false;
      }
    }, 6000);
    return () => clearInterval(timer);
  }, [active, job?.status, refreshDesign, refreshLists]);
  function requestTeamName() {
    setTeamName(""); setNameError(""); setNamingTeam(true);
  }
  async function createNamedTeam() {
    if (!teamName.trim() || creatingTeam) return;
    setCreatingTeam(true);
    try {
      const created = await api<Design>("/workspaces", {method:"POST", body:JSON.stringify({title:teamName.trim()})});
      activeRef.current = created.id;
      setNamingTeam(false);
      navigate("design", created.id, "conversation");
      setDesign(created);
      await refreshLists();
    } catch (e) { setNameError((e as Error).message); }
    finally { setCreatingTeam(false); }
  }
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
        setText(value); requestTeamName(); return false;
      }
      if (
        !requestRef.current ||
        requestRef.current.content !==
          JSON.stringify([value, attachmentIds, employeeReference]) ||
        requestRef.current.designId !== id
      )
        requestRef.current = {
          id: crypto.randomUUID(),
          content: JSON.stringify([value, attachmentIds, employeeReference]),
          designId: id,
        };
      await api(`/workspaces/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: value,
          attachment_ids: attachmentIds,
          employee_id: employeeReference || undefined,
          request_id: requestRef.current.id,
          expected_version: version,
        }),
      });
      accepted = true;
      requestRef.current = null;
      setEmployeeReference("");
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

  const editorDirty = useRef(false);
  const routeRef = useRef(window.location.hash || "#/projects");
  const scrollPositions = useRef(new Map<string, number>());
  function navigate(
    nextView: View,
    id: string | null,
    tab: ProjectTab = "conversation",
    replace = false,
    employeeId: string | null = null,
    tuningId: string | null = null,
  ) {
    if (view === "design" && active && !currentChat) teamLocations.current.set(active, projectTab);
    scrollPositions.current.set(routeRef.current, window.scrollY);
    const base =
      nextView === "employees"
        ? "#/employees"
        : nextView === "projects"
          ? "#/projects"
          : `#/projects/${id || "new"}/${tab}`;
    const hash =
      base + (employeeId ? `?employee=${encodeURIComponent(employeeId)}` : tuningId ? `?tuning=${encodeURIComponent(tuningId)}` : "");
    if (hash !== window.location.hash)
      window.history[replace ? "replaceState" : "pushState"](null, "", hash);
    routeRef.current = hash;
    setView(nextView);
    setActive(id);
    setProjectTab(tab);
    setSelectedChat(tuningId);
    if (tab !== "tasks") setTaskLaunch(undefined);
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
          throw new Error("此员工不属于当前AI 团队");
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
      setSelectedChat(new URLSearchParams(window.location.hash.split("?")[1]).get("tuning"));
      const proceed = () => {
        setEditor(null);
        setRaw(null);
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
      (!editor && raw === null)
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
          href="#/projects"
          aria-label="返回团队首页"
          onClick={() => {
            navigate("projects", null);
          }}
        >
          <span className="brand-mark">
            A<span>·</span>
          </span>
          <div>
            AI 工作室<small>AI STUDIO</small>
          </div>
        </a>
        <button className="sidebar-create-team" aria-label="新建AI团队" title="新建AI团队" onClick={() => {
          setText(""); requestTeamName();
        }}><PlusOutlined /><span>新建AI团队</span></button>
        <section className="sidebar-teams" aria-label="AI 团队列表">
          <div className="sidebar-teams-heading">
            <span>我的 AI 团队</span>

          </div>
          <div className="sidebar-team-list">
            {designs.map((team) => (
              <div key={team.id}><button title={team.title}
                aria-label={`进入 AI 团队 ${team.title}`}
                aria-current={active === team.id ? "page" : undefined}
                className={`sidebar-team-item ${active === team.id && !currentChat ? "selected" : ""}`}
                onClick={() => navigate("design", team.id, teamLocations.current.get(team.id) ?? (team.id === active ? projectTab : "conversation"))}>
                <TeamOutlined /><span>{team.title}</span>
              </button>
              {employeeChats.some(c=>c.projectId===team.id)&&<div className="sidebar-employee-chats">
                {employeeChats.filter(c=>c.projectId===team.id).map(c=><div key={chatKey(c)} className={`sidebar-employee-chat ${currentChat===c?"selected":""}`}><button onClick={()=>openEmployeeChat(c)} title={c.name}><RobotOutlined/><span>{c.name}</span></button><button aria-label={`关闭${c.name}对话`} title="关闭对话" onClick={()=>closeEmployeeChat(c)}>×</button></div>)}
              </div>}
              </div>
            ))}
          </div>
        </section>
        <nav>
          <button className={`nav-item secondary-nav ${view === "employees" ? "selected" : ""}`}
            onClick={() => navigate("employees", null)}>
            <RobotOutlined />员工
          </button>
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
        {(error || syncError) && (
          <Alert
            className="global-error"
            message={error || syncError}
            type="error"
            closable
            onClose={() => {
              setError("");
              setSyncError("");
            }}
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
                  你的下一个AI 团队，
                  <br />
                  从一场对话开始<span>。</span>
                </h1>
                <p className="welcome-description">
                  说说你想完成什么。我们一起梳理角色、工作流程与交付目标，
                  <br className="desktop-break" />
                  创建AI 团队，在同一个空间里完善团队与方案。
                </p>
                <div className="welcome-composer">
                  <Input.TextArea
                    aria-label="描述AI 团队目标"
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
                      创建AI 团队 <ArrowRightOutlined />
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
                    "在AI 团队中完善方案",
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
                    <p>AI 团队暂时无法打开，请重试或返回AI 团队列表。</p>
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
                      返回AI 团队
                    </Button>
                  </>
                ) : (
                  <>
                    <Spin />
                    <p>正在打开AI 团队…</p>
                  </>
                )}
              </div>
            ) : (
              <>
                {currentChat && <Suspense fallback={<Spin/>}><EmployeeTuning key={chatKey(currentChat)} {...currentChat} onClose={()=>closeEmployeeChat(currentChat)} onContinue={(runId)=>{setReturnRun(runId ?? currentChat.runId);navigate("design",currentChat.projectId,"tasks");}}/></Suspense>}
                <div style={{display: currentChat ? "none" : "contents"}}>
                <div className="project-navigation">
                <Tabs
                  className="project-tabs"
                  tabBarExtraContent={projectTab === "conversation" ? <Button
                    type={filesOpen ? "primary" : "text"}
                    icon={<FolderOpenOutlined />}
                    aria-label={filesOpen ? "收起文件" : "展开文件"}
                    aria-expanded={filesOpen}
                    onClick={() => setFilesOpen(value => !value)}
                  >文件</Button> : undefined}
                  activeKey={projectTab}
                  onChange={(key) =>
                    navigate("design", active, key as ProjectTab)
                  }
                  items={[
                    { key: "conversation", label: "对话" },
                    { key: "plan", label: "团队" },
                    { key: "tasks", label: "任务与运行" },
                    { key: "dashboard", label: "看板" },
                  ]}
                />
                </div>
                {projectTab === 'dashboard' && <Suspense fallback={<Spin/>}><DashboardPanel key={design.id} projectId={design.id} onCustomize={askProject}/></Suspense>}
                {projectTab === "tasks" && (
                  <>
                    <Suspense fallback={<Spin />}>
                      <TasksPanel
                        key={design.id}
                        projectId={design.id}
                        launchEmployee={taskLaunch}
                        initialRun={returnRun}
                        onEmployeeChat={openEmployeeChat}
                      />
                    </Suspense>
                  </>
                )}
                <div
                  hidden={
                    projectTab !== "conversation" && projectTab !== "plan"
                  }
                  className={`studio project-studio ${projectTab === "conversation" || projectTab === "plan" ? "" : "is-hidden"}`}
                >
                  <section
                    hidden={projectTab !== "conversation"}
                    className={`chat-panel codex-chat-panel ${projectTab !== "conversation" ? "is-hidden" : ""}`}
                  >
                    <Suspense fallback={<Spin tip="正在加载对话" />}>
                      <ProjectChat
                        key={design.id}
                        workspaceId={design.id}
                        filesOpen={filesOpen}
                        employees={design.employees}
                        employeeReference={employeeReference}
                        onReferenceChange={setEmployeeReference}
                        jobId={job?.id}
                        jobCreatedAt={job?.created_at}
                        jobFinishedAt={job?.finished_at}
                        threadId={design.codex_conversation?.thread_id}
                        onSettled={() => {
                          void Promise.all([
                            refreshDesign(design.id),
                            refreshLists(),
                          ]).catch((e) => setSyncError(e.message));
                        }}
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

                      />
                    </Suspense>
                  </section>
                  <section
                    hidden={projectTab !== "plan"}
                    className={`preview-panel ${projectTab !== "plan" ? "is-hidden" : ""}`}
                  >
                    {!design.draft.name ? (
                      <div className="preview-empty">
                        <div className="empty-orbit">
                          <TeamOutlined />
                        </div>
                        <h3>团队正在构思中</h3>
                        <p>
                          聊清目标后，员工与协作关系
                          <br />
                          会自动出现在这里。
                        </p>
                      </div>
                    ) : (
                      <WorkflowPreview
                        draft={design.draft as Draft}
                        onEmployee={openEmployee}
                        onQuestion={askProject}
                        onRun={(employee) => {
                          setTaskLaunch({employee,nonce:Date.now()});
                          navigate("design",design.id,"tasks");
                        }}
                      />
                    )}
                  </section>
                </div>
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
              <p>集中完善员工指令与工程文件。日常团队协作请进入所属AI 团队。</p>
            </div>
            {!employees.length ? (
              <Empty description="还没有员工工程">
                <Button
                  type="primary"
                  onClick={() => {
                    requestTeamName();
                  }}
                >
                  创建AI 团队并生成员工
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
                      所属AI 团队 ·{" "}
                      {designs.find((d) => d.id === e.design_id)?.title ||
                        "AI 团队"}
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
          <section className={`library project-library${designs.length ? "" : " project-library-empty"}`}>
            {!designs.length ? (
              <Empty className="spaced" description="从第一个目标开始">
                <Button
                  onClick={() => {setText(""); requestTeamName();}}
                >
                  创建第一个AI 团队
                </Button>
              </Empty>
            ) : (
              <div className="employee-grid spaced">
                {designs
                  .map((d) => (
                    <button
                      className="employee-card project-card"
                      aria-label={`查看 AI 团队 ${d.title}`}
                      key={d.id}
                      onClick={() => {
                        setText("");
                        navigate("design", d.id);
                      }}
                    >
                      <div className="card-top">
                        <TeamOutlined className="project-icon" />
                        <Tag>{d.draft.ready ? "方案已形成" : "筹备中"}</Tag>
                      </div>
                      <h3>{d.title}</h3>
                      <p>{d.draft.goal || "进入AI 团队，继续完善目标与团队"}</p>
                      <div className="card-footer">
                        {d.draft.members?.length || 0} 个岗位 ·{" "}
                        {d.draft.workflow?.length || 0} 项工作
                        <span>
                          打开AI 团队 <ArrowRightOutlined />
                        </span>
                      </div>
                    </button>
                  ))}
              </div>
            )}

          </section>
        )}
      </main>

      <Modal title="新建AI团队" open={namingTeam} okText="创建团队" cancelText="取消"
        confirmLoading={creatingTeam} okButtonProps={{disabled:!teamName.trim()}}
        onOk={() => void createNamedTeam()} onCancel={() => {if(!creatingTeam)setNamingTeam(false);}}>
        <label htmlFor="new-team-name">AI团队名称</label>
        <Input id="new-team-name" autoFocus maxLength={200} value={teamName}
          placeholder="请输入团队名称" disabled={creatingTeam}
          onChange={e => setTeamName(e.target.value)} onPressEnter={() => void createNamedTeam()} />
        {nameError && <Alert type="error" message={nameError} />}
      </Modal>
      {editor && (
        <EmployeeEditor
          key={editor.id}
          employee={editor}
          projectTitle={designs.find((d) => d.id === editor.design_id)?.title}
          onDirtyChange={(dirty) => {
            editorDirty.current = dirty;
          }}
          onClose={closeEditor}
          onRun={() => {
            const selected=editor;
            setEditor(null);editorDirty.current=false;
            setTaskLaunch({employee:selected.profile.key,nonce:Date.now()});
            navigate("design",selected.design_id,"tasks");
          }}
          onDiscuss={() => {
            const selected = editor;
            setEditor(null);
            editorDirty.current = false;
            navigate("design", selected.design_id, "conversation");
            // Apply selection after a possible project change clears the old reference.
            setTimeout(() => {
              setEmployeeReference(selected.id);
              setText("请根据当前配置和运行记录，帮我优化这个员工。");
            }, 0);
          }}
          onSave={async (e) => {
            setEditor(e);
            await refreshLists();
            if (active) await refreshDesign(active);
          }}
        />
      )}
      <WorkspacePage
        title="编辑AI 团队方案"
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
        <p>这是本AI 团队的历史方案。点击岗位查看当时的职责、指令与工程文件。</p>
        <Button icon={<EditOutlined />} onClick={() => onEditTeam()}>
          返回当前AI 团队方案
        </Button>
      </div>
      <WorkflowPreview
        draft={project.snapshot.team}
        onEmployee={(m) => {
          setMember(m);
          setSelectedFile("instructions/role.md");
        }}
        onQuestion={(q) => onEditTeam(q)}
      />
      <RunPreparation
        draft={project.snapshot.team}
        onQuestion={(q) => onEditTeam(q)}
      />
      <WorkspacePage
        title={member ? `${member.name} · AI 团队内详情` : "员工详情"}
        open={!!member}
        onClose={() => setMember(null)}
        destroyOnHidden
      >
        {member && (
          <>
            <Alert
              type="info"
              showIcon
              message={`AI 团队快照 · 团队修订 ${project.design_version}${saved ? ` · 员工版本 ${saved.version}` : " · 人类岗位"}`}
              description="这里展示保存快照时的内容。编辑当前AI 团队不会改变此历史版本。"
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
                        label: "AI 团队工程文件",
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
                                  aria-label="AI 团队快照文件内容"
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
              返回当前AI 团队方案
            </Button>
          </>
        )}
      </WorkspacePage>
    </>
  );
}

function WorkflowPreview({
  draft,
  onEmployee,
  onQuestion,
  onRun,
}: {
  draft: Draft;
  onEmployee?: (m: Member) => void;
  onQuestion?: (q: string) => void;
  onRun?: (employee?: string) => void;
}) {
  return (
    <div className="team-preview">
      <EmployeeWorkflow
        draft={draft}
        onEmployee={onEmployee}
        onQuestion={onQuestion}
        onRun={onRun}
      />
    </div>
  );
}

function RunPreparation({
  draft,
  onQuestion,
}: {
  draft: Draft;
  onQuestion?: (question: string) => void;
}) {
  const requirements = draft.requirements || [];
  return (
    <section
      className="workflow-detail"
      aria-label="运行准备"
      style={{ marginBottom: 24 }}
    >
      <div className="workflow-detail-heading">
        <h3>运行准备</h3>
        <span>
          {requirements.length} 项依赖 ·{" "}
          {requirements.filter((item) => item.blocking).length} 项运行前需补齐
        </span>
      </div>
      {requirements.length ? (
        requirements.map((item, index) => (
          <div className="requirement" key={index}>
            <Badge status={item.blocking ? "warning" : "default"} />
            <div>
              <strong>{item.name}</strong>
              <p>{item.description}</p>
              <small>
                {item.blocking ? "正式运行前需要补齐" : "可以后续完善"}
              </small>
              {onQuestion && (
                <Button
                  type="link"
                  onClick={() =>
                    onQuestion(
                      `请帮我完善运行准备中的“${item.name}”：${item.description}`,
                    )
                  }
                >
                  讨论如何补齐
                </Button>
              )}
            </div>
          </div>
        ))
      ) : (
        <p>
          尚未声明额外运行依赖；请结合具体任务检查资料、工具和凭据是否齐备。
        </p>
      )}
      {!!draft.questions?.length && (
        <div className="questions">
          <span className="section-kicker">运行前待确认</span>
          {draft.questions.map((question, index) =>
            onQuestion ? (
              <button
                key={index}
                onClick={() => onQuestion(`${question}\n我的回答：`)}
              >
                {question}
                <ArrowRightOutlined />
              </button>
            ) : (
              <p key={index}>{question}</p>
            ),
          )}
        </div>
      )}
      {!!draft.assumptions?.length && (
        <details className="workflow-internal-steps">
          <summary>当前假设 · {draft.assumptions.length} 项</summary>
          {draft.assumptions.map((item, index) => (
            <p key={index}>{item}</p>
          ))}
        </details>
      )}
    </section>
  );
}

export function EmployeeEditor({
  employee,
  projectTitle,
  onClose,
  onSave,
  onDirtyChange,
  onDiscuss,
  onRun,
}: {
  employee: Employee;
  projectTitle?: string;
  onDirtyChange?: (dirty: boolean) => void;
  onDiscuss?: () => void;
  onRun?: () => void;
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
        <div style={{ display: "flex", gap: 8 }}>
          {onRun && <Button disabled={dirty||saving} onClick={onRun}>单独执行</Button>}
          {onDiscuss && (
            <Button
              disabled={dirty || saving}
              title={dirty ? "请先保存当前修改" : "在AI 团队对话中引用此员工"}
              onClick={onDiscuss}
            >
              讨论／优化此员工
            </Button>
          )}
          <Button
            type="primary"
            icon={<CheckOutlined />}
            loading={saving}
            disabled={!dirty}
            onClick={() => void save()}
          >
            保存修改
          </Button>
        </div>
      }
    >
      <div className="editor-notice">
        <CodeOutlined />
        <span>
          {projectTitle ? `所属AI 团队：${projectTitle} · ` : ""}
          保存后更新本AI 团队方案，历史快照保持原版本
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
