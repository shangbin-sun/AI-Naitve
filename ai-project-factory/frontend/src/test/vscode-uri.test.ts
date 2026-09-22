import { expect, it } from "vitest";
import { isAbsoluteLocalPath, toVsCodeFileUri } from "../vscodeUri";

it("accepts Windows absolute paths and builds a VS Code file URI", () => {
  expect(isAbsoluteLocalPath(String.raw`C:\Users\jocob\中文 空格\run`)).toBe(true);
  expect(toVsCodeFileUri(String.raw`C:\Users\jocob\中文 空格\run`)).toBe(
    "vscode://file/C:/Users/jocob/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC/run",
  );
});

it("keeps POSIX VS Code file URIs compatible", () => {
  expect(toVsCodeFileUri("/Users/test/run")).toBe("vscode://file/Users/test/run");
});
