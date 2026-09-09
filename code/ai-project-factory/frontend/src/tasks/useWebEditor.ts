import { useState } from "react";
import type { OutputStep } from "./buildOutputChain";

export function useWebEditor(base?: string) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  async function open(step: OutputStep, filename?: string, relativePath?: string) {
    if (!base || opening) return;
    // Open synchronously with the click so the browser does not block an async popup.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    setOpening(true);
    setError("");
    setUrl("");
    try {
      const response = await fetch(`${base}/${step.origin}/web-editor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_id: step.id, filename: filename ?? null, ...(relativePath ? {relative_path: relativePath} : {}) }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : "无法打开网页版 VS Code",
        );
      const target = new URL(data.url);
      if (!["http:", "https:"].includes(target.protocol))
        throw new Error("编辑器地址无效");
      setUrl(target.href);
      if (tab && !tab.closed) tab.location.href = target.href;
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : "编辑器连接失败");
    } finally {
      setOpening(false);
    }
  }
  return { open, opening, error, url };
}
