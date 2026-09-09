import type { TaskRun } from "./types";
export type OutputFile = { name: string; content?: string };
export type OutputStep = {
  id: string;
  title: string;
  worker: string;
  workerKey?: string;
  origin: string;
  reused: boolean;
  state: string;
  input: string;
  handoff: string;
  files: OutputFile[];
};

/** Reconstruct only evidence present in this task's runs, never assign by employee name. */
export function outputChain(selected: TaskRun, runs: TaskRun[]) {
  const lineage: TaskRun[] = [];
  const seen = new Set<string>();
  let cursor: TaskRun | undefined = selected;
  let missing = false;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    lineage.unshift(cursor);
    const parent: string | undefined = cursor.inputs.resume_run_id;
    if (!parent) break;
    cursor = runs.find((r) => r.id === parent);
    if (!cursor || seen.has(parent)) {
      missing = true;
      break;
    }
  }
  const steps: OutputStep[] = [];
  const text = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  function worker(r: TaskRun, key: string, label: string) {
    const captured = r.inputs.employees?.find((e) => e.key === key);
    return captured
      ? `${captured.profile?.name ?? key} · v${captured.version}（运行岗位）`
      : `${label} · 历史未绑定具体员工`;
  }
  for (const r of lineage) {
    const reused = r.id !== selected.id;
    const origin = r.id;
    const add = (
      id: string,
      title: string,
      person: string,
      state: string,
      input: string,
      files: OutputFile[],
    ) =>
      steps.push({
        id: `${r.id}-${id}`,
        title,
        worker: person,
        workerKey:
          person === worker(r, "it_analysis", "需求与架构岗位") &&
          r.inputs.employees?.some((e) => e.key === "it_analysis")
            ? "it_analysis"
            : person === worker(r, "it_development", "开发岗位") &&
                r.inputs.employees?.some((e) => e.key === "it_development")
              ? "it_development"
              : undefined,
        origin,
        reused,
        state,
        input,
        files,
        handoff: "",
      });
    add(
      "input",
      r.inputs.resume_run_id ? "接收上轮代码与本轮要求" : "任务输入",
      "任务发起人 / 平台",
      "已保存",
      r.inputs.resume_run_id
        ? "上轮代码产物 + 当前任务输入"
        : "任务说明 + 选定源码与公共资料",
      [
        {
          name: "任务说明与验收要求",
          content: text(
            r.inputs.task_snapshot ?? { source: r.inputs.code_source_id },
          ),
        },
      ],
    );
    const attempts = r.result.attempts ?? [];
    const baseline = attempts.find((a) => a.attempt === 0);
    function test(
      a: NonNullable<TaskRun["result"]["attempts"]>[number],
      label: string,
    ) {
      const passed =
        a.exit_code === 0 &&
        !!a.tests?.executed &&
        !a.tests.failed &&
        !a.tests.skipped &&
        !a.tests.missing_reference_classes?.length;
      add(
        `test-${a.attempt}`,
        label,
        "平台测试执行器",
        passed ? "通过" : a.tests?.executed ? "未通过" : "受阻 / 未执行",
        a.attempt === 0
          ? r.inputs.resume_run_id
            ? "上轮已修复代码 + 原有测试"
            : "输入源码 + 原有测试"
          : `开发员工第 ${a.attempt} 轮代码 + 原有测试`,
        [
          {
            name: `测试报告 · ${a.tests?.passed ?? 0}/${a.tests?.executed ?? 0} 通过`,
            content: text(a.tests ?? { error: a.error ?? "没有测试报告" }),
          },
          { name: "执行日志", content: a.output ?? a.error ?? "暂无日志" },
        ],
      );
    }
    if (baseline)
      test(baseline, r.inputs.resume_run_id ? "本轮复测" : "基线测试");
    // A resumed passing run copies previous_plan; it is not new work.
    const newPlan =
      r.result.plan && (!r.inputs.previous_plan || !!r.result.planning_usage);
    if (newPlan)
      add(
        "analysis",
        "需求分析与架构设计",
        worker(r, "it_analysis", "需求与架构岗位"),
        "已产出",
        "任务目标 + 源码 + 基线失败报告",
        [{ name: "需求与架构方案", content: text(r.result.plan) }],
      );
    const changes = attempts.filter((a) => a.attempt > 0);
    changes.forEach((a, index) => {
      const files =
        a.artifacts ??
        (index === changes.length - 1 && !a.error && r.status === "completed"
          ? r.result.artifacts
          : undefined);
      add(
        `develop-${a.attempt}`,
        `代码开发 · 第 ${a.attempt} 轮`,
        worker(r, "it_development", "开发岗位"),
        a.error ? "补丁被拒绝" : "已产出",
        a.attempt === 1
          ? "需求与架构方案 + 基线失败报告"
          : `上轮代码 + 第 ${a.attempt - 1} 轮测试反馈`,
        [
          {
            name: "开发说明",
            content: a.summary ?? a.error ?? "历史未保存开发说明",
          },
          ...(files?.map((f) => ({ name: f.path, content: f.content })) ??
            (a.changed_files ?? []).map((name) => ({ name }))),
        ],
      );
      if (a.tests || a.exit_code !== undefined)
        test(a, `测试验证 · 第 ${a.attempt} 轮`);
    });
    // Persisted patch precedes completion of its test subprocess.
    if (!changes.length && r.result.artifacts?.length)
      add(
        "pending-code",
        "代码开发",
        worker(r, "it_development", "开发岗位"),
        "等待测试结果",
        "需求与架构方案 + 测试反馈",
        r.result.artifacts.map((f) => ({ name: f.path, content: f.content })),
      );
    if (["running", "queued"].includes(r.status))
      add(
        "active",
        "当前执行中",
        r.result.stage === "develop"
          ? worker(r, "it_development", "开发岗位")
          : r.result.stage === "analyze"
            ? worker(r, "it_analysis", "需求与架构岗位")
            : "平台执行器",
        "执行中",
        "已完成环节的输出",
        [],
      );
    if (["failed", "cancelled", "interrupted", "blocked"].includes(r.status))
      add(
        "stop",
        "本轮结束 / 等待处理",
        "平台",
        r.status === "cancelled" ? "已停止" : "需要处理",
        "本轮执行结果",
        [
          {
            name: "结束原因",
            content: r.error || r.result.summary || "查看执行日志",
          },
        ],
      );
  }
  steps.forEach(
    (s, index) =>
      (s.handoff = steps[index + 1]
        ? `${steps[index + 1].worker} → ${steps[index + 1].title}`
        : "当前任务成果；部署尚未执行"),
  );
  return { steps, missing };
}
