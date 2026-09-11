import { useEffect, useRef, useState } from "react";
import { Alert, Button, Spin, Input, message, Drawer } from "antd";
import {
  FolderOutlined,
  FileTextOutlined,
  ArrowUpOutlined,
  ReloadOutlined,
  CodeOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import { api } from "./api";
import "./workspace-browser.css";

type Entry = { name: string; path: string; directory: boolean };
type Listing = { root: string; label: string; entries: Entry[] };
export default function WorkspaceBrowser({
  projectId,
  runId,
  node,
}: {
  projectId: string;
  runId?: string;
  node?: string;
}) {
  const [messageApi, messageContext] = message.useMessage();
  const [path, setPath] = useState(""),
    [version, refresh] = useState(0);
  const [data, setData] = useState<Listing>(),
    [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    name: string;
    text: string | null;
    reason?: string;
    editable?: boolean;
    version?: number;
    path: string;
  }>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const suffix = runId ? `&run_id=${encodeURIComponent(runId)}${node ? `&node=${encodeURIComponent(node)}` : ""}` : "";
  useEffect(() => {
    let current = true;
    request.current += 1;
    setBusy(true);
    setError("");
    setPreview(undefined);
    setEditing(false);
    api<Listing>(
      `/workspaces/${projectId}/files?path=${encodeURIComponent(path)}${suffix}`,
    )
      .then((value) => {
        if (current) setData(value);
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
      request.current += 1;
    };
  }, [projectId, suffix, path, version]);
  async function open(entry: Entry) {
    const current = ++request.current;
    setEditing(false);
    if (entry.directory) {
      setPath(entry.path);
      return;
    }
    try {
      const result = await api<{
        name: string;
        text: string | null;
        reason?: string;
      }>(
        `/workspaces/${projectId}/file?path=${encodeURIComponent(entry.path)}${suffix}`,
      );
      if (current === request.current)
        setPreview({ ...result, path: entry.path });
    } catch (e) {
      setError(String(e));
    }
  }
  async function save() {
    if (!preview || !preview.editable || saving) return;
    const current = request.current;
    setSaving(true);
    setError("");
    try {
      const result = await api<NonNullable<typeof preview>>(`/workspaces/${projectId}/file`, {
        method: "PUT",
        body: JSON.stringify({ path: preview.path, text: draft, expected_version: preview.version }),
      });
      if (current === request.current) { setPreview(result); setEditing(false); }
    } catch (e) {
      if (current === request.current) setError(String(e));
    } finally { setSaving(false); }
  }
  return (
    <aside className="workspace-browser" aria-label="关联工作空间">
      {messageContext}
      <header>
        <strong>{data?.label ?? "工作空间"}</strong>
        <Button
          type="text"
          aria-label="刷新工作空间"
          icon={<ReloadOutlined />}
          onClick={() => refresh((v) => v + 1)}
        />
      </header>
      {data?.root && (
        <div className="workspace-actions">
          <Button
            type="link"
            icon={<CopyOutlined />}
            aria-label="复制路径"
            disabled={busy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(data.root);
                void messageApi.success("路径已复制");
              } catch {
                void messageApi.error("复制失败，请检查浏览器剪贴板权限后重试");
              }
            }}
          >
            复制路径
          </Button>
          <Button
            type="link"
            icon={<CodeOutlined />}
            aria-label="用 VS Code 打开"
            disabled={busy}
            href={`vscode://file${data.root.split("/").map(encodeURIComponent).join("/")}`}
            title="在本机 VS Code 中打开当前工作空间"
          >
            用 VS Code 打开
          </Button>
        </div>
      )}
      <nav>
        <Button type="text" onClick={() => setPath("")}>
          根目录
        </Button>
        <Button
          type="text"
          aria-label="上一级目录"
          disabled={!path}
          icon={<ArrowUpOutlined />}
          onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
        />
      </nav>
      {path && <div className="workspace-path">{path}</div>}
      {error && !preview && <Alert type="error" message={error} />}
      {busy ? (
        <Spin />
      ) : (
        <div className="workspace-files">
          {data?.entries?.map((entry) => (
            <button
              key={entry.path}
              aria-label={entry.name}
              onClick={() => void open(entry)}
              title={entry.name}
            >
              {entry.directory ? <FolderOutlined /> : <FileTextOutlined />}
              <span>{entry.name}</span>
            </button>
          ))}
          {data?.entries?.length === 0 && <p>此目录暂无文件</p>}
        </div>
      )}
      {preview && (
        <Drawer
          title={preview.name}
          placement="right"
          width="min(100vw, max(50vw, 480px))"
          open
          className="workspace-file-drawer"
          onClose={() => {
            request.current += 1;
            setPreview(undefined);
            setEditing(false);
          }}
        >
          {error && <Alert type="error" message={error} />}
          <div className="workspace-preview-actions">
          <a
            href={`/api/workspaces/${projectId}/file?path=${encodeURIComponent(preview.path)}${suffix}&download=true`}
          >
            下载文件
          </a>
          {preview.editable && !runId && !editing && (
            <Button onClick={() => { setDraft(preview.text ?? ""); setEditing(true); }}>编辑规则</Button>
          )}
          </div>
          {editing ? (
            <div>
              <Input.TextArea aria-label="规则内容" value={draft} onChange={(e) => setDraft(e.target.value)} autoSize={{ minRows: 10, maxRows: 30 }} />
              <Button loading={saving} onClick={() => void save()}>保存规则</Button>
              <Button disabled={saving} onClick={() => setEditing(false)}>取消</Button>
              <p>保存后用于新运行，已有运行继续使用原版本。</p>
            </div>
          ) : preview.text === null ? (
            <p>{preview.reason}</p>
          ) : (
            <pre className="workspace-file-content">{preview.text}</pre>
          )}
        </Drawer>
      )}
    </aside>
  );
}
