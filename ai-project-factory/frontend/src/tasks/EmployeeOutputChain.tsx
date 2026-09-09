import { useState } from "react";
import { Alert, Button, Tag } from "antd";
import {
  FileTextOutlined,
  CodeOutlined,
  FolderOpenOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { useWebEditor } from "./useWebEditor";
import EmployeeDirectoryFiles from "./EmployeeDirectoryFiles";
import OutputFileBrowser from "./OutputFileBrowser";
import { outputChain, type OutputStep } from "./buildOutputChain";
import type { TaskRun } from "./types";
import "./output-chain.css";

export default function OutputChain({
  run,
  runs,
  workspaceBase,
}: {
  run: TaskRun;
  runs: TaskRun[];
  workspaceBase?: string;
}) {
  const editor = useWebEditor(workspaceBase);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [browser, setBrowser] = useState<{ key: string; file?: string } | null>(
    null,
  );
  const { steps, missing } = outputChain(run, runs);
  const groups = new Map<string, { name: string; steps: OutputStep[] }>();
  for (const step of steps) {
    // Task input and scheduler events are available in their own tabs.
    if (
      !step.files.length ||
      step.id.endsWith("-input") ||
      step.id.endsWith("-stop")
    )
      continue;
    const key = step.workerKey ?? step.worker;
    const group = groups.get(key) ?? {
      name: step.worker.split(" · ")[0],
      steps: [],
    };
    group.steps.push(step);
    groups.set(key, group);
  }
  const employees = [...groups.entries()].filter(
    ([key]) => key !== "平台测试执行器",
  );
  const platform = groups.get("平台测试执行器");
  const unassigned =
    run.inputs.team_snapshot?.filter((e) => !groups.has(e.key)) ?? [];
  const activeGroup = browser ? groups.get(browser.key) : undefined;
  if (activeGroup)
    return (
      <OutputFileBrowser
        name={activeGroup.name}
        steps={activeGroup.steps}
        selected={browser?.file}
        onSelect={(file) => setBrowser({ key: browser!.key, file })}
        onBack={() => setBrowser(null)}
      />
    );
  return (
    <section className="employee-output-list">
      <div className="employee-output-heading">
        <h3>产出链条</h3>
        <span>按员工查看产出文件</span>
      </div>
      <p className="employee-output-note">
        点击文件或文件夹进入网页版 VS Code，编辑工作副本；历史快照保留。
      </p>
      {editor.error && <Alert type="error" message={editor.error} />}
      {editor.url && (
        <a href={editor.url} target="_blank" rel="noopener noreferrer">
          打开网页版 VS Code（若新标签页未弹出，点击这里）
        </a>
      )}
      {missing && (
        <Alert
          type="warning"
          message="部分前序运行不可用，相关历史产出无法展示。"
        />
      )}
      {employees.length === 0 && <p>当前尚无员工产出。</p>}
      <div className="employee-attachment-grid">
        {employees.map(([key, group], index) => {
          const files = group.steps.flatMap((step) =>
            step.files.map((file, i) => ({
              step,
              file,
              id: `${step.id}-${i}`,
            })),
          );
          const showAll = expanded.has(key);
          return (
            <article className="employee-attachment-card" key={key}>
              <header>
                <h4>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {group.name}
                </h4>
                <Button
                  type="text"
                  icon={<FolderOpenOutlined />}
                  aria-label={`打开${group.name}产出目录`}
                  title="在网页版 VS Code 中打开目录"
                  disabled={editor.opening || !workspaceBase}
                  onClick={() =>
                    editor.open(group.steps[group.steps.length - 1])
                  }
                />
              </header>
              <Button
                type="link"
                size="small"
                onClick={() => setBrowser({ key })}
              >
                查看原始记录
              </Button>
              {workspaceBase ? <EmployeeDirectoryFiles steps={group.steps} base={workspaceBase} open={editor.open} busy={editor.opening} /> : <>
              <div className="employee-attachment-caption">
                产出文件 · {files.length}
                {group.steps.some((s) => s.worker.includes("历史未绑定")) && (
                  <span title="历史未绑定具体员工，按实际执行岗位归类">
                    {" "}
                    · 历史未绑定具体员工
                  </span>
                )}
              </div>
              <ul className="employee-attachment-files">
                {(showAll ? files : files.slice(0, 3)).map(
                  ({ step, file, id }) => (
                    <li key={id}>
                      <button
                        type="button"
                        className="employee-attachment-link"
                        aria-label={`打开文件 ${file.name}`}
                        title={`${file.name} · ${step.title} · ${step.reused ? "历史产出" : "本轮产出"} · ${step.origin.slice(0, 8)}${file.content === undefined ? " · 正文未保存" : ""}`}
                        disabled={
                          editor.opening ||
                          file.content === undefined ||
                          !workspaceBase
                        }
                        onClick={() => editor.open(step, file.name)}
                      >
                        <span className="employee-attachment-icon">
                          {file.name.includes(".") ? (
                            <CodeOutlined />
                          ) : (
                            <FileTextOutlined />
                          )}
                        </span>
                        <span className="employee-attachment-name">
                          {file.name}
                        </span>
                      </button>
                      {showAll && (
                        <div className="employee-attachment-meta">
                          {step.title} · {step.reused ? "历史" : "本轮"} ·{" "}
                          {step.origin.slice(0, 8)}
                          {file.content === undefined ? " · 正文未保存" : ""}
                        </div>
                      )}
                    </li>
                  ),
                )}
              </ul>
              <button
                className="employee-attachment-all"
                type="button"
                aria-label={showAll ? "收起" : `查看全部（${files.length}）`}
                aria-expanded={showAll}
                onClick={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                <UnorderedListOutlined />
                {showAll ? "收起" : `查看全部（${files.length}）`}
              </button>
              </>}
            </article>
          );
        })}
      </div>
      {platform && (
        <article className="employee-output-group employee-platform-output">
          <header>
            <h4>平台测试结果</h4>
            <Tag>自动执行</Tag>
          </header>
          <div className="employee-test-list">
            {platform.steps.map((step) => (
              <div key={step.id}>
                <strong>{step.files[0]?.name}</strong>
                <span>
                  {step.title} · {step.reused ? "历史" : "本轮"} ·{" "}
                  {step.origin.slice(0, 8)}
                </span>
              </div>
            ))}
          </div>
          <p className="employee-output-note">
            完整测试数据与日志见「测试与运行详情」和「执行日志」。
          </p>
        </article>
      )}
      {unassigned.length > 0 && (
        <div className="employee-output-empty">
          <strong>尚无个人产出记录</strong>
          <p>{unassigned.map((e) => e.profile?.name ?? e.key).join("、")}</p>
        </div>
      )}
      <p className="employee-output-note">部署尚未接通，暂无部署产出。</p>
    </section>
  );
}
