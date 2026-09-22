const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

export function isAbsoluteLocalPath(path: string) {
  return path.startsWith("/") || path.startsWith("\\\\") || WINDOWS_DRIVE_PATH.test(path);
}

export function toVsCodeFileUri(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const encoded = normalized
    .split("/")
    .map((segment, index) => {
      const value = encodeURIComponent(segment);
      return index === 0 && /^[A-Za-z]%3A$/i.test(value)
        ? value.replace(/%3A$/i, ":")
        : value;
    })
    .join("/");
  return `vscode://file${normalized.startsWith("/") ? encoded : `/${encoded}`}`;
}
