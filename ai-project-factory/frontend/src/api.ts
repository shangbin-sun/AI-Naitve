export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    let detail;
    try {
      detail = (await response.json()).detail;
    } catch {
      detail = response.status >= 500
        ? `服务暂时异常（HTTP ${response.status} · ${path}），请稍后重试`
        : `请求失败（HTTP ${response.status} · ${path}）`;
    }
    throw new ApiError(
      typeof detail === "string"
        ? detail
        : "内容格式不正确，请检查输入和工作流引用",
      response.status,
    );
  }
  return response.json();
}
