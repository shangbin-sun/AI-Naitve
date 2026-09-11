# 员工能力加载约定

数据库是内容权威来源，目录为版本投影。所有模型员工入口使用 `employee_context.py`。

## 文件职责

- 平台 `instructions/organization.md`：组织及执行边界。
- 团队 `AGENTS.md`：团队协作规则；非空 `AGENTS.override.md` 优先。
- 员工 `AGENTS.md`：员工行为规则，同样支持 override。
- 员工 `profile.instructions`：岗位职责，投影为 `instructions.md`。旧 `instructions/role.md` 保留兼容，不作为第二份职责重复注入。
- 团队和员工 `.agents/skills/*/SKILL.md`：全部显式注入，校验 YAML name/description。配套脚本、参考文件保留在资源清单，按需访问，不自动执行。
- 聊天、任务输入、日志与产物不是长期能力指令。

## 入口与版本

员工聊天每轮取得最新快照，将统一能力正文注入新建或恢复的独立主会话。历史任务的快照标识单独提供，不能悄悄修改旧任务。

正式执行、重新验证使用启动时冻结的能力包；恢复使用原版本。节点 begin 返回完整 content，调度指令要求将其完整传入子员工，不能只传文件路径。此处能验证平台提供的正文，不将模型承诺视为已遵守。

旧版需求试运行、交付入口在创建评估时冻结能力，调用模型时注入同一正文。纯 Python 员工入口没有模型，保存能力包到工作目录及结果用于审计，不宣称模型加载。

能力包记录 employee_key、employee_version、snapshot_digest、规则和技能正文、每个文件的 SHA-256 及配套资源清单。必需规则为空或 Skill 元数据无效时拒绝加载。

## 临时目录与访问范围

当前兼容权限：独立员工主会话以本次 attempt 为 cwd，workspace-write 追加当前团队项目根目录为 writable_roots；正式执行与 Python Worker 同样允许当前团队项目目录读写。仅扩大实际权限，不改变组织规则中的目录分工、配置修改接口要求、冻结版本和临时目录约定。其他团队目录不加入写入授权。

每个 attempt 的 `.runtime/tmp` 和 `.runtime/cache` 独立创建，权限 0700。平台直接启动的进程配置 TMPDIR/TMP/TEMP/TMPPREFIX，以及 pip、uv、ruff、matplotlib、Python 字节码缓存路径。恢复时不清空，正式源码、产物和日志不作为临时文件删除。

原生子 Agent 由 Codex 调度，平台在派工包中传入员工 cwd 和环境变量并要求每次命令设置；这是指令约束，不能宣称已有逐员工 OS 沙箱强制隔离。父会话的运行目录权限仍可能被子会话继承。若需要对原生子 Agent 强制禁止写兄弟节点，应改为平台独立启动员工进程或由支持逐子会话权限的执行器承载。
