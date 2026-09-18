import { expect, it, vi } from "vitest";
import { requestId } from "../requestId";
it("HTTP 环境缺少 randomUUID 时生成规范且不重复的请求标识", () => {
  const crypto = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  try {
    const ids = Array.from({ length: 100 }, () => requestId());
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  } finally { vi.unstubAllGlobals(); }
});
