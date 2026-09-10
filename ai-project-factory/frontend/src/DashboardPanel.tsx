import { useEffect, useState } from "react";
import { Alert, Button, Empty, Select, Space, Spin, Tag } from "antd";
import { api } from "./api";

type Config = {
  dashboard: { title: string; version: number } | null;
  versions: { version: number; title: string }[];
};
export default function DashboardPanel({
  projectId,
  onCustomize,
}: {
  projectId: string;
  onCustomize: (text: string) => void;
}) {
  const [config, setConfig] = useState<Config>();
  const [runs, setRuns] = useState<{ id: string; title: string }[]>([]);
  const [selection, setSelection] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<{
    title: string;
    version: number;
    label: string;
  }>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const base = `/workspaces/${projectId}/dashboard`;
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<Config>(base),
      api<typeof runs>(`/workspaces/${projectId}/agent-runs`),
    ])
      .then(([value, history]) => {
        if (alive) {
          setConfig(value);
          setRuns(history);
          setSelection(
            (previous) =>
              previous ||
              (value.dashboard ? `version:${value.dashboard.version}` : ""),
          );
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [base, projectId, refresh]);
  const query = selection.startsWith("run:")
    ? `run_id=${encodeURIComponent(selection.slice(4))}`
    : `version=${encodeURIComponent(selection.slice(8))}`;
  useEffect(() => {
    if (!selection) return;
    let alive = true;
    setBusy(true);
    setPreview(undefined);
    setError("");
    api<{ title: string; version: number; label: string }>(
      `${base}/preview?${query}`,
    )
      .then((value) => {
        if (alive) setPreview(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [base, selection, query, refresh]);
  return (
    <section style={{ padding: 24 }} aria-label="AI 团队看板">
      <Space wrap style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          onClick={() =>
            onCustomize(
              "请为当前 AI 团队" +
                (config?.dashboard ? "调整" : "生成") +
                "自动编程看板。先调用 get_dashboard，按团队职责和已有运行数据设计页面，通过 save_dashboard 保存独立版本；不要修改现有规则、技能、员工文件或历史运行。页面读取 window.DASHBOARD_DATA，样例与真实运行数据明确区分。",
            )
          }
        >
          {config?.dashboard ? "通过对话调整看板" : "生成团队看板"}
        </Button>
        <Button onClick={() => setRefresh((v) => v + 1)}>刷新</Button>
        {config?.dashboard && (
          <Select
            aria-label="看板数据来源"
            value={selection}
            onChange={setSelection}
            style={{ minWidth: 280 }}
            options={[
              ...(config.versions ?? []).map((v) => ({
                value: `version:${v.version}`,
                label: `配置预览 · v${v.version} · ${v.title}`,
              })),
              ...runs.map((r) => ({
                value: `run:${r.id}`,
                label: `运行 · ${r.title} · ${r.id.slice(0, 16)}`,
              })),
            ]}
          />
        )}
      </Space>
      {error && <Alert type="warning" message={error} />}
      {!config ? (
        <Spin />
      ) : !config.dashboard ? (
        <Empty description="通过团队对话生成专属看板，页面和配置将独立保存" />
      ) : busy ? (
        <Spin />
      ) : (
        preview && (
          <>
            <p>
              <strong>{preview.title}</strong> <Tag>v{preview.version}</Tag>
              <Tag>{preview.label}</Tag>
            </p>
            <iframe
              key={`${selection}-${refresh}`}
              title="团队看板预览"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              src={`/api${base}/frame?${query}`}
              style={{
                width: "100%",
                height: "68vh",
                border: "1px solid #e3e8f2",
                borderRadius: 12,
                background: "#fff",
              }}
            />
          </>
        )
      )}
    </section>
  );
}
