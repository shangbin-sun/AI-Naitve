import { useEffect, useState } from "react";
import { Alert, Button } from "antd";
import { FileTextOutlined } from "@ant-design/icons";
import type { OutputStep } from "./buildOutputChain";

type Entry = {relative_path: string; folder: string; size: number; kind: string; modified?: boolean; sha256: string};
type Manifest = {files: {step_id: string; folder: string}[]; directory_files: Entry[]};
export default function EmployeeDirectoryFiles({steps, base, open, busy}: {
  steps: OutputStep[]; base: string; open: (step: OutputStep, filename?: string, relativePath?: string) => Promise<void>; busy: boolean;
}) {
  const [rows, setRows] = useState<(Entry & {step: OutputStep})[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Polling the parent must not rematerialize folders on every React render.
  const identity = steps.map(s => `${s.origin}/${s.id}`).join('|');
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setRows([]);
    const requestedSteps = [...steps];
    async function load() {
      const all: (Entry & {step: OutputStep})[] = [];
      for (const origin of new Set(requestedSteps.map(s => s.origin))) {
        const response = await fetch(`${base}/${origin}/output-workspace`, {method:'POST'});
        if (!response.ok) throw new Error('目录清单读取失败，请重试');
        const manifest = await response.json() as Manifest;
        const inRun = requestedSteps.filter(s => s.origin === origin);
        const folders = new Map<string, OutputStep>();
        for (const step of inRun) {
          const file = manifest.files.find(f => f.step_id === step.id);
          if (file) folders.set(file.folder, step);
        }
        for (const file of manifest.directory_files ?? []) {
          const step = folders.get(file.folder);
          if (step) all.push({...file, step});
        }
      }
      all.sort((a,b) => Number(b.kind === 'editable_copy') - Number(a.kind === 'editable_copy') || a.relative_path.localeCompare(b.relative_path));
      if (!cancelled) setRows(all);
    }
    load().catch(e => {if (!cancelled) setError(e.message);}).finally(() => {if (!cancelled) setLoading(false);});
    return () => {cancelled = true;};
  // The immutable step identifiers represent this directory selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, identity, refresh]);
  return <div>
    <div className="employee-attachment-caption">服务器文件 · {loading ? '读取中…' : rows.length}<Button type="link" size="small" onClick={() => setRefresh(n=>n+1)} disabled={loading}>刷新目录</Button></div>
    {error && <Alert type="error" message={error} />}
    <ul className="employee-attachment-files">{(expanded ? rows : rows.slice(0,3)).map(row => <li key={`${row.step.origin}/${row.relative_path}`}>
      <button className="employee-attachment-link" type="button" title={`${row.relative_path}\n来源运行 ${row.step.origin}\nSHA-256 ${row.sha256}`} disabled={busy} onClick={() => open(row.step, undefined, row.relative_path)}>
        <span className="employee-attachment-icon"><FileTextOutlined /></span><span className="employee-attachment-name">{row.relative_path}</span>
      </button>
      <div className="employee-attachment-meta">{row.kind === 'editable_copy' ? `可编辑副本${row.modified ? ' · 已修改' : ''}` : row.kind === 'run_archive' ? '运行归档（平台整理）' : '新增工作区文件'} · {row.size.toLocaleString()} B · {row.step.origin.slice(0,8)}</div>
    </li>)}</ul>
    {!loading && !error && rows.length === 0 && <p>暂无已归档文件</p>}
    {rows.length > 0 && <button className="employee-attachment-all" aria-expanded={expanded} onClick={() => setExpanded(v=>!v)}>{expanded ? '收起文件' : `查看全部文件（${rows.length}）`}</button>}
  </div>;
}
