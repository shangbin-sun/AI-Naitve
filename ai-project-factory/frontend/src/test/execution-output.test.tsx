import {expect,it,vi} from "vitest";
import {render,screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExecutionOutput, { executionSummary, documentSummary } from "../tasks/ExecutionOutput";
import {api} from "../api";
vi.mock("../api",()=>({api:vi.fn()}));
it("输出展示总结、文件用途和预览，打开操作绑定当前文件",async()=>{
 vi.mocked(api).mockResolvedValue({text:"需求内容预览"});
 render(<ExecutionOutput projectId="p" runId="r" root="/Users/test/run" status="completed" summary="已完成需求分解" files={[{path:"nodes/a/outputs/result.md",description:"需求清单与验收标准"}]}/>);
 expect(screen.getByText("已完成需求分解")).toBeVisible();
 expect(screen.queryByText("需求内容预览")).toBeNull();
 expect(screen.queryByText("输出预览")).toBeNull();
 expect(screen.getByText("需求清单与验收标准")).toBeVisible();
 expect(screen.queryByText("nodes/a/outputs/result.md")).toBeNull();
 expect(screen.getByRole("link",{name:"VS Code 打开"})).toHaveAttribute("href","vscode://file/Users/test/run");
 await userEvent.click(screen.getByRole("button",{name:"本地打开"}));
 expect(api).toHaveBeenCalledWith("/workspaces/p/agent-runs/r/open-local",{method:"POST",body:JSON.stringify({path:"nodes/a/outputs/result.md"})});
 await userEvent.click(screen.getByRole("button",{name:/result.md/}));
 expect(await screen.findByText("需求内容预览")).toBeVisible();
});

it("总结不重复列文件，文档摘要来自内容",()=>{
 const files=[{path:"nodes/a/outputs/result.md"}];
 expect(executionSummary("执行完成。\n\n产物：[result.md](nodes/a/outputs/result.md)\n\n覆盖新增与查询。",files,"/tmp/run")).toBe("执行完成。\n\n覆盖新增与查询。");
 expect(documentSummary("# 待办需求规格\n## 1. 新增待办\n## 2. 完成状态\n")).toBe("待办需求规格，涵盖新增待办、完成状态。");
});

it("员工打开独立工作目录，文件打开仍按任务根目录解析",async()=>{
 vi.mocked(api).mockResolvedValue({text:"成果"});
 render(<ExecutionOutput projectId="p" runId="r" root="/run" editorRoot="/run/nodes/analyst/attempts/one" status="completed" files={[{path:"nodes/analyst/attempts/one/outputs/result.md",description:"结果"}]}/>);
 expect(screen.getByRole("link",{name:"VS Code 打开"})).toHaveAttribute("href","vscode://file/run/nodes/analyst/attempts/one");
 await userEvent.click(screen.getByRole("button",{name:/result.md/}));
 expect(await screen.findByText("成果")).toBeVisible();
 expect(screen.getAllByRole("link",{name:/VS Code 打开/}).some(link=>link.getAttribute("href")==="vscode://file/run/nodes/analyst/attempts/one/outputs/result.md")).toBe(true);
});
