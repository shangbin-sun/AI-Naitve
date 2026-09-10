import { useState } from "react";
import { Button, Space } from "antd";
import {
  EditOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  UserOutlined,
  ArrowRightOutlined,
  LoginOutlined,
  LogoutOutlined,
} from "@ant-design/icons";
import type { Draft, Member } from "../types";
import "./workflow.css";

const DEFAULT_HUMAN = "@project_owner";

export function employeeGraph(draft: Draft) {
  const ai = draft.members.filter((m) => m.kind === "ai");
  const humans = draft.members.filter((m) => m.kind === "human");
  const routing = draft.human_routing;
  const defaultOwner =
    routing?.default_owner || humans[0]?.key || DEFAULT_HUMAN;
  const assignments = Object.fromEntries(
    ai.map((m) => [m.key, routing?.assignments?.[m.key] || defaultOwner]),
  );
  if (
    !humans.length ||
    defaultOwner === DEFAULT_HUMAN ||
    Object.values(assignments).includes(DEFAULT_HUMAN)
  ) {
    humans.unshift({
      key: DEFAULT_HUMAN,
      name: "AI 团队负责人（你）",
      kind: "human",
      role: "处理需要人工判断、补充信息或确认的问题",
      responsibilities: [],
      instructions: "",
      skills: [],
      inputs: [],
      outputs: [],
    });
  }
  // Project step dependencies onto employees, traversing intermediate human steps.
  // Repeated work by one employee remains one card; no invented sequential edges.
  const steps = new Map(draft.workflow.map((s) => [s.key, s]));
  const aiKeys = new Set(ai.map((m) => m.key));
  const edges = new Map<string, { from: string; to: string }>();
  for (const step of draft.workflow) {
    if (!aiKeys.has(step.owner)) continue;
    const visited = new Set<string>();
    const walk = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const upstream = steps.get(key);
      if (!upstream) return;
      if (aiKeys.has(upstream.owner) && upstream.owner !== step.owner) {
        edges.set(`${upstream.owner}:${step.owner}`, {
          from: upstream.owner,
          to: step.owner,
        });
      } else upstream.depends_on.forEach(walk);
    };
    step.depends_on.forEach(walk);
  }
  const allEdges = [...edges.values()];
  const roots = draft.workflow.filter((step) => !step.depends_on.length);
  const leaves = draft.workflow.filter(
    (step) =>
      !draft.workflow.some((other) => other.depends_on.includes(step.key)),
  );
  // Resolve actual boundary steps through human work, including repeated AI work.
  const boundaryOwners = (boundary: typeof roots, forward: boolean) => {
    const owners = new Set<string>();
    const visited = new Set<string>();
    const walk = (step: (typeof roots)[number]) => {
      if (visited.has(step.key)) return;
      visited.add(step.key);
      if (aiKeys.has(step.owner)) owners.add(step.owner);
      else if (forward)
        draft.workflow
          .filter((next) => next.depends_on.includes(step.key))
          .forEach(walk);
      else
        step.depends_on.forEach((key) => {
          const previous = steps.get(key);
          if (previous) walk(previous);
        });
    };
    boundary.forEach(walk);
    if (!owners.size)
      ai.filter(
        (employee) =>
          !allEdges.some(
            (edge) => (forward ? edge.to : edge.from) === employee.key,
          ),
      ).forEach((employee) => owners.add(employee.key));
    if (!owners.size && ai.length)
      owners.add(ai[forward ? 0 : ai.length - 1].key);
    return [...owners];
  };
  return {
    ai,
    humans,
    assignments,
    defaultOwner,
    edges: allEdges,
    entries: boundaryOwners(roots, true),
    exits: boundaryOwners(leaves, false),
    inputs: [...new Set(roots.map((step) => step.input).filter(Boolean))],
    outputs: [...new Set(leaves.map((step) => step.output).filter(Boolean))],
  };
}

export default function EmployeeWorkflow({
  draft,
  onEmployee,
  onQuestion,
  onRun,
}: {
  draft: Draft;
  onEmployee?: (member: Member) => void;
  onQuestion?: (question: string) => void;
  onRun?: (employee?: string) => void;
}) {
  const graph = employeeGraph(draft);
  const [selected, setSelected] = useState<string | null>(null);
  const select = (key: string) =>
    setSelected((current) => (current === key ? null : key));
  const name = (key: string) =>
    draft.members.find((m) => m.key === key)?.name || key;
  const width = Math.max(graph.ai.length + 2, graph.humans.length) * 300 + 40;
  const offset = (width - (graph.ai.length + 2) * 300) / 2;
  const endpoint =
    selected === "@input" || selected === "@output" ? selected : null;
  const endpointItems = endpoint === "@input" ? graph.inputs : graph.outputs;
  return (
    <section className="employee-workflow" aria-label="员工协作工作流">
      <div className="employee-workflow-heading">
        <div>
          <h3>员工协作</h3>
          <p>AI 员工协作完成工作，需要人工处理的问题向上交接。</p>
        </div>
        <Space wrap>
        {onQuestion && (
          <Button aria-label="优化团队" icon={<EditOutlined />} onClick={() => onQuestion("请帮我优化当前团队的员工协作与人工分工。")}>优化</Button>
        )}
        {onRun && <Button type="primary" aria-label="执行团队" icon={<PlayCircleOutlined />} disabled={!graph.ai.length} onClick={()=>onRun()}>执行</Button>}
        </Space>
      </div>
      <div className="workflow-canvas" aria-label="员工协作节点图">
        <div className="workflow-canvas-legend">
          <span>
            <i /> 工作交接
          </span>
          <span>
            <i className="human" /> 人工支持
          </span>
          <span>点击节点查看详情</span>
        </div>
        <div className="workflow-canvas-scroll">
          <div className="workflow-canvas-stage" style={{ width: width }}>
            <svg
              className="workflow-canvas-lines"
              width="100%"
              height="470"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="workflow-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#8997ce" />
                </marker>
              </defs>
              {graph.ai.map((employee, index) => {
                const x =
                  (width - graph.ai.length * 300) / 2 + index * 300 + 150;
                const humanIndex = graph.humans.findIndex(
                  (human) => human.key === graph.assignments[employee.key],
                );
                const targetX =
                  (width - graph.humans.length * 300) / 2 +
                  humanIndex * 300 +
                  150;
                return (
                  <path
                    key={employee.key}
                    className="human-edge"
                    d={`M ${x} 282 C ${x} 225, ${targetX} 235, ${targetX} 180`}
                  />
                );
              })}
              {graph.edges.map((edge) => {
                const offset = (width - graph.ai.length * 300) / 2;
                const source = graph.ai.findIndex(
                  (employee) => employee.key === edge.from,
                );
                const target = graph.ai.findIndex(
                  (employee) => employee.key === edge.to,
                );
                const x1 = offset + source * 300 + 280;
                const x2 = offset + target * 300 + 20;
                const adjacent = target === source + 1;
                return (
                  <path
                    key={`${edge.from}:${edge.to}`}
                    className="work-edge"
                    markerEnd="url(#workflow-arrow)"
                    d={
                      adjacent
                        ? `M ${x1} 356 C ${x1 + 16} 356, ${x2 - 16} 356, ${x2} 356`
                        : `M ${x1} 356 C ${x1 + 32} 490, ${x2 - 32} 490, ${x2} 356`
                    }
                  />
                );
              })}
              {graph.entries.map((key) => {
                const target = graph.ai.findIndex(
                  (employee) => employee.key === key,
                );
                const x1 = offset + 280;
                const x2 = offset + (target + 1) * 300 + 20;
                return (
                  <path
                    key={`input:${key}`}
                    className="work-edge"
                    markerEnd="url(#workflow-arrow)"
                    d={
                      target === 0
                        ? `M ${x1} 356 L ${x2} 356`
                        : `M ${x1} 356 C ${x1 + 20} 230, ${x2 - 20} 230, ${x2} 356`
                    }
                  />
                );
              })}
              {graph.exits.map((key) => {
                const source = graph.ai.findIndex(
                  (employee) => employee.key === key,
                );
                const x1 = offset + (source + 1) * 300 + 280;
                const x2 = offset + (graph.ai.length + 1) * 300 + 20;
                return (
                  <path
                    key={`${key}:output`}
                    className="work-edge"
                    markerEnd="url(#workflow-arrow)"
                    d={
                      source === graph.ai.length - 1
                        ? `M ${x1} 356 L ${x2} 356`
                        : `M ${x1} 356 C ${x1 + 20} 490, ${x2 - 20} 490, ${x2} 356`
                    }
                  />
                );
              })}
            </svg>
            <div className="workflow-node-row humans">
              {graph.humans.map((human) => (
                <button
                  key={human.key}
                  className={`workflow-node human-node ${selected === human.key ? "selected" : ""}`}
                  onClick={() => {
                    setSelected(null);
                    if (human.key !== DEFAULT_HUMAN) onEmployee?.(human);
                    else onQuestion?.("请帮我调整AI 团队负责人及人工分工。");
                  }}
                >
                  <span className="workflow-node-type">
                    人类员工{" "}
                    <span>
                      {human.key === graph.defaultOwner
                        ? "默认负责人"
                        : "专业支持"}
                    </span>
                  </span>
                  <span className="workflow-node-title">
                    <span className="workflow-avatar human">
                      <UserOutlined />
                    </span>
                    <strong>{human.name}</strong>
                  </span>
                  <span className="workflow-node-description">
                    {human.role}
                  </span>
                  <span className="workflow-node-footer">
                    支持{" "}
                    {
                      graph.ai.filter(
                        (employee) =>
                          graph.assignments[employee.key] === human.key,
                      ).length
                    }{" "}
                    位 AI 员工{" "}
                    <span>
                      查看详情 <ArrowRightOutlined />
                    </span>
                  </span>
                  <i className="workflow-port bottom" />
                </button>
              ))}
            </div>
            <div className="workflow-node-row employees">
              <button
                className={`workflow-node boundary-node ${selected === "@input" ? "selected" : ""}`}
                aria-expanded={selected === "@input"}
                onClick={() => select("@input")}
              >
                <span className="workflow-node-type">流程起点</span>
                <span className="workflow-node-title">
                  <span className="workflow-avatar">
                    <LoginOutlined />
                  </span>
                  <strong>输入</strong>
                </span>
                <span className="workflow-node-description">
                  目标、资料与任务要求
                </span>
                <span className="workflow-node-footer">
                  查看输入 <ArrowRightOutlined />
                </span>
                <i className="workflow-port right" />
              </button>
              {graph.ai.map((employee) => (
                <div className="workflow-node-shell" key={employee.key}>
                <button
                  aria-label={`${employee.name} 查看详情`}
                  className={`workflow-node ai-node ${selected === employee.key ? "selected" : ""}`}
                  onClick={() => {
                    setSelected(null);
                    onEmployee?.(employee);
                  }}
                >
                  <i className="workflow-port top" />
                  <i className="workflow-port left" />
                  <i className="workflow-port right" />
                  <span className="workflow-node-type">
                    AI 员工{" "}
                    <span>
                      {
                        draft.workflow.filter(
                          (step) => step.owner === employee.key,
                        ).length
                      }{" "}
                      项内部工作
                    </span>
                  </span>
                  <span className="workflow-node-title">
                    <span className="workflow-avatar">
                      <RobotOutlined />
                    </span>
                    <strong>{employee.name}</strong>
                  </span>
                  <span className="workflow-node-description">
                    {employee.role}
                  </span>
                  <span className="workflow-node-footer">
                    {!onRun && !onQuestion && <>查看详情 <ArrowRightOutlined /></>}
                  </span>
                </button>
                {(onQuestion || onRun) && <div className="workflow-node-actions">
                  {onQuestion && <button aria-label={`优化 ${employee.name}`} onClick={()=>onQuestion(`请帮我优化员工「${employee.name}」（${employee.key}）的职责、指令、输入输出与验收要求，保留其他员工的配置。`)}><EditOutlined /> 优化</button>}
                  {onRun && <button className="primary" aria-label={`单独执行 ${employee.name}`} onClick={()=>onRun(employee.key)}><PlayCircleOutlined /> 执行</button>}
                </div>}
                </div>
              ))}
              <button
                className={`workflow-node boundary-node output-node ${selected === "@output" ? "selected" : ""}`}
                aria-expanded={selected === "@output"}
                onClick={() => select("@output")}
              >
                <span className="workflow-node-type">流程终点</span>
                <span className="workflow-node-title">
                  <span className="workflow-avatar">
                    <LogoutOutlined />
                  </span>
                  <strong>输出</strong>
                </span>
                <span className="workflow-node-description">
                  汇总结果与最终交付
                </span>
                <span className="workflow-node-footer">
                  查看输出 <ArrowRightOutlined />
                </span>
                <i className="workflow-port left" />
              </button>
            </div>
            {!graph.ai.length && (
              <p className="workflow-canvas-empty">
                告诉AI 团队助手你的目标，即可生成协作的 AI 员工。
              </p>
            )}
          </div>
        </div>
        {graph.edges.length > 0 && (
          <div className="workflow-canvas-summary" aria-label="员工交接关系">
            {graph.edges.map((edge) => (
              <span key={`${edge.from}:${edge.to}`}>
                {name(edge.from)} → {name(edge.to)}
              </span>
            ))}
          </div>
        )}
      </div>
      {endpoint && (
        <section
          className="workflow-detail"
          aria-label={endpoint === "@input" ? "流程输入详情" : "流程输出详情"}
        >
          <div className="workflow-detail-heading">
            <strong>{endpoint === "@input" ? "流程输入" : "流程输出"}</strong>
            <button
              className="workflow-text-button"
              onClick={() => setSelected(null)}
            >
              收起
            </button>
          </div>
          {endpoint === "@input" && <p>AI 团队目标：{draft.goal}</p>}
          {endpointItems.length ? (
            endpointItems.map((item, index) => <p key={index}>{item}</p>)
          ) : (
            <p>
              {endpoint === "@input"
                ? "待补充任务资料与输入要求。"
                : "待明确最终交付内容。"}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
