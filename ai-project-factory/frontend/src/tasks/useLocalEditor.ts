import { useState } from "react";
import type { OutputStep } from "./buildOutputChain";

type FileEntry = { step_id?: string; name?: string; folder: string; path: string; relative_path?: string };
export function useLocalEditor(base?: string) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  async function open(step: OutputStep, filename?: string, relativePath?: string) {
    if (!base || opening) return;
    setOpening(true);
    setError("");
    setUrl("");
    try {
      const response = await fetch(`${base}/${step.origin}/output-workspace`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "无法准备工作目录");
      let matches: FileEntry[] = data.files.filter((file: FileEntry) => file.step_id === step.id);
      if (relativePath !== undefined) {
        const folders = new Set(matches.map((file) => file.folder));
        matches = (data.directory_files ?? []).filter((file: FileEntry) => folders.has(file.folder) && file.relative_path === relativePath);
      } else if (filename !== undefined) {
        matches = matches.filter((file) => file.name === filename);
      }
      if (!matches.length) throw new Error("该环节未保存可编辑文件");
      const path = filename !== undefined || relativePath !== undefined ? matches[0].path : matches[0].folder;
      if (!path?.startsWith("/")) throw new Error("工作目录无效");
      const target = `vscode://file${path.split("/").map(encodeURIComponent).join("/")}`;
      setUrl(target);
      window.location.assign(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法打开本机 VS Code");
    } finally {
      setOpening(false);
    }
  }
  return { open, opening, error, url };
}
