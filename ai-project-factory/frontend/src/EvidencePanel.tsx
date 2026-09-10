import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Select,
  Tag,
  App as AntApp,
} from "antd";
import { api } from "./api";
import DeliveryPanel, {
  DeliveryResults,
  type DeliveryAttempt,
} from "./DeliveryPanel";
import EmployeeBuildPanel from "./EmployeeBuildPanel";
import EmployeeTrial from "./EmployeeTrial";

type Source = {
  id: string;
  title: string;
  location: string;
  kind: string;
  coverage: string;
  content: string;
  digest: string;
};
type Check = {
  id: string;
  status: string;
  reason: string;
  evidence: string[];
  improvement: string;
};
type Evaluation = {
  id: string;
  design_version: number;
  kind: string;
  status: string;
  error: string;
  inputs?: { goal?: string };
  result: {
    summary?: string;
    stage?: string;
    events?: string[];
    blueprint?: Record<string, unknown>;
    attempts?: DeliveryAttempt[];
    reference_test_files?: number;
    plan?: Record<string, unknown>;
    worker_ids?: string[];
    installed_design_version?: number;
    worker_install_error?: string;
    employee_id?: string;
    checks?: Check[];
    employee_improvements?: string[];
    next_iteration?: string;
    scope?: string;
    exit_code?: number;
    output?: string;
    command?: string[];
    artifacts?: { path: string; content: string; sha256: string }[];
    open_questions?: string[];
    manifest?: Record<string, unknown>;
  };
};
const labels: Record<string, string> = {
  environment: "准备运行环境",
  baseline: "执行原始基线",
  analyze: "分析需求与架构",
  summarize: "整理样例",
  develop: "开发员工",
  test: "运行开发测试",
  validate: "独立验证",
  complete: "验证完成",
  source_coverage: "资料完整性",
  requirements: "需求与疑问",
  perception: "感知契约",
  execution: "执行契约",
  model: "模型需求",
  architecture: "架构与基线",
  unit: "单元测试计划",
  e2e: "端到端测试计划",
  deployment: "部署与回滚计划",
  restart: "局部重跑",
  employee_quality: "员工质量机制",
  functional_validation: "真实行为验证",
  pass: "通过",
  fail: "不通过",
  blocked: "阻塞",
  not_assessed: "未评估",
  queued: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
  full: "已导入",
  excerpt: "节选",
  link_only: "仅链接",
};
export default function EvidencePanel({
  projectId,
  version,
  onImprove,
}: {
  projectId: string;
  version: number;
  onImprove: (prompt: string) => void;
}) {
  const { message } = AntApp.useApp();
  const [sources, setSources] = useState<Source[]>([]),
    [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [path, setPath] = useState("");
  const [title, setTitle] = useState(""),
    [location, setLocation] = useState(""),
    [content, setContent] = useState(""),
    [kind, setKind] = useState("requirements");
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [downloadDependencies, setDownloadDependencies] = useState(false);
  const runsHeading = useRef<HTMLHeadingElement>(null);
  async function refresh() {
    const [s, e] = await Promise.all([
      api<Source[]>(`/workspaces/${projectId}/sources`),
      api<Evaluation[]>(`/workspaces/${projectId}/evaluations`),
    ]);
    setSources(s);
    setEvaluations(e);
  }
  useEffect(() => {
    let disposed = false,
      inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const [s, e] = await Promise.all([
          api<Source[]>(`/workspaces/${projectId}/sources`),
          api<Evaluation[]>(`/workspaces/${projectId}/evaluations`),
        ]);
        if (!disposed) {
          setSources(s);
          setEvaluations(e);
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    }
    void load();
    const timer = setInterval(load, 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [projectId]);
  async function act(action: () => Promise<unknown>) {
    setWorking(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const running = evaluations.some((e) =>
    ["queued", "running"].includes(e.status),
  );
  return (
    <section className="evidence-page">
      <div className="project-history-heading">
        <div>
          <h2>资料基线与质量评估</h2>
          <p>记录真实来源、方案版本与验证结果。设计评估和实际测试分别展示。</p>
        </div>
        <div className="evidence-actions">
          <Button
            loading={working}
            disabled={!sources.length || running}
            onClick={() =>
              void act(() =>
                api(`/workspaces/${projectId}/evaluations`, { method: "POST" }),
              )
            }
          >
            独立评估方案
          </Button>
          <Button
            disabled={working || running || !sources.length}
            onClick={() =>
              void act(() =>
                api(`/workspaces/${projectId}/evaluations?kind=requirements`, {
                  method: "POST",
                }),
              )
            }
          >
            试运行需求分析
          </Button>
          <Button
            disabled={
              working || running || !sources.some((s) => s.kind === "code")
            }
            onClick={() =>
              void act(() =>
                api(
                  `/workspaces/${projectId}/evaluations?kind=baseline&offline=${!downloadDependencies}`,
                  {
                    method: "POST",
                  },
                ),
              )
            }
          >
            运行基线单元测试
          </Button>
          <Checkbox
            checked={downloadDependencies}
            disabled={working || running}
            onChange={(e) => setDownloadDependencies(e.target.checked)}
          >
            允许下载构建依赖
          </Checkbox>
        </div>
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {!!evaluations.length && (
        <div className="evidence-actions">
          <Tag>
            最新运行：{labels[evaluations[0].status] || evaluations[0].status}
          </Tag>
          <Button
            onClick={() =>
              runsHeading.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              })
            }
          >
            查看运行记录（{evaluations.length}）
          </Button>
        </div>
      )}
      <Alert
        type="info"
        showIcon
        message="资料不足会标记为阻塞，不能算作质量通过"
        description="需求试运行生成六类文档草稿，待独立验收。基线测试在源码副本运行；Gradle依赖为离线模式，Wrapper可能下载发行包。端到端和部署执行尚未接入。"
      />
      <div className="source-import">
        <h3>导入服务端代码基线</h3>
        <Input
          aria-label="代码基线目录"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="AgentAI 团队目录下的代码工程路径"
        />
        <Button
          disabled={!path.trim() || working}
          onClick={() =>
            void act(() =>
              api(`/workspaces/${projectId}/sources/import-code`, {
                method: "POST",
                body: JSON.stringify({ path }),
              }),
            )
          }
        >
          导入源码快照
        </Button>
      </div>
      <details className="source-form">
        <summary>添加参考资料或评估标准</summary>
        <Input
          aria-label="资料名称"
          placeholder="资料名称"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Input
          aria-label="资料来源"
          placeholder="原始链接或文件路径"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <Select
          aria-label="资料类型"
          value={kind}
          onChange={setKind}
          options={[
            { value: "requirements", label: "需求" },
            { value: "questions", label: "需求疑问" },
            { value: "contracts", label: "感知/执行/模型契约" },
            { value: "rubric", label: "评估标准" },
            { value: "observation", label: "检查记录" },
          ]}
        />
        <Input.TextArea
          aria-label="资料摘录"
          rows={6}
          placeholder="已核实的正文摘录，标明页码/行号和未读取部分"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <Button
          disabled={!title.trim() || working}
          onClick={() =>
            void act(async () => {
              await api(`/workspaces/${projectId}/sources`, {
                method: "POST",
                body: JSON.stringify({
                  title,
                  location,
                  content,
                  kind,
                  coverage: content ? "excerpt" : "link_only",
                }),
              });
              setTitle("");
              setContent("");
              message.success("资料版本已保存");
            })
          }
        >
          保存资料版本
        </Button>
      </details>
      <DeliveryPanel
        projectId={projectId}
        disabled={
          working ||
          evaluations.some((e) => ["queued", "running"].includes(e.status)) ||
          !sources.some((s) => s.kind === "code")
        }
        onStarted={refresh}
      />
      <EmployeeBuildPanel
        projectId={projectId}
        disabled={working || running || !sources.length}
        onStarted={refresh}
      />
      <h3>参考资料 · {sources.length}</h3>
      {!sources.length && <Empty description="先导入资料，再评估AI 团队与员工" />}
      {sources.map((s) => (
        <article className="source-card" key={s.id}>
          <div>
            <Button
              type="link"
              onClick={() => setOpenSource(openSource === s.id ? null : s.id)}
            >
              {s.title}
            </Button>
            <Tag>{labels[s.coverage]}</Tag>
          </div>
          <p>
            {s.location.startsWith("https://") ? (
              <a href={s.location} target="_blank" rel="noreferrer">
                打开原始资料
              </a>
            ) : (
              s.location
            )}
          </p>
          <small>
            版本摘要 {s.digest.slice(0, 16)} · {s.id}
          </small>
          {openSource === s.id && (
            <pre>{s.content || "仅有链接，尚未摄取正文"}</pre>
          )}
        </article>
      ))}
      <h3 ref={runsHeading}>评估与测试记录</h3>
      {!evaluations.length && <Empty description="尚未发起评估" />}
      {evaluations.map((e) => (
        <article className="evaluation-card" key={e.id}>
          <h3>
            {e.kind === "delivery"
              ? "AI 团队自动开发与原有样例验证"
              : e.kind === "employee_run"
                ? "员工实际试运行"
                : e.kind === "employee_build"
                  ? "系统自动开发员工"
                  : e.kind === "review"
                    ? "独立设计评估"
                    : e.kind === "requirements"
                      ? "需求员工试运行"
                      : "真实基线单元测试"}{" "}
            <Tag>{labels[e.status] || e.status}</Tag>
            <Tag>方案修订 {e.design_version}</Tag>
            {(e.result.installed_design_version ?? e.design_version) !== version && (
              <Tag color="orange">历史版本，请重新评估当前方案</Tag>
            )}
          </h3>
          <small>{e.id}</small>
          {["queued", "running"].includes(e.status) && (
            <Button
              disabled={working}
              onClick={() =>
                void act(() =>
                  api(`/evaluations/${e.id}/cancel`, { method: "POST" }),
                )
              }
            >
              停止本次运行
            </Button>
          )}
          {e.error && <Alert type="error" message={e.error} />}
          {!!e.result.artifacts?.length && (
            <Alert
              type="info"
              message={`平台已保存 ${e.result.artifacts.length} 份产物及哈希，业务质量仍待验收`}
              description="下方保留员工原始生成说明；实际存储状态以平台文件和交接清单为准。"
            />
          )}
          <p>{e.result.summary || e.result.scope}</p>
          {e.result.stage && (
            <Tag>阶段：{labels[e.result.stage] ?? e.result.stage}</Tag>
          )}
          {e.result.events && (
            <details className="source-form" open>
              <summary>系统执行记录</summary>
              <pre>{e.result.events.join("\n")}</pre>
            </details>
          )}
          {e.result.blueprint && (
            <details className="source-form">
              <summary>自动提取的候选样例与规则</summary>
              <pre>{JSON.stringify(e.result.blueprint, null, 2)}</pre>
            </details>
          )}
          {e.kind === "delivery" && (
            <DeliveryResults
              attempts={e.result.attempts || []}
              referenceFiles={e.result.reference_test_files || 0}
            />
          )}
          {e.kind === "delivery" &&
            ["blocked", "completed"].includes(e.status) && (
              <Button
                disabled={
                  working ||
                  evaluations.some((r) =>
                    ["queued", "running"].includes(r.status),
                  )
                }
                onClick={() =>
                  void act(() =>
                    api(`/workspaces/${projectId}/delivery-runs`, {
                      method: "POST",
                      body: JSON.stringify({
                        goal:
                          e.inputs?.goal ||
                          "继续按原有测试优化AI 团队实现并保留全部参考测试",
                        max_attempts: 2,
                        offline: false,
                        resume_run_id: e.id,
                      }),
                    }),
                  )
                }
              >
                从此版本继续优化
              </Button>
            )}
          {e.result.worker_ids && (
            <p>
              已保存的 IT 员工工程：
              {e.result.worker_ids.map((id, i) => (
                <a
                  key={id}
                  style={{ marginRight: 12 }}
                  href={`#/projects/${projectId}/evidence?employee=${id}`}
                >
                  员工 {i + 1}
                </a>
              ))}
            </p>
          )}
          {e.result.worker_install_error && (
            <Alert type="warning" message={e.result.worker_install_error} />
          )}
          {e.result.plan && (
            <details className="source-form">
              <summary>需求、架构与员工操作方案</summary>
              <pre>{JSON.stringify(e.result.plan, null, 2)}</pre>
            </details>
          )}
          {e.kind !== "delivery" &&
            e.result.attempts?.map((a, i) => (
              <details className="source-form" key={i}>
                <summary>第 {i + 1} 轮实际测试结果</summary>
                <pre>{JSON.stringify(a, null, 2)}</pre>
              </details>
            ))}
          {e.result.employee_id && (
            <EmployeeTrial
              employeeId={e.result.employee_id}
              disabled={
                working ||
                evaluations.some((r) =>
                  ["queued", "running"].includes(r.status),
                )
              }
              onStarted={refresh}
            />
          )}
          {e.result.employee_id && (
            <p>
              已自动登记员工：
              <a
                href={`#/projects/${projectId}/evidence?employee=${e.result.employee_id}`}
              >
                打开员工工程
              </a>{" "}
              ·{" "}
              <a href={`/api/employees/${e.result.employee_id}/export`}>
                下载工程
              </a>
            </p>
          )}
          {e.result.checks?.map((c) => (
            <div className="evaluation-check" key={c.id}>
              <strong>{labels[c.id] || c.id}</strong>
              <Tag
                color={
                  c.status === "pass"
                    ? "green"
                    : c.status === "fail"
                      ? "red"
                      : "orange"
                }
              >
                {labels[c.status]}
              </Tag>
              <p>{c.reason}</p>
              <small>{c.evidence.join(" · ")}</small>
              <p>{c.improvement}</p>
            </div>
          ))}
          {e.result.output !== undefined && (
            <>
              <p>
                退出码：{e.result.exit_code} · {e.result.command?.join(" ")}
              </p>
              <pre>{e.result.output}</pre>
            </>
          )}
          {e.result.artifacts?.map((a) => (
            <details className="source-form" key={a.path}>
              <summary>
                {a.path} · {a.sha256.slice(0, 12)}
              </summary>
              <pre>{a.content}</pre>
            </details>
          ))}
          {e.result.manifest && (
            <details className="source-form">
              <summary>run-manifest.json · 平台交接清单</summary>
              <pre>{JSON.stringify(e.result.manifest, null, 2)}</pre>
            </details>
          )}
          {e.kind === "requirements" &&
            !!e.result.artifacts?.length &&
            !e.result.manifest &&
            ["blocked", "completed"].includes(e.status) && (
              <Button
                disabled={working}
                onClick={() =>
                  void act(() =>
                    api(`/evaluations/${e.id}/manifest`, { method: "POST" }),
                  )
                }
              >
                补全平台交接清单
              </Button>
            )}
          {e.result.open_questions?.length ? (
            <ul>
              {e.result.open_questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          ) : null}
          {e.result.employee_improvements?.length ? (
            <>
              <h4>员工改进项</h4>
              <ul>
                {e.result.employee_improvements.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          ) : null}
          {e.result.next_iteration && (
            <>
              <h4>下一轮改进建议</h4>
              <p>{e.result.next_iteration}</p>
              <Button
                disabled={e.design_version !== version || working}
                onClick={() =>
                  onImprove(
                    `根据独立评估 ${e.id}（方案版本 ${e.design_version}）优化当前AI 团队与员工。保留岗位key和已有人工修改，不声称运行通过。\n${JSON.stringify(e.result, null, 2).slice(0, 10000)}`,
                  )
                }
              >
                带着评估结果继续优化
              </Button>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
