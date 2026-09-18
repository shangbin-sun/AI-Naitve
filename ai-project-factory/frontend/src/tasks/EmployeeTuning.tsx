import { requestId } from "../requestId";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Collapse, Modal, Space, Tag } from "antd";
import Markdown from "react-markdown";
import { CloseOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { api } from "../api";
import "./task-center.css";
import ProjectChat from "../chat/ProjectChat";
import type { ChatMessage } from "../chat/types";
import EmployeeAbilityActions, { type ChatEvaluation } from "./EmployeeAbilityActions";
import EmployeeEvaluation from "../EmployeeEvaluation";
import AgentActivity from "./AgentActivity";
import EmployeeWorkflowEditor, { type EmployeeWorkflow } from "./EmployeeWorkflowEditor";

export type EmployeeConversation = {
  projectId: string;
  runId: string;
  nodeKey: string;
  name: string;
  problem?: string;
};
type Tuning = {
  engine?: string;
  workflow_generation?: {id?: string; status?: string; error?: string};
  purpose?: "repair" | "ability";
  context?: {
    status: string;
    summary: string;
    problem: string;
    verification: string;
  };
  status: string;
  started_at?: string;
  finished_at?: string;
  messages: (Omit<ChatMessage, "id"> & { id?: string })[];
  reply?: string;
  error?: string;
  session_mode?: string;
  read_only: boolean;
  can_start: boolean;
  can_continue?: boolean;
  employee_version?: number;
  continued_at?: string;
  report?: { passed: boolean; verification: string; skill?: unknown };
  skills?: { name: string; version: number }[];
  workflow_draft?: EmployeeWorkflow;
  saved_workflow?: EmployeeWorkflow;
  ability_proposal?: {
    id: string;
    previous_workflow?: EmployeeWorkflow;
    saved_version?: number;
    expected_version: number;
    instructions: string;
    files: Record<string, string>;
    workflow?: EmployeeWorkflow;
    summary?: string;
  };
};
export default function EmployeeTuning({
  projectId,
  runId,
  nodeKey,
  name,
  problem,
  onClose,
  onContinue,
}: EmployeeConversation & {
  onClose: () => void;
  onContinue: (runId?: string) => void;
}) {
  const base = `/workspaces/${projectId}/agent-runs/${runId}/nodes/${encodeURIComponent(nodeKey)}/tuning`;
  const [data, setData] = useState<Tuning>();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyRetry, setHistoryRetry] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [evaluation, setEvaluation] = useState<ChatEvaluation>();
  const [logsOpen, setLogsOpen] = useState(false);
  const [newSession, setNewSession] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyWarnings, setHistoryWarnings] = useState<string[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionNotice, setSessionNotice] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [sessionRetry, setSessionRetry] = useState(0);
  const olderLoaded = useRef(false);
  const [workflow, setWorkflow] = useState<EmployeeWorkflow>();
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const workflowDirty = useRef(false);
  const request = useRef({ body: "", id: "" });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<Tuning>(base);
        if (live) setData(value);
        if (live && !workflowDirty.current && value.ability_proposal?.workflow) setWorkflow(value.ability_proposal.workflow);
        else if (live && !workflowDirty.current && value.workflow_draft) setWorkflow(value.workflow_draft);
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [base]);
  const running = ["queued", "running"].includes(data?.status ?? "");
  const generating = ["queued", "running"].includes(data?.workflow_generation?.status ?? "");
  const historyLive = running || !!data?.read_only;
  useEffect(() => {
    if (!data?.engine) return;
    let live = true;
    setSessionReady(false);
    setSessionError('');
    setSessionNotice('正在连接原会话并检查工作目录…');
    void api<{can_send:boolean; message:string}>(base.replace(/\/tuning$/, '/conversation/readiness'))
      .then(result => {if(live){setSessionReady(result.can_send);setSessionNotice(result.message);}})
      .catch(e => {if(live){setSessionError((e as Error).message);setSessionNotice('');}});
    return () => {live = false;};
  }, [base, data?.engine, data?.status, data?.read_only, sessionRetry]);
  useEffect(() => {
    setHistory([]);
    setHistoryError("");
    setHistoryCursor(null);
    setHistoryWarnings([]);
    olderLoaded.current = false;
  }, [base]);
  useEffect(() => {
    if (!data) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api<{ messages: ChatMessage[]; next_cursor?: string; warnings?: string[] }>(
          base + "/history" + (data?.engine ? '?limit=20' : ''),
        );
        if (live) {
          const incoming = result.messages ?? [];
          setHistory(previous => data?.engine ? [...previous.filter(m => !incoming.some(n => n.id === m.id)), ...incoming] : incoming);
          if (!olderLoaded.current) setHistoryCursor(result.next_cursor ?? null);
          setHistoryWarnings(result.warnings ?? []);
          setHistoryError("");
        }
      } catch (e) {
        if (live) setHistoryError((e as Error).message);
      } finally {
        if (live && historyLive) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [base, historyLive, historyRetry, data?.engine, !!data]);
  async function loadOlder() {
    if (!historyCursor) return;
    setLoadingOlder(true);
    try {
      const result = await api<{messages: ChatMessage[]; next_cursor?: string; warnings?: string[]}>(`${base}/history?limit=20&before=${encodeURIComponent(historyCursor)}`);
      olderLoaded.current = true;
      setHistory(previous => [...result.messages.filter(m => !previous.some(n => n.id === m.id)), ...previous]);
      setHistoryCursor(result.next_cursor ?? null);
      setHistoryWarnings(previous => [...new Set([...previous, ...(result.warnings ?? [])])]);
      setHistoryError('');
    } catch(e) {setHistoryError((e as Error).message);} finally {setLoadingOlder(false);}
  }
  async function action(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(base + path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      setData(await api<Tuning>(base));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function saveWorkflow() {
    if (!workflow) return;
    setWorkflowSaving(true);
    setError("");
    try {
      await api(`${base}/workflow`, { method: "POST", body: JSON.stringify({ workflow, expected_version: data?.ability_proposal?.expected_version, proposal_id: data?.ability_proposal?.id }) });
      workflowDirty.current = false;
      setData(await api<Tuning>(base));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorkflowSaving(false);
    }
  }
  async function optimizeFromWorkflow() {
    setWorkflowOpen(true);
    const success = await action("/workflow-generation");
    if (success) workflowDirty.current = false;
  }
  const messages: ChatMessage[] = [
    ...history,
    ...(data?.messages ?? []).map((m, i) => ({
      ...m,
      id: m.id ?? `${runId}-${nodeKey}-${i}`,
    })),
  ];
  if (data?.reply && !running && data?.purpose !== "ability")
    messages.push({ id: "partial", role: "assistant", content: data.reply });
  return (
    <section className="employee-conversation-page">
      <div className="employee-conversation-header">
        <Space>
          <strong>{name}</strong>
          <Tag>{data?.engine ? (running ? "任务执行中" : "任务聊天") : running ? "调优中" : "员工对话"}</Tag>
        </Space>
        <Space className="employee-conversation-toolbar" size={10}>
          <EmployeeAbilityActions
            base={base}
            disabled={!data || busy || running || generating || !!data?.read_only}
            running={generating}
            onGenerate={async () => { await optimizeFromWorkflow(); return true; }}
            onEvaluate={setEvaluation}
          >
            <Button onClick={() => setWorkflowOpen(true)}>查看 WorkFlow</Button>
            <Button
              className="employee-toolbar-files"
              icon={<FolderOpenOutlined aria-hidden="true" />}
              aria-pressed={filesOpen}
              type="default"
              disabled={!data?.can_start && !filesOpen}
              onClick={() => setFilesOpen(!filesOpen)}
            >
              文件
            </Button>
          </EmployeeAbilityActions>
          <Button
            className="employee-toolbar-close"
            type="text"
            aria-label="关闭对话"
            title="关闭对话"
            icon={<CloseOutlined />}
            onClick={onClose}
          />
        </Space>
      </div>
      <Modal
        title={`${name} · 评测与调优`}
        width={1100}
        open={!!evaluation}
        footer={null}
        destroyOnHidden
        onCancel={() => setEvaluation(undefined)}
      >
        {evaluation && <>
          <Alert type="info" showIcon
            message={evaluation.reused ? "已打开当前聊天的评测记录" : "已启动当前聊天的基线评测"}
            description="使用已保存的员工能力和当前任务对应的评测案例，不重复导入数据。关闭窗口不会停止评测；结果保存在员工的“评测与调优”中。" />
          <EmployeeEvaluation
            key={evaluation.run_id}
            employeeId={evaluation.employee_id}
            version={Math.max(evaluation.employee_version, data?.employee_version ?? 0)}
            disabled={busy || running || generating || workflowSaving}
            initialCaseId={evaluation.case_id}
            activeRunId={evaluation.run_id}
            onAdopted={async () => { setData(await api<Tuning>(base)); }}
          />
        </>}
      </Modal>
      <ProjectChat
        workspaceId={projectId}
        filesOpen={filesOpen}
        fileScope={{ runId, node: nodeKey }}
        assistantName={name}
        messages={messages}
        nativeTimeline={!!data?.engine}
        liveReply={data?.purpose === "ability" ? undefined : data?.reply}
        busy={running}
        jobCreatedAt={data?.started_at}
        jobFinishedAt={data?.finished_at}
        readOnly={busy || !!data?.read_only || !data?.can_start || (!!data?.engine && !sessionReady)}
        canCancel={running}
        emptyTitle={`与${name}一起解决问题`}
        emptyDescription="独立员工会话保留聊天历史，直接提问，或说明需要修复的问题。"
        status="员工正在处理，离开对话后仍会继续"
        failure={
          error ||
          (data?.purpose === "ability" ? undefined : data?.error === "Codex 请求失败；请检查会话、登录或模型配置后重试"
            ? "上次消息未能启动，请重新发送消息继续。"
            : data?.error)
        }
        onCancel={async () => {
          if(data?.engine){await api(`/workspaces/${projectId}/agent-runs/${runId}/stop`,{method:'POST'});return;}
          await action("/stop");
        }}
        onSend={async (content, attachmentIds) => {
          if(data?.engine){
            if(attachmentIds.length){setError('本入口暂不支持新增附件，请通过任务输入创建新执行版本。');return false;}
            setBusy(true);setError('');
            const signature=JSON.stringify({content});
            if(request.current.body!==signature)request.current={body:signature,id:requestId()};
            try{
              await api(base.replace(/\/tuning$/,'/conversation'),{method:'POST',body:JSON.stringify({content,request_id:request.current.id})});
              request.current={body:'',id:''};setHistoryRetry(v=>v+1);setData(await api<Tuning>(base));return true;
            }catch(e){setError((e as Error).message);return false;}finally{setBusy(false);}
          }
          const body = {
            content,
            attachment_ids: attachmentIds,
            new_session: newSession || data?.purpose === "ability",
          };
          const signature = JSON.stringify(body);
          if (request.current.body !== signature)
            request.current = { body: signature, id: requestId() };
          const success = await action("", {
            ...body,
            request_id: request.current.id,
          });
          if (success) {
            request.current = { body: "", id: "" };
            setNewSession(false);
          }
          return success;
        }}
        contextPanel={
          <>
          {historyCursor && <Button loading={loadingOlder} onClick={() => void loadOlder()}>加载更早的对话</Button>}
          {historyWarnings.map(w => <Alert key={w} type="warning" message={w}/>)}
          <Collapse
            ghost
            items={[
              {
                key: "problem",
                label: "当前进展",
                children: (
                  <div className="employee-context-summary">
                    <section>
                      <strong>1. 当前结果</strong>
                      <Markdown>
                        {data?.context?.summary || "当前还没有执行总结。"}
                      </Markdown>
                    </section>
                    {(data?.context ? data.context.problem : problem) && (
                      <section>
                        <strong>2. 需要解决的问题</strong>
                        <Markdown>
                          {data?.context?.problem || problem || ""}
                        </Markdown>
                      </section>
                    )}
                    {data?.context?.verification && (
                      <section>
                        <strong>已经做过的检查</strong>
                        <Markdown>{data.context.verification}</Markdown>
                      </section>
                    )}
                    <section>
                      <strong>接下来</strong>
                      <p>
                        {running
                          ? "员工正在处理，完成后会在对话中说明结果。"
                          : data?.read_only
                            ? "任务仍在执行。可以先查看进展，等待结束后继续对话。"
                            : "可以在下方直接描述你的要求、补充信息或上传截图，员工会结合已有记录继续处理。"}
                      </p>
                    </section>
                    {!data?.engine && <Button
                      type="text"
                      size="small"
                      onClick={() => setLogsOpen(true)}
                    >
                      查看技术日志
                    </Button>}
                  </div>
                ),
              },
            ]}
          />
          </>
        }
        controls={
          <div className="employee-conversation-controls">
            {data?.engine && sessionNotice && <small>{sessionNotice}</small>}
            {data?.engine && sessionError && <Alert type="warning" message={sessionError} action={<Button onClick={() => setSessionRetry(v=>v+1)}>重新检查</Button>}/>}
            {historyError && (
              <Alert
                type="warning"
                message={historyError}
                action={
                  <Button
                    size="small"
                    onClick={() => setHistoryRetry((v) => v + 1)}
                  >
                    重试读取
                  </Button>
                }
              />
            )}
            {data && !data.can_start && (
              <small>员工尚未开始执行，请先从任务节点启动。</small>
            )}
            {data?.read_only && (
              <small>任务执行中，暂时只读；停止执行后可调优。</small>
            )}
            {data?.continued_at && (
              <small>修复已交回任务；任务停止后可以继续对话调优。</small>
            )}
            {!!data?.skills?.length && (
              <small>
                已保存技能：
                {data.skills
                  .map((s) => `${s.name} · 员工版本 ${s.version}`)
                  .join("、")}
              </small>
            )}
            {data?.report?.passed && !running && (
              <Space wrap>
                {data.can_continue && (
                  <Button
                    type="primary"
                    disabled={busy || !!data.continued_at || data.read_only}
                    onClick={async () => {
                      if (await action("/continue")) onContinue();
                    }}
                  >
                    继续任务
                  </Button>
                )}
              </Space>
            )}
            {!data?.engine && data?.status === "interrupted" && (
              <Button
                type={newSession ? "primary" : "text"}
                disabled={busy || data.read_only}
                onClick={() => setNewSession(!newSession)}
              >
                {newSession ? "下一条消息重建独立会话" : "重建独立会话"}
              </Button>
            )}
          </div>
        }
      />

      <Modal title="员工 WorkFlow · 生成与对比" width="95vw" open={workflowOpen} onCancel={() => setWorkflowOpen(false)} footer={null}>
      <p>回顾完整聊天，归纳用户做过的几件事，把反复修正提炼为注意事项。结合已保存方法生成候选，确认后再保存。</p>
      {generating && <Alert type="info" message="正在独立生成 WorkFlow，关闭窗口后仍会继续。员工聊天保持原样。" />}
      {(data?.workflow_generation?.error || error) && <Alert type="error" message={data?.workflow_generation?.error || error} />}
      {!generating && !workflow && <Button disabled={busy} onClick={() => void optimizeFromWorkflow()}>生成 WorkFlow</Button>}
      {workflow && !generating && (
        <EmployeeWorkflowEditor
          value={workflow}
          previous={data?.ability_proposal?.previous_workflow}
          saved={!!data?.ability_proposal?.saved_version}
          saving={workflowSaving || busy || !!data?.read_only}
          onChange={(next) => { workflowDirty.current = true; setWorkflow(next); }}
          onSave={() => void saveWorkflow()}
          onOptimize={optimizeFromWorkflow}
        />
      )}
      </Modal>

      <Modal
        title="技术日志"
        width={850}
        open={logsOpen}
        onCancel={() => setLogsOpen(false)}
        footer={null}
        destroyOnHidden
      >
        {logsOpen && (
          <AgentActivity
            projectId={projectId}
            runId={runId}
            nodes={{ [nodeKey]: { employee: { name } } }}
            initialNode={nodeKey}
            tuning
          />
        )}
      </Modal>
    </section>
  );
}
