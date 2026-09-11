import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Table } from "antd";
import { CodeOutlined, FileTextOutlined } from "@ant-design/icons";
import { api } from "../api";
export type OutputFile = { path: string; description?: string; size?: number };
export function cleanOutputText(text: string, root: string) {
  return text
    .replaceAll(root || "\u0000", "当前任务")
    .replace(
      /\/(?:Users|private|tmp|var|home)\/[^\s`）)]+/g,
      (p) => p.split("/").pop() || "",
    )
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(?:nodes|outputs)\/[^\s`）)]+/g, (p) => p.split("/").pop() || "");
}
export function documentSummary(text: string) {
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)]
    .map((m) => m[1].replace(/^[\d.]+\s*/, "").trim())
    .filter((h) => !/(已加载|规则路径|指令来源)/.test(h));
  if (headings.length > 1)
    return `${headings[0]}，涵盖${headings.slice(1, 7).join("、")}。`.slice(
      0,
      240,
    );
  return (
    text
      .replace(/^#+\s*/gm, "")
      .split(/\n\s*\n/)
      .find((p) => p.trim() && !p.trim().startsWith("```"))
      ?.replace(/\s+/g, " ")
      .slice(0, 240) || "暂无可提取的文档摘要"
  );
}
export function executionSummary(
  text: string,
  files: OutputFile[],
  root: string,
) {
  const names = files.map((f) => f.path.split("/").pop()!);
  return cleanOutputText(text, root)
    .split("\n")
    .filter((line) => {
      const content = line.trim().replace(/^[*#\s-]+/, "");
      return !(
        /^(产物|输出文件|成果文件|文件列表)[：:]/.test(content) &&
        names.some((name) => content.includes(name))
      );
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export default function ExecutionOutput({
  projectId,
  runId,
  root,
  editorRoot,
  status,
  summary,
  error,
  files,
}: {
  projectId: string;
  runId: string;
  root: string;
  editorRoot?: string | null;
  status: string;
  summary?: string;
  error?: string;
  files: OutputFile[];
}) {
  const [selected, setSelected] = useState<string>(),
    [preview, setPreview] = useState(""),
    [problem, setProblem] = useState(""),
    [opening, setOpening] = useState<string>();
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const missingKey = JSON.stringify(
    files.filter((f) => !f.description).map((f) => f.path),
  );
  useEffect(() => {
    let alive = true;
    setSummaries({});
    const paths: string[] = JSON.parse(missingKey);
    let cursor = 0;
    const worker = async () => {
      while (cursor < paths.length) {
        const file = paths[cursor++];
        try {
          const data = await api<{ text: string | null }>(
            `/workspaces/${projectId}/file?run_id=${runId}&path=${encodeURIComponent(file)}`,
          );
          if (alive)
            setSummaries((old) => ({
              ...old,
              [file]: data.text
                ? documentSummary(data.text)
                : "暂无文档摘要，点击文件查看",
            }));
        } catch {
          if (alive)
            setSummaries((old) => ({
              ...old,
              [file]: "摘要读取失败，点击文件查看",
            }));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, paths.length) }, worker));
    return () => {
      alive = false;
    };
  }, [projectId, runId, missingKey]);
  const path = files.some((f) => f.path === selected) ? selected : undefined;
  useEffect(() => {
    let alive = true;
    setPreview("");
    setProblem("");
    if (!path) return;
    api<{ text: string | null; reason?: string }>(
      `/workspaces/${projectId}/file?run_id=${runId}&path=${encodeURIComponent(path)}`,
    )
      .then((d) => {
        if (alive) setPreview(d.text ?? d.reason ?? "此格式可在本地查看");
      })
      .catch(
        () => alive && setProblem("文件读取失败，可关闭后重试或在本地查看"),
      );
    return () => {
      alive = false;
    };
  }, [projectId, runId, path]);
  const fallback =
    status === "completed"
      ? `执行完成，已提交 ${files.length} 份成果。`
      : status === "failed"
        ? "执行失败，已生成的文件保留如下。"
        : status === "waiting_human"
          ? "执行遇到卡点，需要补充信息后继续。"
          : ["cancelled", "interrupted"].includes(status)
            ? "执行已停止或中断，当前产物保留如下。"
            : "执行尚未结束，已提交的产物会显示在这里。";
  const folder = editorRoot === undefined ? root : editorRoot;
  const folderUri = folder
    ? `vscode://file${folder.split("/").map(encodeURIComponent).join("/")}`
    : undefined;
  const uri = (file?: string) =>
    `vscode://file${`${root}${file ? "/" + file : ""}`.split("/").map(encodeURIComponent).join("/")}`;
  const description = (f: OutputFile) =>
    f.description || summaries[f.path] || "正在读取文档摘要…";
  const size = (bytes?: number) =>
    bytes === undefined
      ? "—"
      : bytes < 1024
        ? `${bytes} B`
        : `${(bytes / 1024).toFixed(1)} KB`;
  async function openLocal(file: string) {
    setOpening(file);
    setProblem("");
    try {
      await api(`/workspaces/${projectId}/agent-runs/${runId}/open-local`, {
        method: "POST",
        body: JSON.stringify({ path: file }),
      });
    } catch {
      setProblem("本地打开失败，请检查服务是否运行在这台 Mac 上");
    } finally {
      setOpening(undefined);
    }
  }
  return (
    <section className="execution-output">
      <h3>执行总结</h3>
      <p className="task-text">
        {executionSummary(summary || fallback, files, root)}
      </p>
      {error && ["failed", "interrupted", "cancelled"].includes(status) && <Alert type="error" message={cleanOutputText(error, root)} />}
      <div className="output-files-header">
        <h3>
          输出文件 <small>{files.length}</small>
        </h3>
        <Button
          aria-label="VS Code 打开"
          icon={<CodeOutlined />}
          href={folderUri}
          disabled={!folder}
        >
          VS Code 打开
        </Button>
      </div>
      {problem && !path && <Alert type="warning" message={problem} />}
      <div className="output-files-table">
        <Table<OutputFile>
          rowKey="path"
          size="small"
          pagination={false}
          dataSource={files}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无输出文件"
              />
            ),
          }}
          columns={[
            {
              title: "文件名",
              key: "name",
              render: (_, file) => (
                <Button
                  type="link"
                  icon={<FileTextOutlined />}
                  onClick={() => setSelected(file.path)}
                >
                  {file.path.split("/").pop()}
                </Button>
              ),
            },
            {
              title: "文档摘要",
              key: "purpose",
              render: (_, file) => (
                <span className="output-file-purpose">
                  {cleanOutputText(description(file), root)}
                </span>
              ),
            },
            {
              title: "大小",
              key: "size",
              width: 90,
              render: (_, file) => size(file.size),
            },
            {
              title: "操作",
              key: "actions",
              width: 100,
              render: (_, file) => (
                <Button
                  type="text"
                  size="small"
                  loading={opening === file.path}
                  onClick={() => void openLocal(file.path)}
                >
                  本地打开
                </Button>
              ),
            },
          ]}
        />
      </div>
      <Drawer
        title={path?.split("/").pop()}
        open={!!path}
        onClose={() => setSelected(undefined)}
        width="min(100vw, max(50vw, 520px))"
        extra={
          <Button href={path ? uri(path) : undefined} icon={<CodeOutlined />}>
            VS Code 打开
          </Button>
        }
      >
        {problem ? (
          <Alert type="warning" message={problem} />
        ) : (
          <pre className="task-file-preview">{preview || "正在读取文件…"}</pre>
        )}
      </Drawer>
    </section>
  );
}
