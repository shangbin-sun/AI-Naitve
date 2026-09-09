import { useEffect, useState } from "react";

export function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟 ${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}小时 ${minutes % 60}分钟 ${seconds % 60}秒`;
}

export default function ProcessingTime({
  startedAt,
  finishedAt,
  running,
}: {
  startedAt?: string;
  finishedAt?: string | null;
  running: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  const start = Date.parse(startedAt ?? "");
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    (!running && !finishedAt)
  )
    return null;
  return (
    <div className="factory-chat-elapsed" aria-label="本次处理耗时">
      {running && !finishedAt ? "已处理" : "用时"} {formatElapsed(end - start)}
    </div>
  );
}
